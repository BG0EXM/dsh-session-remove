/**
 * Host-half behaviour tests for `@local/dsh-session-delete`.
 *
 * These drive the real `apply()` through a mocked Cordis context: the routes
 * the plugin registers are captured and called with real `Request` objects,
 * and the fake services record the calls each operation makes. Run with:
 *
 *   node --test plugins/dsh-session-delete/test/host.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply, compareVersions, parseVersion } from "../index.js";

/** This package's own identity, so version bumps never break the suite. */
const OWN = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

/** The next patch release above this package's own version. */
function nextVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

const SESSION_ID = "session-11111111-2222-3333-4444-555555555555";
const OTHER_ID = "session-99999999-8888-7777-6666-555555555555";

const DELETE_PATH = "/api/session-delete.delete";
const STOP_PATH = "/api/session-delete.stop";
const UPDATE_STATE_PATH = "/api/session-delete.update-state";
const UPDATE_INSTALL_PATH = "/api/session-delete.install-update";
const CLIENT_READY_PATH = "/api/session-delete.client-ready";
const STATUS_PATH = "/api/session-delete.status";

/**
 * Build a mocked Host context over a real temporary Session directory.
 * @param options - which services answer, and how.
 * @returns the context, captured routes/disposers, and the observation record.
 */
async function harness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsd-test-"));
  const project = join(root, "project");
  const sessionDir = join(project, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const logPath = join(sessionDir, "session.v4.jsonl.zstd");
  await writeFile(logPath, "log");
  await writeFile(join(sessionDir, "session.lock"), "");

  const observed = {
    emitted: [],
    unarchived: [],
    unpinned: [],
    detached: [],
    detachedLive: [],
    cacheDeleted: [],
    stopped: [],
    installed: [],
    order: [],
    flushed: 0,
    logExistedAtRelease: undefined,
    logged: [],
    waterfallCalls: 0
  };

  const registry = {
    sessionPaths: new Map([[SESSION_ID, project]]),
    headers: new Map([[SESSION_ID, { id: SESSION_ID }]]),
    list: () => [
      {
        path: project,
        sessionIds: [SESSION_ID],
        detachSession: async (id) => {
          observed.detached.push(id);
        }
      }
    ],
    unarchiveSession: async (id) => {
      observed.unarchived.push(id);
    },
    unpinSession: async (id) => {
      observed.unpinned.push(id);
    },
    stopSessionActivity: async (id) => {
      observed.stopped.push(id);
      observed.order.push("stop");
    }
  };

  /* `activitySequence` lets a test give the waterfall different answers across
     calls: first "work is running", then "stopped". */
  const sequence = options.activitySequence;
  const held = options.live === true || options.releaseHeld === true;
  const liveIds = new Set(held ? [SESSION_ID] : []);
  const liveEntries = new Map(held ? [[SESSION_ID, { id: SESSION_ID }]] : []);
  const sessionsService = { get: (id) => (liveIds.has(id) ? { id } : undefined) };
  if (options.releaseHeld === true) {
    /* The real store: `get` returns the Session, `store` holds the entries, and
       `detachEntered` is the public method that removes one. */
    sessionsService.store = liveEntries;
    sessionsService.detachEntered = (entry) => {
      observed.detachedLive.push(entry.id);
      observed.order.push("release");
      observed.logExistedAtRelease = existsSync(logPath);
      liveIds.delete(entry.id);
      liveEntries.delete(entry.id);
    };
  }
  const services = {
    sessions: sessionsService,
    agents:
      options.running === true
        ? { get: (id) => (id === SESSION_ID ? { id, status: "running" } : undefined) }
        : { get: () => undefined },
    workspaceRegistry: registry,
    storageDomain: {
      get: (name) =>
        name === "session_projcache"
          ? {
              table: () => ({
                delete: async (key) => {
                  observed.cacheDeleted.push(key);
                  return true;
                }
              })
            }
          : undefined
    },
    pluginManager:
      options.installBundle === undefined
        ? undefined
        : {
            installBundle: async (spec, installOptions) => {
              observed.installed.push({ spec, installOptions });
              if (options.installThrows === true) throw new Error("pnpm exploded");
              return options.installResult ?? { application: "restart-required", warnings: [] };
            }
          },
    sessionPersistence: {
      flush: async () => {
        observed.flushed += 1;
      },
      stat: async (id) => {
        if (options.missing === true) return undefined;
        if (id !== SESSION_ID) return undefined;
        return { header: { id, cwd: project } };
      },
      locate: (meta) => {
        if (options.unsafeLocation === true) return { kind: "jsonl", path: join(root, "elsewhere", "session.v4.jsonl.zstd") };
        return { kind: "jsonl", path: join(project, meta.id, "session.v4.jsonl.zstd") };
      }
    }
  };

  const routes = new Map();
  const disposers = [];
  const ctx = {
    /* Real Cordis exposes injected services as context properties; `get` is
       the explicit accessor the plugin also uses during elimination checks. */
    ...services,
    get: (name) => services[name],
    emit: (event, ...args) => observed.emitted.push([event, ...args]),
    waterfall: async () => {
      const value = sequence === undefined
        ? options.activity ?? []
        : sequence[Math.min(observed.waterfallCalls, sequence.length - 1)];
      observed.waterfallCalls += 1;
      return value;
    },
    effect: (factory) => {
      disposers.push(factory());
    },
    logger: { info: (line) => observed.logged.push(line) },
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route);
          return () => {};
        }
      }
    }
  };

  apply(ctx, { debugLog: false, ...(options.config ?? {}) });

  /** Call one captured route the way the shared Fetch handler would. */
  const call = async (path, body, method = "POST") =>
    routes.get(path).fetch(
      new Request(`http://127.0.0.1:19387${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
      })
    );

  /** Settle the plugin's own effects and remove the fixture directory. */
  const close = async () => {
    for (const disposer of disposers) if (typeof disposer === "function") await disposer();
    await rm(root, { recursive: true, force: true });
  };

  return { root, project, sessionDir, logPath, routes, observed, call, registry, close };
}

/* ----------------------------------------------------------------- routes */

test("registers every Host route", async () => {
  const h = await harness();
  assert.deepEqual(
    [...h.routes.keys()].sort(),
    [DELETE_PATH, STOP_PATH, UPDATE_STATE_PATH, UPDATE_INSTALL_PATH, CLIENT_READY_PATH, STATUS_PATH].sort()
  );
  await h.close();
});

/* ----------------------------------------------------------------- delete */

test("deletes the log directory, cache row, workspace accounting, and notifies the page", async () => {
  const h = await harness();
  const response = await h.call(DELETE_PATH, { sessionId: SESSION_ID });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.stopped, false);
  assert.equal(existsSync(h.logPath), false, "log file is gone");
  assert.deepEqual(await readdir(h.project), [], "project directory keeps no residue");
  assert.deepEqual(h.observed.cacheDeleted, [SESSION_ID]);
  assert.deepEqual(h.observed.unarchived, [SESSION_ID]);
  assert.deepEqual(h.observed.unpinned, [SESSION_ID]);
  assert.deepEqual(h.observed.detached, [SESSION_ID]);
  assert.deepEqual(h.observed.emitted, [["api-session/removed", SESSION_ID]]);
  assert.equal(h.registry.sessionPaths.has(SESSION_ID), false, "header index forgets the id");
  await h.close();
});

test("refuses a session this process still holds, naming what to do", async () => {
  const h = await harness({ live: true });
  const response = await h.call(DELETE_PATH, { sessionId: SESSION_ID });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, "session-held");
  assert.match(body.message, /切换/);
  assert.equal(existsSync(h.logPath), true);
  assert.deepEqual(h.observed.stopped, [], "nothing was stopped");
  await h.close();
});

test("a running Agent is reported as work, so the dialog can offer the stop", async () => {
  const h = await harness({ running: true });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID })).json();
  assert.equal(body.code, "session-active");
  assert.match(body.message, /运行中的回合/);
  assert.equal(existsSync(h.logPath), true);
  await h.close();
});

test("refuses work-in-progress and reports the families", async () => {
  const h = await harness({ activity: [{ kind: "job", items: [{ id: "j1" }] }] });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID })).json();
  assert.equal(body.code, "session-active");
  assert.deepEqual(body.activity, ["job"]);
  assert.match(body.message, /job/);
  assert.deepEqual(h.observed.stopped, []);
  await h.close();
});

test("stop-and-delete stops the work, then deletes in one call", async () => {
  const h = await harness({ activitySequence: [[{ kind: "turn" }], []] });
  const response = await h.call(DELETE_PATH, { sessionId: SESSION_ID, stopActivity: true });
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.equal(body.stopped, true);
  assert.deepEqual(h.observed.stopped, [SESSION_ID]);
  assert.equal(existsSync(h.logPath), false);
  assert.ok(h.observed.logged.some((line) => line.includes("stopped work for")), "the stop is visible in the log");
  await h.close();
});

test("a busy Session that cannot be released is refused before its work is touched", async () => {
  const h = await harness({ live: true, activitySequence: [[{ kind: "turn" }], []] });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID, stopActivity: true })).json();

  assert.equal(body.code, "session-held");
  assert.deepEqual(h.observed.stopped, [], "a deletion that cannot finish does not stop the user's work");
  assert.match(body.message, /切换到别的会话/);
  assert.equal(existsSync(h.logPath), true);
  await h.close();
});

test("stop-and-delete releases the Session before stopping, so no new work can start under it", async () => {
  const h = await harness({
    releaseHeld: true,
    activitySequence: [[{ kind: "job" }], []],
    config: { stopWaitMs: 600 }
  });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID, stopActivity: true })).json();

  assert.equal(body.ok, true, JSON.stringify(body));
  assert.deepEqual(h.observed.order, ["release", "stop"], "release comes first");
  await h.close();
});

test("stop-and-delete reports work that did not settle", async () => {
  const h = await harness({ activitySequence: [[{ kind: "job" }], [{ kind: "job" }]], config: { stopWaitMs: 600 } });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID, stopActivity: true })).json();

  assert.equal(body.code, "session-stopping");
  assert.deepEqual(h.observed.stopped, [SESSION_ID]);
  assert.equal(existsSync(h.logPath), true);
  await h.close();
});

test("stop-and-delete releases a held Session, detaching before it removes the files", async () => {
  const h = await harness({
    releaseHeld: true,
    activitySequence: [[{ kind: "job" }], []],
    config: { stopWaitMs: 600 }
  });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID, stopActivity: true })).json();

  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.stopped, true);
  assert.deepEqual(h.observed.stopped, [SESSION_ID]);
  assert.deepEqual(h.observed.detachedLive, [SESSION_ID], "the live store was asked to release it");
  assert.equal(h.observed.logExistedAtRelease, true, "release happens while the log still exists");
  assert.equal(h.observed.flushed, 1, "the durability barrier runs before the files go");
  assert.equal(existsSync(h.logPath), false);
  assert.ok(h.observed.logged.some((line) => line.includes("released")));
  await h.close();
});

test("a held but idle Session is released by a plain delete too", async () => {
  const h = await harness({ releaseHeld: true });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID })).json();

  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.stopped, false);
  assert.deepEqual(h.observed.detachedLive, [SESSION_ID]);
  assert.equal(existsSync(h.logPath), false);
  await h.close();
});

test("refuses an unknown session", async () => {
  const h = await harness({ missing: true });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID })).json();
  assert.equal(body.code, "session-not-found");
  await h.close();
});

test("refuses a location that does not belong to the named session", async () => {
  const h = await harness({ unsafeLocation: true });
  const body = await (await h.call(DELETE_PATH, { sessionId: SESSION_ID })).json();
  assert.equal(body.code, "unsafe-location");
  assert.equal(existsSync(h.logPath), true, "unrelated paths are never removed");
  await h.close();
});

test("rejects malformed bodies, ids, and other sessions", async () => {
  const h = await harness();
  const invalid = await h.call(DELETE_PATH, { sessionId: "../etc/passwd" });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid-session-id");

  const badJson = await h.routes.get(DELETE_PATH).fetch(
    new Request(`http://127.0.0.1:19387${DELETE_PATH}`, { method: "POST", body: "not json" })
  );
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).code, "invalid-body");

  const other = await (await h.call(DELETE_PATH, { sessionId: OTHER_ID })).json();
  assert.equal(other.code, "session-not-found");
  assert.equal(existsSync(h.logPath), true);
  await h.close();
});

/* ------------------------------------------------------------------- stop */

test("stop asks the registry's admission and reports the families", async () => {
  const h = await harness({
    activitySequence: [[{ kind: "turn" }, { kind: "subagent", items: [{ id: "s1" }] }], []],
    config: { stopWaitMs: 600 }
  });
  const body = await (await h.call(STOP_PATH, { sessionId: SESSION_ID })).json();

  assert.equal(body.ok, true);
  assert.deepEqual(body.stopped, ["turn", "subagent"]);
  assert.equal(body.idle, false);
  assert.deepEqual(h.observed.stopped, [SESSION_ID]);
  await h.close();
});

test("stop on an idle session says so without asking providers", async () => {
  const h = await harness();
  const body = await (await h.call(STOP_PATH, { sessionId: SESSION_ID })).json();

  assert.equal(body.ok, true);
  assert.equal(body.idle, true);
  assert.deepEqual(body.stopped, []);
  assert.deepEqual(h.observed.stopped, []);
  await h.close();
});

test("stop rejects a malformed session id", async () => {
  const h = await harness();
  const response = await h.call(STOP_PATH, { sessionId: "@bad id" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid-session-id");
  await h.close();
});

/* ---------------------------------------------------------------- updates */

test("orders semantic versions the way npm does", () => {
  const cases = [
    ["0.1.0", "0.1.0", 0],
    ["0.1.1", "0.1.0", 1],
    ["0.1.0", "0.2.0", -1],
    ["1.0.0", "0.9.9", 1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0-rc.2", "1.0.0-rc.1", 1],
    ["1.0.0-alpha.1", "1.0.0-beta.0", -1],
    ["1.0.0-alpha.2", "1.0.0-alpha.10", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["0.2.0-rc.10", "0.2.0-rc.2", 1]
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(Math.sign(compareVersions(a, b)), expected, `${a} vs ${b}`);
  }
  assert.equal(parseVersion("0.2.0-rc.2").pre.length, 2);
  assert.equal(parseVersion("nope"), undefined);
});

/** Wait for the plugin's asynchronous update check (file read + fetch) to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/** Serve one registry document to the plugin's update check. */
function stubRegistry(latest, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (status !== 200) return new Response("nope", { status });
    return new Response(JSON.stringify({ "dist-tags": { latest } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  return calls;
}

test("reports an available update from the registry", async () => {
  const calls = stubRegistry(nextVersion(OWN.version));
  const h = await harness({ config: { updatePackageName: "dsh-session-remove" } });
  await settle();

  const state = await (await h.call(UPDATE_STATE_PATH, undefined, "GET")).json();
  assert.equal(state.name, "dsh-session-remove");
  assert.equal(state.current, OWN.version);
  assert.equal(state.latest, nextVersion(OWN.version));
  assert.equal(state.available, true);
  assert.match(calls[0], /dsh-session-remove$/);
  assert.ok(h.observed.logged.some((line) => line.includes("update available")));
  await h.close();
});

test("reports no update when the published version is not newer", async () => {
  stubRegistry(OWN.version);
  const h = await harness({ config: { updatePackageName: "dsh-session-remove" } });
  await settle();
  const state = await (await h.call(UPDATE_STATE_PATH, undefined, "GET")).json();
  assert.equal(state.available, false);
  await h.close();
});

test("survives a registry that has no such package", async () => {
  stubRegistry(undefined, { status: 404 });
  const h = await harness({ config: { updatePackageName: "not-published-anywhere" } });
  await settle();
  const state = await (await h.call(UPDATE_STATE_PATH, undefined, "GET")).json();
  assert.equal(state.available, false);
  assert.equal(state.latest, null);
  await h.close();
});

test("installs the newer version through the plugin manager", async () => {
  stubRegistry(nextVersion(OWN.version));
  const h = await harness({
    config: { updatePackageName: "dsh-session-remove" },
    installBundle: true,
    installResult: { application: "restart-required", warnings: ["restart"] }
  });
  await settle();

  const body = await (await h.call(UPDATE_INSTALL_PATH, {})).json();
  assert.equal(body.ok, true);
  assert.equal(body.restartRequired, true);
  assert.deepEqual(h.observed.installed.map((entry) => entry.spec), [`${OWN.name}@${nextVersion(OWN.version)}`]);
  assert.deepEqual(h.observed.installed[0].installOptions, { enabled: true });
  await h.close();
});

test("refuses to install without an update, and without a plugin manager", async () => {
  stubRegistry(OWN.version);
  const h = await harness({ config: { updatePackageName: "dsh-session-remove" }, installBundle: true });
  await settle();
  const upToDate = await (await h.call(UPDATE_INSTALL_PATH, {})).json();
  assert.equal(upToDate.code, "up-to-date");
  await h.close();

  stubRegistry(nextVersion(OWN.version));
  const without = await harness({ config: { updatePackageName: "dsh-session-remove" } });
  await settle();
  const noManager = await (await without.call(UPDATE_INSTALL_PATH, {})).json();
  assert.equal(noManager.code, "no-plugin-manager");
  await without.close();
});

test("reports a failed install instead of throwing", async () => {
  stubRegistry(nextVersion(OWN.version));
  const h = await harness({
    config: { updatePackageName: "dsh-session-remove" },
    installBundle: true,
    installThrows: true
  });
  await settle();
  const response = await h.call(UPDATE_INSTALL_PATH, {});
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "install-failed");
  await h.close();
});

test("skips update checks for a local package name", async () => {
  const h = await harness({ config: { updatePackageName: "@local/unpublished" } });
  await settle();
  const state = await (await h.call(UPDATE_STATE_PATH, undefined, "GET")).json();
  assert.equal(state.name, null);
  assert.equal(state.available, false);
  assert.ok(h.observed.logged.some((line) => line.includes("update checks skipped")));
  await h.close();
});

/* --------------------------------------------------------------- plumbing */

test("the client-ready route records the mount and answers with update state", async () => {
  const h = await harness();
  const body = await (await h.call(CLIENT_READY_PATH, { detail: "menu=slot" })).json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.update, "object");
  assert.ok(h.observed.logged.some((line) => line.includes("client half mounted")));
  await h.close();
});

test("the status route reports plugin identity, update state, and history", async () => {
  const h = await harness();
  await h.call(DELETE_PATH, { sessionId: SESSION_ID });
  const body = await (await h.routes.get(STATUS_PATH).fetch(
    new Request(`http://127.0.0.1:19387${STATUS_PATH}`, { method: "GET" })
  )).json();

  assert.equal(body.plugin, "dsh-session-remove");
  assert.equal(body.routes.length, 6);
  assert.equal(body.update.mode, "notify");
  assert.ok(body.history.some((entry) => entry.line.includes(`deleted ${SESSION_ID}`)));
  await h.close();
});

test("update checks can be turned off", async () => {
  const h = await harness({ config: { updateMode: "off" } });
  await settle();
  const body = await (await h.call(STATUS_PATH, undefined, "GET")).json();
  assert.equal(body.update.mode, "off");
  assert.ok(h.observed.logged.some((line) => line.includes("update checks disabled")));
  await h.close();
});
