/**
 * Host half of `dsh-session-remove`.
 *
 * Three capabilities, all of them things the shipped Harness leaves to
 * out-of-band maintenance:
 *
 * 1. **Stop a Session's work.** `ctx.workspaceRegistry.stopSessionActivity()`
 *    runs the registry's `workspace/session-stop` admission, which four
 *    providers answer — `dsh-agent` cancels a running turn the way the user's
 *    own stop does, `dsh-subagent` cancels subagents, `dsh-jobs` kills
 *    background jobs, `dsh-schedule` stops that Session's reminders. It is the
 *    same stop archive uses, so it also discards queued input (no `keepInbox`).
 *
 * 2. **Delete a stored Session.** The persistence seam documents "No deletion
 *    or retention interface — pruning stored sessions is out-of-band backend
 *    maintenance" and the workspace registry calls Session deletion "a
 *    separate, absent capability". Removing one means undoing every place that
 *    knows about it: the Session's log directory, its `session_projcache`
 *    checkpoint row, its archived/pinned/accounting slots, and the page (via
 *    `api-session/removed`, so the row disappears without a reload). A
 *    conversation's subagent Sessions are separate stored Sessions whose logs
 *    sit beside the parent's and become unreachable once the parent is gone, so
 *    they are removed too (recursively; forks are independent and kept). The
 *    search index is mounted in memory here and reconciles against the
 *    persistence listing, so it needs no help. Files the conversation left
 *    outside its session directory — workspace files it created and
 *    content-addressed attachments only it referenced — are reported by the
 *    `.inspect` route and removed only on the user's explicit choice.
 *
 * 3. **Notice a newer release.** The plugin manager ships no update mechanism
 *    ("upgrading requires uninstalling and reinstalling"), so this half asks
 *    the registry for its own latest version. In `notify` mode it only
 *    reports; installing happens when the page asks, through
 *    `ctx.pluginManager.installBundle()`. Replacing a package needs a restart
 *    to load a fresh Host module generation, so "installed" and "live" stay
 *    separate facts in the result.
 *
 * A Session still held by this process — open in the UI, or owned by a running
 * Agent — is refused for deletion: `ctx.sessions` only hands out the detacher
 * to whoever entered the Session, and a flushed write handle would recreate
 * the log we just removed. Stop is still offered, and the refusal names exactly
 * what to do next.
 *
 * The Client half is `client.js`.
 */

import { appendFile, lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

/** Session identities the page may name. Real ids are `session-<uuid>` or a bare `<uuid>`. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/** Host routes owned by this plugin; the Client half fetches them from the same origin. */
const DELETE_PATH = "/api/session-delete.delete";
const STOP_PATH = "/api/session-delete.stop";
const UPDATE_STATE_PATH = "/api/session-delete.update-state";
const UPDATE_INSTALL_PATH = "/api/session-delete.install-update";
const CLIENT_READY_PATH = "/api/session-delete.client-ready";
const STATUS_PATH = "/api/session-delete.status";
const INSPECT_PATH = "/api/session-delete.inspect";

/** This package's own manifest, read once, so no name or version is spelled twice. */
const OWN = readOwnManifest();

/** Marks the Host build in the activation line, so a log can tell generations apart. */
const BUILD = `r5-unified@${OWN.version}`;

/** Bound on the in-memory operation history served by the status route. */
const HISTORY_LIMIT = 20;

/** Upper bound on how long one delete waits for stopped work to clear. */
const STOP_WAIT_MS = 10_000;

/** Defaults for the update check; every one is overridable from the row config. */
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_REGISTRY = "https://registry.npmjs.org/";
const UPDATE_FALLBACK_REGISTRY = "https://registry.npmmirror.com/";
const UPDATE_TIMEOUT_MS = 10_000;

/** How long a delete waits for the Agent and every work family to clear after a stop request. */
const STOP_SETTLE_TIMEOUT_MS = 10_000;

/** Bound on one workspace walk, so a huge project never stalls a deletion. */
const WORKSPACE_SCAN_LIMIT = 20_000;

/** Tolerance added before a session's creation time when attributing a workspace entry to it. */
const WORKSPACE_BIRTH_TOLERANCE_MS = 2_000;

/** How many candidate paths the inspect route reports back for the dialog. */
const SESSION_FILE_SAMPLE_LIMIT = 5;

/** Services without which the Host half cannot work. */
export const inject = ["connection", "sessionPersistence", "workspaceRegistry"];

/**
 * Mount the Host half: exact Fetch routes inside the Connection authentication
 * fence, owned by this plugin's fiber so unloading removes them.
 * @param ctx - Host context carrying Connection, persistence, and the registry.
 * @param config - optional row config; see the README for every field.
 */
export function apply(ctx, config) {
  const state = {
    ctx,
    logPath: resolveLogPath(config),
    history: [],
    stopWaitMs: Number.isFinite(config?.stopWaitMs) ? Math.max(500, config.stopWaitMs) : STOP_WAIT_MS,
    /* Subagent Sessions are separate stored Sessions whose logs sit in the same
       project directory. Once their parent is gone they are unreachable from the
       UI, so deleting the conversation has to take them with it. */
    deleteSubagentSessions: config?.deleteSubagentSessions !== false,
    /* Files the conversation left outside its session directory: agent-written
       workspace files and content-addressed attachments. Dangerous to delete
       blind, so `confirm` (the default) offers it in the dialog, `always` does
       it on every delete, and `off` keeps them. */
    sessionFilesMode: resolveSessionFilesMode(config?.deleteSessionFiles),
    update: {
      mode: config?.updateMode === "off" ? "off" : "notify",
      registry: typeof config?.updateRegistry === "string" ? config.updateRegistry : UPDATE_REGISTRY,
      fallbackRegistry: typeof config?.updateFallbackRegistry === "string" ? config.updateFallbackRegistry : UPDATE_FALLBACK_REGISTRY,
      intervalMs: Number.isFinite(config?.updateIntervalMs) ? Math.max(60_000, config.updateIntervalMs) : UPDATE_INTERVAL_MS,
      /* The development package is `@local/...` and never published; this points
         the check at the published name instead. */
      configuredName: typeof config?.updatePackageName === "string" ? config.updatePackageName : undefined,
      name: undefined,
      current: undefined,
      latest: undefined,
      available: false,
      checkedAt: undefined,
      error: undefined,
      install: { running: false, application: undefined, version: undefined, error: undefined, at: undefined }
    }
  };
  const routes = [
    [DELETE_PATH, ["POST"], (request) => handleDelete(ctx, state, request)],
    [INSPECT_PATH, ["POST"], (request) => handleInspect(ctx, state, request)],
    [STOP_PATH, ["POST"], (request) => handleStop(ctx, state, request)],
    [UPDATE_STATE_PATH, ["GET"], () => Promise.resolve(jsonResponse(updateState(state)))],
    [UPDATE_INSTALL_PATH, ["POST"], (request) => handleUpdateInstall(ctx, state, request)],
    [CLIENT_READY_PATH, ["POST"], (request) => handleClientReady(state, request)],
    [STATUS_PATH, ["GET"], () => Promise.resolve(jsonResponse({
      ok: true,
      plugin: OWN.name,
      routes: routes.map(([path]) => path),
      logPath: state.logPath ?? null,
      update: updateState(state),
      history: state.history
    }))]
  ];
  for (const [path, methods, handler] of routes) {
    ctx.connection.fetch.register({
      path,
      methods,
      requestBody: "buffered",
      fetch: (request) => guard(handler, request, state)
    });
  }
  record(state, `host half active (build ${BUILD}, ${routes.length} routes, update mode ${state.update.mode})`);
  void startUpdateChecks(ctx, state);
}

/* ------------------------------------------------------------------ stop */

/** Stop one Session's running turn, subagents, background jobs, and reminders. */
async function handleStop(ctx, state, request) {
  const body = await readBody(request);
  if (body === undefined) return jsonResponse({ ok: false, code: "invalid-body", message: "请求体不是合法 JSON。" }, 400);
  const sessionId = body.sessionId;
  if (!validSessionId(sessionId)) return jsonResponse({ ok: false, code: "invalid-session-id", message: "会话标识不合法。" }, 400);
  try {
    const activity = await sessionActivity(ctx, sessionId);
    if (activity.length === 0) {
      record(state, `stop ${sessionId}: nothing running`);
      return jsonResponse({ ok: true, sessionId, stopped: [], idle: true });
    }
    await stopSessionWork(ctx, sessionId);
    const remaining = await waitForWorkToClear(ctx, sessionId, state.stopWaitMs);
    const settled = remaining.length === 0;
    const kinds = activityKinds(activity);
    record(state, `stop ${sessionId}: asked ${kinds.join(", ")} (settled: ${settled})`);
    return jsonResponse({ ok: true, sessionId, stopped: kinds, idle: false, settled });
  } catch (error) {
    record(state, `stop ${sessionId} failed: ${messageOf(error)}`);
    return jsonResponse({ ok: false, code: "stop-failed", message: `停止失败：${messageOf(error)}` }, 500);
  }
}

/** The activity families as plain strings. */
function activityKinds(activity) {
  return (Array.isArray(activity) ? activity : [])
    .map((entry) => entry?.kind)
    .filter((kind) => typeof kind === "string");
}

/**
 * Remove one Session this process still holds from the live store.
 * @param ctx - Host context.
 * @param sessionId - the Session to release.
 * @returns whether the store accepted the release.
 */
function releaseHeldSession(ctx, sessionId) {
  const store = ctx.get("sessions");
  const entry = store?.store?.get?.(sessionId);
  if (entry === undefined || typeof store.detachEntered !== "function") return false;
  store.detachEntered(entry);
  return true;
}

/** The registry's archive admission, asked directly: same stop the archive dialog performs. */
function stopSessionWork(ctx, sessionId) {
  return ctx.workspaceRegistry.stopSessionActivity(sessionId);
}

/** The activity families the registry's admission reports for one Session. */
async function sessionActivity(ctx, sessionId) {
  const activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
  return Array.isArray(activity) ? activity : [];
}

/**
 * Wait until the Agent is no longer running and every work family has cleared.
 *
 * The stop admission issues its cancellations without awaiting settlement, and
 * a killed background job keeps being reported for a moment while its process
 * is reaped — so a single immediate re-read would refuse a deletion that is
 * about to become possible.
 *
 * @param ctx - Host context.
 * @param sessionId - the Session whose work was just stopped.
 * @param timeoutMs - upper bound on the wait.
 * @returns the families still reporting work when the wait ended (empty when clear).
 */
async function waitForWorkToClear(ctx, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const agent = ctx.get("agents")?.get(sessionId);
    const running = agent !== undefined && agent.status === "running";
    const activity = await sessionActivity(ctx, sessionId);
    if (!running && activity.length === 0) return [];
    if (Date.now() >= deadline) return activity.length === 0 ? [{ kind: "turn" }] : activity;
    await delay(250);
  }
}

/* ---------------------------------------------------------------- delete */

/** One deletion request from the page. */
async function handleDelete(ctx, state, request) {
  const body = await readBody(request);
  if (body === undefined) return jsonResponse({ ok: false, code: "invalid-body", message: "请求体不是合法 JSON。" }, 400);
  const sessionId = body.sessionId;
  if (!validSessionId(sessionId)) return jsonResponse({ ok: false, code: "invalid-session-id", message: "会话标识不合法。" }, 400);
  try {
    const outcome = await deleteSession(ctx, state, sessionId, {
      stopActivity: body.stopActivity === true,
      deleteFiles: body.deleteFiles === true,
      deleteSubagentSessions: state.deleteSubagentSessions && body.deleteSubagentSessions !== false
    });
    const subagents = Array.isArray(outcome.subagentSessions) ? outcome.subagentSessions.length : 0;
    const sessionFiles = outcome.sessionFiles ?? { workspaceFiles: [], workspaceDirs: [], attachments: [] };
    const leftover = sessionFiles.workspaceFiles.length + sessionFiles.workspaceDirs.length + sessionFiles.attachments.length;
    record(state, outcome.ok
      ? `deleted ${sessionId}${subagents > 0 ? ` (+${subagents} subagent session${subagents === 1 ? "" : "s"})` : ""}${leftover > 0 ? ` (+${leftover} session file${leftover === 1 ? "" : "s"})` : ""} (${outcome.removed.join(", ")})`
      : `refused ${sessionId}: ${outcome.code}`);
    return jsonResponse(outcome, outcome.ok ? 200 : 409);
  } catch (error) {
    record(state, `delete ${sessionId} failed: ${messageOf(error)}`);
    return jsonResponse({ ok: false, code: "delete-failed", message: `删除失败：${messageOf(error)}` }, 500);
  }
}

/**
 * Report what deleting one Session could also remove outside its session
 * directory: agent-written workspace files and content-addressed attachments.
 * The dialog uses the counts to offer that cleanup; nothing here mutates state.
 *
 * @param ctx - Host context.
 * @param state - Plugin state used for the debug log.
 * @param request - the page's request carrying `sessionId`.
 * @returns `{ ok: true, mode, files, attachments }` or a refusal.
 */
async function handleInspect(ctx, state, request) {
  const body = await readBody(request);
  if (body === undefined) return jsonResponse({ ok: false, code: "invalid-body", message: "请求体不是合法 JSON。" }, 400);
  const sessionId = body.sessionId;
  if (!validSessionId(sessionId)) return jsonResponse({ ok: false, code: "invalid-session-id", message: "会话标识不合法。" }, 400);
  try {
    const empty = {
      ok: true,
      sessionId,
      mode: state.sessionFilesMode,
      files: { count: 0, bytes: 0, sample: [] },
      attachments: { count: 0 }
    };
    if (state.sessionFilesMode === "off") return jsonResponse(empty);
    const snapshot = await ctx.sessionPersistence.stat(sessionId);
    const header = snapshot?.header;
    if (header === undefined) return jsonResponse({ ok: false, code: "session-not-found", message: "找不到这个会话，可能已经被删除。" }, 409);
    const excluded = [];
    if (typeof ctx.sessionPersistence.locate === "function") {
      const location = ctx.sessionPersistence.locate({ id: sessionId, cwd: header.cwd });
      if (typeof location?.path === "string" && location.path.length > 0) excluded.push(dirname(location.path));
    }
    const workspace = await scanSessionWorkspace(header, excluded);
    const attachmentRefs = await collectSessionAttachmentRefs(ctx, state, sessionId);
    return jsonResponse({
      ...empty,
      files: {
        count: workspace.files.length,
        bytes: workspace.files.reduce((sum, file) => sum + file.bytes, 0),
        sample: workspace.files.slice(0, SESSION_FILE_SAMPLE_LIMIT).map((file) => file.rel)
      },
      attachments: { count: attachmentRefs.length }
    });
  } catch (error) {
    record(state, `inspect ${sessionId} failed: ${messageOf(error)}`);
    return jsonResponse({ ok: false, code: "inspect-failed", message: `检查失败：${messageOf(error)}` }, 500);
  }
}

/**
 * Delete one stored Session and its subagent Sessions, or refuse with a reason
 * the dialog can show.
 *
 * A conversation's subagent Sessions are separate stored Sessions: their
 * directories are siblings of the parent's under the same project directory,
 * and once the parent is gone the sidebar, search and subagent addressing all
 * refuse to reach them. Deleting the parent without them therefore leaves logs
 * and projection-cache rows on disk that nothing else will ever clean up.
 *
 * @param ctx - Host context.
 * @param state - Plugin state used for the debug log.
 * @param sessionId - The Session to remove.
 * @param options - `stopActivity: true` first asks the registry to stop the Session's work;
 *   `deleteSubagentSessions: false` keeps its subagent Sessions;
 *   `deleteFiles: true` also removes agent-written workspace files and orphaned attachments.
 * @returns `{ ok: true, sessionId, removed, stopped, subagentSessions, sessionFiles, warnings }` or `{ ok: false, code, message }`.
 */
async function deleteSession(ctx, state, sessionId, options = {}) {
  const agentRunning = (id) => ctx.get("agents")?.get(id)?.status === "running";
  const liveSession = (id) => ctx.get("sessions")?.get(id) !== undefined;

  const activity = await sessionActivity(ctx, sessionId);
  const busy = activity.length > 0 || agentRunning(sessionId);
  if (busy && options.stopActivity !== true) {
    const kinds = activityKinds(activity);
    return refusal("session-active", `该会话仍有正在进行的工作（${kinds.join("、") || "运行中的回合"}）。可以先停止它再删除。`, {
      activity: kinds
    });
  }

  let stopped = false;
  let released = false;
  const releasedIds = [];

  /* Release FIRST on the stop path. A Session still in the store can be woken
     by its own stop — the Agent wakes to consume the killed job's result and
     can start fresh work — and anything started that way would outlive the
     deletion as an orphan. Taking it out of the store makes that impossible;
     the stop below still cancels whatever is already running.
     The registry's archive flow relies on the Session's own owner to release
     it, and the seam offers no supported third-party release, so the store's
     `detachEntered` — the public method, reached through the entry it expects
     — is attempted, and the refusal stands when it is unavailable. */
  if (busy && liveSession(sessionId)) {
    released = releaseHeldSession(ctx, sessionId);
    if (!released) {
      return refusal("session-held", "该会话当前已被打开，无法安全删除。请先切换到别的会话，再回来删除它。");
    }
    record(state, `released ${sessionId} from the live store`);
  }

  if (busy) {
    await stopSessionWork(ctx, sessionId);
    stopped = true;
    /* The cancellations are issued without awaiting settlement, and a killed
       background job keeps reporting for a moment, so wait for the work to
       actually clear instead of refusing on the first re-read. */
    const remaining = await waitForWorkToClear(ctx, sessionId, state.stopWaitMs);
    record(state, remaining.length === 0
      ? `stopped work for ${sessionId} before deleting (${activityKinds(activity).join(", ") || "turn"})`
      : `stop for ${sessionId} did not settle: ${activityKinds(remaining).join(", ")}`);
    if (remaining.length > 0) {
      const kinds = activityKinds(remaining);
      return refusal("session-stopping", `已请求停止（${kinds.join("、")}）但工作仍在收尾，请稍候再试。`, {
        activity: kinds
      });
    }
  }

  /* A plain delete of a held Session still has to release it before its files
     go: an open write handle flushes the log we are about to remove back into
     existence. */
  if (!released && liveSession(sessionId)) {
    released = releaseHeldSession(ctx, sessionId);
    if (!released) {
      return refusal("session-held", stopped
        ? "它的运行工作已停止，但该会话仍被界面打开着，现在删除不安全。请先切换到别的会话，再回来删除。"
        : "该会话当前已被打开，无法安全删除。请先切换到别的会话，再回来删除它。");
    }
    record(state, `released ${sessionId} from the live store`);
  }

  /* Subagent Sessions are part of the conversation's local data. Collect them
     before any file is removed and settle them the same way as the parent: a
     still-running child would keep writing into the directory we removed. */
  let descendants = [];
  if (options.deleteSubagentSessions !== false) {
    try {
      descendants = await subagentDescendants(ctx, sessionId);
    } catch (error) {
      record(state, `listing sessions for subagent cleanup under ${sessionId} failed: ${messageOf(error)}`);
      return refusal("subagent-scan-failed", "无法枚举该会话的子代理会话；为避免只删掉一半数据，本次没有删除。请稍后重试。");
    }
  }

  if (descendants.length > 0) {
    record(state, `found ${descendants.length} subagent session(s) under ${sessionId}`);
    for (const subagent of descendants) {
      const subagentId = subagent.id;
      const subagentActivity = await sessionActivity(ctx, subagentId);
      if (subagentActivity.length > 0 || agentRunning(subagentId)) {
        await stopSessionWork(ctx, subagentId);
        const remaining = await waitForWorkToClear(ctx, subagentId, state.stopWaitMs);
        if (remaining.length > 0) {
          const kinds = activityKinds(remaining);
          return refusal("subagent-active", `它的子代理会话「${subagentId}」仍在收尾（${kinds.join("、") || "运行中的回合"}），请稍候再试。`, {
            activity: kinds
          });
        }
        stopped = true;
        record(state, `stopped work for subagent ${subagentId}`);
      }
      if (liveSession(subagentId)) {
        if (!releaseHeldSession(ctx, subagentId)) {
          return refusal("subagent-held", `它的子代理会话「${subagentId}」仍被进程持有，无法安全删除。请稍候再试。`);
        }
        releasedIds.push(subagentId);
        record(state, `released subagent ${subagentId} from the live store`);
      }
    }
  }

  if (released) releasedIds.unshift(sessionId);
  if (releasedIds.length > 0) {
    /* Disposal drains and closes the write handles; wait for that barrier so
       nothing rewrites the logs after the next step removes them. A failed
       barrier means a live handle may still materialize a removed log, so it
       refuses instead of deleting anyway. */
    try {
      await ctx.sessionPersistence.flush();
    } catch (error) {
      record(state, `flush before deleting ${sessionId} failed: ${messageOf(error)}`);
      return refusal("flush-failed", "会话关闭时未能把缓冲数据写入磁盘；为避免删除后被回写，本次没有删除。请稍后重试。");
    }
  }

  const snapshot = await ctx.sessionPersistence.stat(sessionId);
  const header = snapshot?.header;
  if (header === undefined) {
    return refusal("session-not-found", "找不到这个会话，可能已经被删除。");
  }

  /* Attachment references live inside the session log, so they have to be read
     before the log directory goes away. */
  const deleteFiles = options.deleteFiles === true && state.sessionFilesMode !== "off";
  const attachmentRefs = deleteFiles ? await collectSessionAttachmentRefs(ctx, state, sessionId) : [];

  const removed = [];
  const warnings = [];

  /* Artifact first: if anything later fails, the user's intent (the data is
     gone) has already been carried out and no writer can resurrect it. */
  const targetRemoval = await removeSessionArtifacts(ctx, state, sessionId, header);
  if (targetRemoval.refusal !== undefined) return targetRemoval.refusal;
  removed.push(...targetRemoval.removed);
  removed.push(...await forgetSessionRecords(ctx, state, sessionId));

  /* Subagent artifacts go last: the parent has already been removed, so a
     failure here leaves data the user can no longer reach — report it instead
     of failing a deletion whose main intent already succeeded. */
  for (const subagent of descendants) {
    const subagentId = subagent.id;
    try {
      const subagentRemoval = await removeSessionArtifacts(ctx, state, subagentId, subagent);
      if (subagentRemoval.refusal !== undefined) {
        warnings.push({ sessionId: subagentId, message: subagentRemoval.refusal.message });
        record(state, `deleting subagent ${subagentId} failed: ${subagentRemoval.refusal.code}`);
        continue;
      }
      removed.push(...subagentRemoval.removed);
      removed.push(...await forgetSessionRecords(ctx, state, subagentId));
    } catch (error) {
      warnings.push({ sessionId: subagentId, message: messageOf(error) });
      record(state, `deleting subagent ${subagentId} failed: ${messageOf(error)}`);
    }
  }
  /* Workspace files and attachments live outside the session directory, so
     only the user's explicit choice removes them. The workspace walk runs
     after the session directories are gone, so a session log can never be
     mistaken for an agent-written file. */
  const sessionFiles = { workspaceFiles: [], workspaceDirs: [], attachments: [] };
  if (deleteFiles) {
    const workspace = await removeSessionWorkspaceFiles(ctx, state, header, warnings);
    removed.push(...workspace.removed);
    sessionFiles.workspaceFiles = workspace.files;
    sessionFiles.workspaceDirs = workspace.dirs;
    const deletedIds = new Set([sessionId, ...descendants.map((subagent) => subagent.id)]);
    const attachments = await removeOrphanAttachments(ctx, state, attachmentRefs, deletedIds, warnings);
    removed.push(...attachments.removed);
    sessionFiles.attachments = attachments.files;
    record(state, `session files for ${sessionId}: ${workspace.files.length} workspace file(s), ${workspace.dirs.length} dir(s), ${attachments.files.length} attachment(s)`);
  }

  if (warnings.length > 0) {
    record(state, `deleted ${sessionId} with ${warnings.length} cleanup warning(s): ${warnings.map((warning) => warning.sessionId ?? "session").join(", ")}`);
  }

  return {
    ok: true,
    sessionId,
    removed,
    stopped,
    subagentSessions: descendants.map((subagent) => subagent.id),
    sessionFiles,
    warnings
  };
}

/**
 * Every stored Session below one parent whose header marks it as a subagent.
 *
 * Forks also carry `parentSession`, but they are independent conversations and
 * must survive their parent; only `origin: "subagent"` Sessions are derived
 * data. Walk parent links transitively so nested subagents of subagents go too.
 *
 * @param ctx - Host context.
 * @param sessionId - the conversation being deleted.
 * @returns the descendant headers, parents before children.
 * @throws when the persistence listing cannot be read; the caller refuses
 *   rather than deleting the parent while leaving unknown children behind.
 */
async function subagentDescendants(ctx, sessionId) {
  const persistence = ctx.sessionPersistence;
  if (typeof persistence?.list !== "function") {
    throw new Error("sessionPersistence.list is unavailable");
  }
  const snapshots = await persistence.list();
  const headers = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const header = snapshot?.header;
    if (header !== undefined && typeof header.id === "string") headers.set(header.id, header);
  }
  const childrenByParent = new Map();
  for (const header of headers.values()) {
    if (header.origin !== "subagent" || typeof header.parentSession !== "string") continue;
    const siblings = childrenByParent.get(header.parentSession);
    if (siblings === undefined) childrenByParent.set(header.parentSession, [header]);
    else siblings.push(header);
  }
  const descendants = [];
  const seen = new Set([sessionId]);
  const queue = [sessionId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

/**
 * Remove one Session's log directory and projection-cache row.
 *
 * The log path comes from the persistence backend's own `locate`, and the
 * directory name must be exactly the Session id: the plugin never removes a
 * path it cannot prove belongs to the Session it was asked to delete.
 *
 * @param ctx - Host context.
 * @param state - Plugin state used for the debug log.
 * @param sessionId - the stored Session to remove.
 * @param header - its stored header (carries the `cwd` `locate` needs).
 * @returns `{ removed }` or `{ refusal }`.
 */
async function removeSessionArtifacts(ctx, state, sessionId, header) {
  const locate = ctx.sessionPersistence.locate?.bind(ctx.sessionPersistence);
  if (typeof locate !== "function") {
    return { refusal: refusal("backend-unsupported", "当前会话存储后端不支持定位会话数据，无法删除。") };
  }
  const location = locate({ id: sessionId, cwd: header.cwd });
  const path = location?.path;
  if (typeof path !== "string" || path.length === 0) {
    return { refusal: refusal("unsafe-location", "拒绝删除：存储后端没有给出会话数据路径。") };
  }
  const directory = dirname(path);
  if (basename(directory) !== sessionId) {
    return { refusal: refusal("unsafe-location", "拒绝删除：会话数据目录与目标会话不匹配。") };
  }
  await rm(directory, { recursive: true, force: true });
  const removed = [`session-dir:${directory}`];

  const cacheTable = ctx.get("storageDomain")?.get("session_projcache")?.table?.("sessions");
  if (cacheTable !== undefined && typeof cacheTable.delete === "function") {
    const deleted = await cacheTable.delete(sessionId);
    if (deleted === true) removed.push("projection-cache");
  }
  return { removed };
}

/**
 * Drop one Session from every registry slot that still names it, then tell the
 * page the row is gone.
 * @param ctx - Host context.
 * @param state - Plugin state used for the debug log.
 * @param sessionId - the removed Session.
 * @returns the registry removals worth reporting.
 */
async function forgetSessionRecords(ctx, state, sessionId) {
  const removed = [];
  /* Registry cleanup runs before the in-memory header index is forgotten,
     because the owning Workspace's accounting view is filtered by that
     index. */
  const registry = ctx.workspaceRegistry;
  await registry.unarchiveSession(sessionId);
  await registry.unpinSession(sessionId);
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(sessionId)) {
      await workspace.detachSession(sessionId);
      removed.push(`workspace:${workspace.path}`);
    }
  }

  /* Forget the id in this process's startup header index, so `sessionKnown`
     and workspace accounting stop resolving it without a restart. */
  try {
    registry.sessionPaths?.delete?.(sessionId);
    registry.headers?.delete?.(sessionId);
  } catch (error) {
    record(state, `header index cleanup for ${sessionId} failed: ${messageOf(error)}`);
  }

  /* Same event the Session controller emits when a live Session is disposed:
     the page removes the row and its summary without a reload. */
  ctx.emit("api-session/removed", sessionId);
  return removed;
}

/* ------------------------------------------------- session workspace files */

/** Map the configured session-files policy to `off`, `confirm`, or `always`. */
function resolveSessionFilesMode(value) {
  if (value === "always" || value === true) return "always";
  if (value === "off" || value === false) return "off";
  return "confirm";
}

/** Attachment identities are the backend's content-addressed `sha256:` form. */
const ATTACHMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/i;

/**
 * Walk one Session's working directory and list entries created during its
 * lifetime.
 *
 * This is an approximation, and deliberately a conservative one: a file counts
 * as session-produced only when its birth time (falling back to inode change
 * time where the filesystem does not record birth time) is not earlier than
 * the Session's creation. Existing files a Session overwrote are therefore
 * never deleted — the user's file survives, even though its content may have
 * been replaced. Symlinks are skipped and `.git` is never entered.
 *
 * @param header - the stored Session header carrying `cwd` and `createdAt`.
 * @param excludedRoots - absolute directories to skip (the Session's own log
 *   directory, which lives inside the project directory).
 * @returns `{ files, dirs, root, since, truncated }`; empty for a Session without a cwd.
 */
async function scanSessionWorkspace(header, excludedRoots = []) {
  const empty = { files: [], dirs: [], root: undefined, since: 0, truncated: false };
  const cwd = header?.cwd;
  const createdAt = header?.createdAt;
  if (typeof cwd !== "string" || cwd.length === 0 || !Number.isFinite(createdAt)) return empty;
  let root;
  try {
    root = await realpath(cwd);
  } catch {
    return empty;
  }
  const since = createdAt - WORKSPACE_BIRTH_TOLERANCE_MS;
  const excluded = [];
  for (const entry of excludedRoots) {
    try {
      excluded.push(await realpath(entry));
    } catch {
      excluded.push(resolve(entry));
    }
  }
  const isExcluded = (path) => excluded.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
  const files = [];
  const dirs = [];
  const queue = [root];
  let visited = 0;
  let truncated = false;
  while (queue.length > 0) {
    const directory = queue.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === ".git") continue;
      if (isExcluded(join(directory, entry.name))) continue;
      if (visited >= WORKSPACE_SCAN_LIMIT) {
        truncated = true;
        break;
      }
      visited += 1;
      const path = join(directory, entry.name);
      let info;
      try {
        info = await lstat(path);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      const born = info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
      if (info.isDirectory()) {
        if (born >= since) dirs.push({ path, rel: relative(root, path) });
        queue.push(path);
      } else if (info.isFile() && born >= since) {
        files.push({ path, rel: relative(root, path), bytes: info.size });
      }
    }
    if (truncated) break;
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  dirs.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, dirs, root, since, truncated };
}

/**
 * Delete the workspace files the walk attributed to one Session, then the
 * directories that became empty. Each path is re-checked right before removal
 * (regular file, still born after the Session, still inside the workspace) so
 * a change between scan and delete cannot widen the operation.
 *
 * @param ctx - Host context.
 * @param state - Plugin state used for the debug log.
 * @param header - the removed Session's header.
 * @param warnings - receives one entry per path that could not be removed.
 * @returns `{ removed, files, dirs }` with display-relative paths.
 */
async function removeSessionWorkspaceFiles(ctx, state, header, warnings) {
  const plan = await scanSessionWorkspace(header);
  const removed = [];
  const files = [];
  const dirs = [];
  if (plan.truncated) {
    record(state, `workspace scan for ${header?.id ?? "session"} hit its ${WORKSPACE_SCAN_LIMIT}-entry bound`);
    warnings.push({ message: `工作区条目超过 ${WORKSPACE_SCAN_LIMIT} 个，已跳过剩余部分。` });
  }
  for (const file of plan.files) {
    try {
      const info = await lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const born = info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
      if (born < plan.since) continue;
      await rm(file.path, { force: true });
      removed.push(`workspace-file:${file.rel}`);
      files.push(file.rel);
    } catch (error) {
      warnings.push({ message: `工作区文件 ${file.rel} 未能删除：${messageOf(error)}` });
    }
  }
  const ordered = [...plan.dirs].sort((left, right) => right.rel.length - left.rel.length);
  for (const dir of ordered) {
    try {
      const info = await lstat(dir.path);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      await rmdir(dir.path);
      removed.push(`workspace-dir:${dir.rel}`);
      dirs.push(dir.rel);
    } catch (error) {
      if (error?.code === "ENOTEMPTY" || error?.code === "ENOENT") continue;
      warnings.push({ message: `工作区目录 ${dir.rel} 未能删除：${messageOf(error)}` });
    }
  }
  return { removed, files, dirs };
}

/**
 * Read every attachment reference out of one stored Session log.
 * @param ctx - Host context.
 * @param state - Plugin state used for the debug log.
 * @param sessionId - the Session whose log is read.
 * @returns unique attachment reference objects; empty when unreadable.
 */
async function collectSessionAttachmentRefs(ctx, state, sessionId) {
  const persistence = ctx.sessionPersistence;
  if (typeof persistence?.open !== "function") return [];
  let handle;
  try {
    handle = await persistence.open(sessionId, "read");
  } catch (error) {
    record(state, `reading attachments of ${sessionId} failed: ${messageOf(error)}`);
    return [];
  }
  try {
    const page = await handle.read(0);
    const refs = new Map();
    for (const event of Array.isArray(page?.events) ? page.events : []) collectAttachmentRefs(event, refs);
    return [...refs.values()];
  } catch (error) {
    record(state, `reading attachments of ${sessionId} failed: ${messageOf(error)}`);
    return [];
  } finally {
    try {
      await handle.close();
    } catch {
      /* a read handle close failure cannot change the deletion outcome */
    }
  }
}

/** Recursively collect `{ attachmentId, ... }` reference objects from one event. */
function collectAttachmentRefs(value, refs) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentRefs(item, refs);
    return;
  }
  const id = value.attachmentId;
  if (typeof id === "string" && ATTACHMENT_ID_PATTERN.test(id)) refs.set(id, value);
  for (const child of Object.values(value)) collectAttachmentRefs(child, refs);
}

/**
 * Delete the attachment objects that only the removed Sessions referenced.
 * Content-addressed objects are shared by hash, so an object another stored
 * Session still mentions is kept.
 *
 * @param ctx - Host context.
 * @param state - Plugin state used for the debug log.
 * @param refs - attachment references collected from the removed Session.
 * @param deletedIds - Session ids being removed together with it.
 * @param warnings - receives one entry per attachment left behind.
 * @returns `{ removed, files }`.
 */
async function removeOrphanAttachments(ctx, state, refs, deletedIds, warnings) {
  const result = { removed: [], files: [] };
  if (refs.length === 0) return result;
  const attachments = ctx.get("attachments");
  if (attachments === undefined) {
    warnings.push({ message: "附件服务不可用，未回收附件对象。" });
    return result;
  }
  const others = [];
  try {
    const snapshots = await ctx.sessionPersistence.list();
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      const id = snapshot?.header?.id;
      if (typeof id === "string" && !deletedIds.has(id)) others.push(id);
    }
  } catch (error) {
    warnings.push({ message: `无法枚举其它会话，未回收附件：${messageOf(error)}` });
    return result;
  }
  if (others.length > 64) {
    warnings.push({ message: `其它会话过多（${others.length} 个），跳过附件回收。` });
    return result;
  }
  const referenced = new Set();
  for (const id of others) {
    if (referenced.size === refs.length) break;
    let handle;
    try {
      handle = await ctx.sessionPersistence.open(id, "read");
    } catch {
      continue;
    }
    try {
      const page = await handle.read(0);
      const text = JSON.stringify(page?.events ?? []);
      for (const ref of refs) {
        if (!referenced.has(ref.attachmentId) && text.includes(ref.attachmentId)) referenced.add(ref.attachmentId);
      }
    } catch {
      /* an unreadable other session cannot prove the object is unused */
      for (const ref of refs) referenced.add(ref.attachmentId);
      break;
    }
    finally {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }
  for (const ref of refs) {
    if (referenced.has(ref.attachmentId)) continue;
    let path;
    try {
      if (typeof ref.mediaType === "string" && typeof attachments.imageHostPath === "function") path = attachments.imageHostPath(ref);
      else if (typeof attachments.fileHostPath === "function") path = attachments.fileHostPath(ref);
    } catch (error) {
      warnings.push({ message: `附件 ${ref.attachmentId} 定位失败：${messageOf(error)}` });
      continue;
    }
    if (typeof path !== "string" || path.length === 0) continue;
    try {
      await rm(path, { force: true });
      result.removed.push(`attachment:${ref.attachmentId}`);
      result.files.push(ref.attachmentId);
    } catch (error) {
      warnings.push({ message: `附件 ${ref.attachmentId} 未能删除：${messageOf(error)}` });
    }
  }
  return result;
}

/* ---------------------------------------------------------------- update */

/** Resolve this package's own identity and start the periodic registry check. */
async function startUpdateChecks(ctx, state) {
  const update = state.update;
  if (update.mode === "off") {
    record(state, "update checks disabled");
    return;
  }
  const name = update.configuredName ?? OWN.name;
  update.current = OWN.version;
  if (name.startsWith("@local/")) {
    record(state, `update checks skipped: ${name} is a local name (set updatePackageName to check a published one)`);
    return;
  }
  /* `name` is only reported once it is a package we actually track. */
  update.name = name;
  record(state, `update checks on for ${name}@${OWN.version} every ${Math.round(update.intervalMs / 60000)} min`);
  ctx.effect(() => {
    const timer = setInterval(() => {
      void checkForUpdate(state);
    }, update.intervalMs);
    /* Maintenance work must never hold the Host process open. */
    timer.unref?.();
    void checkForUpdate(state);
    return () => {
      clearInterval(timer);
    };
  }, "session-delete: update checks");
}

/**
 * Read this package's own manifest once.
 *
 * The name is used by the status route and the update check, so spelling it as
 * a literal elsewhere would create a second source of truth that silently goes
 * stale on a rename.
 *
 * @returns `{ name, version }`, or placeholders when the manifest is unreadable.
 */
function readOwnManifest() {
  try {
    const manifest = createRequire(import.meta.url)("./package.json");
    return {
      name: typeof manifest?.name === "string" ? manifest.name : "dsh-session-remove",
      version: typeof manifest?.version === "string" ? manifest.version : "0.0.0"
    };
  } catch {
    return { name: "dsh-session-remove", version: "0.0.0" };
  }
}

/** Ask the configured registries for the newest published version of this package. */
async function checkForUpdate(state) {
  const update = state.update;
  if (update.name === undefined) return;
  update.checkedAt = new Date().toISOString();
  const registries = [...new Set([update.registry, update.fallbackRegistry].filter(Boolean))];
  const failures = [];
  for (const registry of registries) {
    try {
      const latest = await fetchLatestVersion(update.name, registry);
      update.latest = latest;
      update.error = undefined;
      update.available = latest !== undefined && compareVersions(latest, update.current) > 0;
      record(state, latest === undefined
        ? `update check: current ${update.current}, not published on ${registry}`
        : `update check: current ${update.current}, latest ${latest}${update.available ? " (update available)" : ""}`);
      return;
    } catch (error) {
      failures.push(`${registry}: ${messageOf(error)}`);
    }
  }
  update.error = failures.join("; ");
  update.available = false;
  record(state, `update check failed: ${update.error}`);
}

/** One registry document read, bounded by a timeout. */
async function fetchLatestVersion(name, registry) {
  const encoded = name.startsWith("@") ? name.replace("/", "%2F") : name;
  const url = new URL(encoded, registry.endsWith("/") ? registry : `${registry}/`);
  const response = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS)
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  const latest = body?.["dist-tags"]?.latest;
  if (typeof latest !== "string") throw new Error("registry document carries no dist-tags.latest");
  return latest;
}

/** Install the newest version through the profile's own plugin manager. */
async function handleUpdateInstall(ctx, state, request) {
  const body = await readBody(request);
  const update = state.update;
  if (update.install.running) {
    return jsonResponse({ ok: false, code: "install-running", message: "已经有一次更新在进行了。" }, 409);
  }
  if (update.mode === "off" || update.name === undefined) {
    return jsonResponse({ ok: false, code: "update-disabled", message: "这个插件没有开启更新检查。" }, 400);
  }
  if (update.available !== true) {
    await checkForUpdate(state);
    if (update.available !== true) {
      return jsonResponse({ ok: false, code: "up-to-date", message: `已经是最新版本（${update.current}）。` }, 409);
    }
  }
  const manager = ctx.get("pluginManager");
  if (manager === undefined || typeof manager.installBundle !== "function") {
    return jsonResponse({ ok: false, code: "no-plugin-manager", message: "当前组合里没有插件管理器，无法自动更新。请用插件页手动安装。" }, 409);
  }
  const version = typeof body?.version === "string" ? body.version : update.latest;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    return jsonResponse({ ok: false, code: "unknown-version", message: "不知道该更新到哪个版本。" }, 409);
  }
  update.install = { running: true, application: undefined, version, error: undefined, at: new Date().toISOString() };
  try {
    const result = await manager.installBundle(`${update.name}@${version}`, { enabled: true });
    update.install = {
      running: false,
      application: typeof result?.application === "string" ? result.application : undefined,
      version,
      error: undefined,
      at: new Date().toISOString()
    };
    record(state, `update installed: ${update.name}@${version} (application: ${update.install.application ?? "unknown"})`);
    return jsonResponse({
      ok: true,
      name: update.name,
      version,
      application: update.install.application,
      warnings: result?.warnings ?? [],
      restartRequired: update.install.application !== "applied"
    });
  } catch (error) {
    update.install = { running: false, application: undefined, version, error: messageOf(error), at: new Date().toISOString() };
    record(state, `update install failed: ${messageOf(error)}`);
    return jsonResponse({ ok: false, code: "install-failed", message: `更新失败：${messageOf(error)}` }, 500);
  }
}

/** The update facts the page reads. */
function updateState(state) {
  const update = state.update;
  return {
    mode: update.mode,
    name: update.name ?? null,
    current: update.current ?? null,
    latest: update.latest ?? null,
    available: update.available === true,
    checkedAt: update.checkedAt ?? null,
    error: update.error ?? null,
    install: update.install
  };
}

/* --------------------------------------------------------------- helpers */

/**
 * Compare two semantic versions, prereleases included, the way npm orders them.
 * @param a - left version.
 * @param b - right version.
 * @returns a positive number when `a` is newer, negative when older, 0 when equal.
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return String(a).localeCompare(String(b));
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index++) {
    const one = left.pre[index];
    const other = right.pre[index];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    const oneNumeric = /^\d+$/.test(one);
    const otherNumeric = /^\d+$/.test(other);
    if (oneNumeric && otherNumeric) {
      if (Number(one) !== Number(other)) return Number(one) > Number(other) ? 1 : -1;
      continue;
    }
    if (oneNumeric !== otherNumeric) return oneNumeric ? -1 : 1;
    if (one !== other) return one > other ? 1 : -1;
  }
  return 0;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse one semantic version, or undefined when it is not one. */
function parseVersion(value) {
  if (typeof value !== "string") return undefined;
  const match = SEMVER.exec(value.trim());
  if (match === null) return undefined;
  const [core, pre] = value.trim().split("-");
  const [major, minor, patch] = core.split(".").map(Number);
  return { major, minor, patch, pre: pre === undefined ? [] : pre.split(".") };
}

/** The page reports that its half mounted, which is the only signal that the Client bundle loaded. */
async function handleClientReady(state, request) {
  const body = await readBody(request);
  const detail = typeof body?.detail === "string" ? body.detail : "no detail";
  record(state, `client half mounted (${detail})`);
  return jsonResponse({ ok: true, update: updateState(state) });
}

/** Hold one route handler's failures inside the request instead of the server. */
async function guard(handler, request, state) {
  try {
    return await handler(request);
  } catch (error) {
    record(state, `route failed: ${messageOf(error)}`);
    return jsonResponse({ ok: false, code: "internal", message: messageOf(error) }, 500);
  }
}

async function readBody(request) {
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null ? body : undefined;
  } catch {
    return undefined;
  }
}

function validSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

function refusal(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Resolve the debug log location. The desktop Host keeps no readable log file,
 * so a small append-only line per event is the plugin's own evidence that it
 * loaded and what it did. `config.debugLog: false` turns it off.
 */
function resolveLogPath(config) {
  if (config?.debugLog === false) return undefined;
  if (typeof config?.logPath === "string" && config.logPath.length > 0) return config.logPath;
  const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "plugin-session-remove.log");
}

/** Append one diagnostic line; logging never fails an operation. */
function record(state, line) {
  const entry = { time: new Date().toISOString(), line };
  state.history.push(entry);
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
  state.ctx?.logger?.info?.(`session-remove: ${line}`);
  if (state.logPath === undefined) return;
  void appendFile(state.logPath, `${entry.time} ${line}\n`, "utf8").catch(() => {});
}

export { compareVersions, parseVersion, scanSessionWorkspace };
