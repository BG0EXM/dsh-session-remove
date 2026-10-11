/**
 * Client half of `dsh-session-remove`.
 *
 * Three surfaces, all fetched from the Host half's `/api/session-delete.*`
 * routes:
 *
 * - **停止会话…** (menu order 450) — asks the Host to run the registry's
 *   `workspace/session-stop` admission. It confirms first, because that stop is
 *   the archive-shaped one: it discards queued input.
 * - **删除会话…** (menu order 500) — confirms, deletes, and offers
 *   「停止并删除」 when the Host reports that work is still running.
 * - **更新提示** — a dismissible notice while the Host reports a newer release.
 *
 * Shape notes, all verified against the shipped bundle:
 *
 * - `window.__ModuleLoader__.load({ id, factory })` only registers; the body
 *   runs when the module is materialized, and the factory must RETURN the
 *   plugin object `{ inject, apply }`.
 * - `sidebar.workspaces.session.menu.item` is a `list` slot declared by
 *   `dsh-client-ui-workspace`; its entries receive the row identity
 *   (`sessionId`, `displayTitle`) plus the `useMenuOpenState` hook, must render
 *   one `role="menuitem"` button, and dismiss the menu themselves.
 * - Menu rows unmount with the menu, so every dialog lives in one separate
 *   `shell.overlay` entry driven by the module-scoped stores below.
 * - Harness Client packages must not be imported. The markup, class rules, and
 *   theme tokens here are copied from the shipped primitives under this
 *   plugin's own class prefix.
 */

window.__ModuleLoader__.load({
  id: "dsh-session-remove",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Locale namespace owned by this package. */
    const NS = "session-delete";
    const MENU_SLOT = "sidebar.workspaces.session.menu.item";
    const OVERLAY_SLOT = "shell.overlay";
    const STOP_PATH = "/api/session-delete.stop";
    const DELETE_PATH = "/api/session-delete.delete";
    const UPDATE_STATE_PATH = "/api/session-delete.update-state";
    const UPDATE_INSTALL_PATH = "/api/session-delete.install-update";
    const CLIENT_READY_PATH = "/api/session-delete.client-ready";

    /** Shipped rows place pin/rename/fork/archive at 100/200/300/400. */
    const STOP_ORDER = 450;
    const DELETE_ORDER = 500;

    /** A refusal that the delete dialog can answer with 「停止并删除」. */
    const STOPPABLE = ["session-active", "session-stopping"];

    /** Dismissed update notices, one version each, remembered per browser. */
    const DISMISS_KEY = "dsh-session-remove:update-dismissed";
    const UPDATE_POLL_MS = 30 * 60 * 1000;

    const DICTIONARIES = {
      zh: {
        "menu.stopSession": "停止会话…",
        "menu.deleteSession": "删除会话…",
        "stop.title": "停止此会话的工作？",
        "stop.desc": "将取消「{title}」正在运行的回合，并停止它的子代理、后台任务与定时提醒。排队中的输入会被丢弃。",
        "stop.action": "停止",
        "stop.pending": "正在停止…",
        "stop.done": "已请求停止：{kinds}。",
        "stop.idle": "该会话当前没有正在运行的工作。",
        "confirm.title": "删除此会话？",
        "confirm.desc": "将永久删除“{title}”及其本地数据（对话日志、投影缓存、工作区记录）。此操作无法撤销。",
        "confirm.action": "永久删除",
        "confirm.pending": "正在删除…",
        "confirm.stopAndDelete": "停止并删除",
        "confirm.stopping": "正在停止它的工作…",
        "cancel": "取消",
        "close": "关闭",
        "error.fallback": "操作失败。",
        "update.title": "有新版本",
        "update.desc": "当前 {current}，最新 {latest}。更新会替换已安装的插件；重启应用后生效。",
        "update.action": "更新",
        "update.later": "稍后",
        "update.pending": "正在更新…",
        "update.installed": "已安装 {version}，重启应用后生效。",
        "update.applied": "已更新到 {version}。",
        "update.failed": "更新失败：{message}"
      },
      en: {
        "menu.stopSession": "Stop Session…",
        "menu.deleteSession": "Delete Session…",
        "stop.title": "Stop this session's work?",
        "stop.desc": "This cancels “{title}”'s running turn and stops its subagents, background jobs, and reminders. Queued input is discarded.",
        "stop.action": "Stop",
        "stop.pending": "Stopping…",
        "stop.done": "Stop requested: {kinds}.",
        "stop.idle": "This session has no running work.",
        "confirm.title": "Delete this session?",
        "confirm.desc": "“{title}” and its local data (conversation log, projection cache, workspace record) will be permanently deleted. This cannot be undone.",
        "confirm.action": "Delete",
        "confirm.pending": "Deleting…",
        "confirm.stopAndDelete": "Stop and delete",
        "confirm.stopping": "Stopping its work…",
        "cancel": "Cancel",
        "close": "Close",
        "error.fallback": "The operation failed.",
        "update.title": "Update available",
        "update.desc": "Installed {current}, latest {latest}. Updating replaces the installed plugin and takes effect after a restart.",
        "update.action": "Update",
        "update.later": "Later",
        "update.pending": "Updating…",
        "update.installed": "Installed {version}; it takes effect after a restart.",
        "update.applied": "Updated to {version}.",
        "update.failed": "Update failed: {message}"
      }
    };

    const MENU_CSS = [
      ".dsd-menu-wrap{display:flex;flex-direction:column}",
      ".dsd-menu-separator{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}",
      ".dsd-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;",
      "border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;",
      "font-size:13px;line-height:20px;text-align:left;color:var(--dsw-alias-label-primary)}",
      ".dsd-menu-item.dsd-danger{color:var(--dsw-alias-state-error-primary)}",
      ".dsd-menu-item:hover:not(:disabled),.dsd-menu-item:focus-visible:not(:disabled){",
      "background:var(--dsw-alias-interactive-bg-hover);outline:none}",
      ".dsd-menu-item.dsd-danger:hover:not(:disabled),.dsd-menu-item.dsd-danger:focus-visible:not(:disabled){",
      "background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}",
      ".dsd-menu-item:disabled{cursor:not-allowed;opacity:.4}",
      ".dsd-menu-icon{flex:none;display:inline-flex;align-items:center;color:inherit}",
      ".dsd-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    ].join("");

    const DIALOG_CSS = [
      ".dsd-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}",
      ".dsd-mask{position:absolute;inset:0;backdrop-filter:var(--dsw-mask-blur)}",
      ".dsd-mask::after{content:'';position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}",
      ".dsd-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;",
      "width:min(420px,100%);padding:0 0 24px;overflow:hidden;border-radius:var(--dsw-radius-panel);",
      "background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}",
      ".dsd-dialog:focus{outline:none}",
      ".dsd-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}",
      ".dsd-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}",
      ".dsd-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;",
      "border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}",
      ".dsd-close:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsd-content{display:flex;flex-direction:column;min-width:0}",
      ".dsd-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}",
      ".dsd-status{padding:12px 24px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".dsd-error{padding:12px 24px 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
      ".dsd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}",
      ".dsd-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;",
      "padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;",
      "color:var(--dsw-alias-label-primary);background:transparent}",
      ".dsd-button:disabled{cursor:not-allowed;opacity:.4}",
      ".dsd-outline{border:.5px solid var(--dsw-alias-border-l3)}",
      ".dsd-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsd-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}"
    ].join("");

    const NOTICE_CSS = [
      ".dsd-notice{pointer-events:auto;position:fixed;right:16px;bottom:16px;z-index:900;box-sizing:border-box;",
      "display:flex;flex-direction:column;gap:10px;width:min(320px,100%);padding:14px 16px;",
      "border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);",
      "box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}",
      ".dsd-notice-title{font-size:13px;line-height:20px;font-weight:500}",
      ".dsd-notice-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".dsd-notice-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
      ".dsd-notice-actions{display:flex;justify-content:flex-end;gap:8px}"
    ].join("");

    /** The plugin context, captured in `apply`, so dialogs can reach services. */
    let runtimeCtx = null;

    /* ------------------------------------------------------- request store */

    /**
     * The pending confirmation: `{ kind: 'stop' | 'delete', sessionId, displayTitle }`.
     * Menu rows unmount when the menu closes, so the dialog cannot be owned by
     * one; it is published here and rendered by the `shell.overlay` entry.
     */
    let pending = null;
    const pendingListeners = new Set();

    function setPending(next) {
      pending = next;
      for (const notify of [...pendingListeners]) notify();
    }

    function usePending() {
      const [, bump] = React.useReducer((count) => count + 1, 0);
      React.useEffect(() => {
        pendingListeners.add(bump);
        return () => {
          pendingListeners.delete(bump);
        };
      }, []);
      return pending;
    }

    /* -------------------------------------------------------- update store */

    let updateState = { available: false, current: null, latest: null, mode: "off" };
    let dismissed = readDismissed();
    let installState = { running: false, message: null, error: null };
    const updateListeners = new Set();

    function setUpdate(next) {
      updateState = next;
      for (const notify of [...updateListeners]) notify();
    }

    function setInstall(next) {
      installState = { ...installState, ...next };
      for (const notify of [...updateListeners]) notify();
    }

    function useUpdate() {
      const [, bump] = React.useReducer((count) => count + 1, 0);
      React.useEffect(() => {
        updateListeners.add(bump);
        return () => {
          updateListeners.delete(bump);
        };
      }, []);
      return { updateState, installState, dismissed };
    }

    function readDismissed() {
      try {
        const raw = window.localStorage?.getItem(DISMISS_KEY);
        const parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
        return typeof parsed === "string" ? parsed : null;
      } catch {
        return null;
      }
    }

    function dismiss(version) {
      dismissed = version ?? null;
      try {
        window.localStorage?.setItem(DISMISS_KEY, JSON.stringify(dismissed));
      } catch {
        /* a browser without storage still gets the notice; it just is not remembered */
      }
      for (const notify of [...updateListeners]) notify();
    }

    /**
     * Leave the main area when the Session it was showing has just been
     * deleted. Released Sessions keep rendering from memory, so without this
     * the page stays on a conversation that no longer exists. This mirrors the
     * shipped archive path, which clears the main view for the Session it
     * archives; the empty state is where a fresh Session can be started.
     * @param sessionId - the Session that was deleted.
     */
    function leaveDeletedView(sessionId) {
      const ui = runtimeCtx?.get?.("uiWorkspace");
      if (ui === undefined || ui === null) return;
      if (ui.mainReference?.sessionId !== sessionId) return;
      if (typeof ui.clearMain === "function") ui.clearMain();
      else if (typeof ui.startSession === "function") ui.startSession();
    }

    async function refreshUpdateState() {
      try {
        const result = await callHost(UPDATE_STATE_PATH, undefined, "GET");
        if (result?.ok !== false) setUpdate(result);
      } catch {
        /* the Host half may not be mounted; the notice simply stays hidden */
      }
    }

    /* ----------------------------------------------------------- host calls */

    /** Call one of the Host half's routes; a non-JSON answer is a route failure. */
    async function callHost(path, body, method = "POST") {
      const response = await fetch(path, {
        method,
        ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) } : {})
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (payload === null || typeof payload !== "object") {
        throw new Error(`Host 未返回可读结果（HTTP ${response.status}）。`);
      }
      return payload;
    }

    /* --------------------------------------------------------------- icons */

    function TrashIcon() {
      return h(
        "svg",
        { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true", focusable: "false" },
        h("path", {
          d: "M2.5 4.2h11M6.2 2.2h3.6M4.2 4.2l.55 8.4a1.2 1.2 0 0 0 1.2 1.1h4.1a1.2 1.2 0 0 0 1.2-1.1l.55-8.4M6.7 6.6v5.2M9.3 6.6v5.2",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        })
      );
    }

    function StopIcon() {
      return h(
        "svg",
        { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true", focusable: "false" },
        h("rect", {
          x: 4.2,
          y: 4.2,
          width: 7.6,
          height: 7.6,
          rx: 1.4,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2
        })
      );
    }

    function CloseIcon() {
      return h(
        "svg",
        { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true", focusable: "false" },
        h("path", {
          d: "M3.5 3.5l9 9M12.5 3.5l-9 9",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round"
        })
      );
    }

    /* ------------------------------------------------------------ menu rows */

    /** One row wrapper: separator + a `role="menuitem"` button, per the slot contract. */
    function MenuRow({ label, danger, icon, onSelect }) {
      return h(
        "div",
        { className: "dsd-menu-wrap" },
        h("div", { className: "dsd-menu-separator", role: "separator" }),
        h(
          "button",
          {
            type: "button",
            role: "menuitem",
            className: danger === true ? "dsd-menu-item dsd-danger" : "dsd-menu-item",
            onClick: onSelect
          },
          h("span", { className: "dsd-menu-icon" }, icon),
          h("span", { className: "dsd-menu-label" }, label)
        )
      );
    }

    /** Stops one Session's turn, subagents, background jobs, and reminders. */
    function StopSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      return h(
        React.Fragment,
        null,
        h("style", { key: "style" }, MENU_CSS),
        h(MenuRow, {
          key: "row",
          label: t("menu.stopSession"),
          icon: h(StopIcon, null),
          onSelect: () => {
            setMenuOpen(false);
            setPending({ kind: "stop", sessionId, displayTitle });
          }
        })
      );
    }

    /** Permanently deletes one stored Session. */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      return h(
        React.Fragment,
        null,
        h("style", { key: "style" }, MENU_CSS),
        h(MenuRow, {
          key: "row",
          label: t("menu.deleteSession"),
          danger: true,
          icon: h(TrashIcon, null),
          onSelect: () => {
            setMenuOpen(false);
            setPending({ kind: "delete", sessionId, displayTitle });
          }
        })
      );
    }

    /* -------------------------------------------------------- overlay entry */

    /** Everything this plugin draws above the app: confirmations and the update notice. */
    function SessionDeleteOverlay({ t }) {
      const request = usePending();
      return h(
        React.Fragment,
        null,
        request === null ? null : h(SessionActionDialog, { key: request.kind + request.sessionId, request, t }),
        h(UpdateNotice, { key: "update", t })
      );
    }

    /** One confirmation, keyed by the row it belongs to. */
    function SessionActionDialog({ request, t }) {
      const dialogRef = React.useRef(null);
      const busyRef = React.useRef(false);
      const [busy, setBusy] = React.useState(false);
      const [stopPhase, setStopPhase] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [errorCode, setErrorCode] = React.useState(null);
      const [result, setResult] = React.useState(null);
      busyRef.current = busy;

      const close = () => {
        if (busyRef.current) return;
        setPending(null);
      };

      React.useEffect(() => {
        const element = dialogRef.current;
        if (element === null) return undefined;
        const previous = document.activeElement;
        element.focus();
        const onKeyDown = (event) => {
          if (event.key === "Escape" && !event.shiftKey) {
            event.preventDefault();
            if (!busyRef.current) setPending(null);
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = element.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]'
          );
          if (focusable.length === 0) {
            event.preventDefault();
            element.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
          document.removeEventListener("keydown", onKeyDown, true);
          if (previous instanceof HTMLElement && document.contains(previous)) {
            previous.focus({ preventScroll: true });
          }
        };
      }, []);

      /** Report one Host refusal, keeping the pieces the dialog can act on. */
      const fail = (payload) => {
        setBusy(false);
        setStopPhase(false);
        setError(typeof payload?.message === "string" ? payload.message : t("error.fallback"));
        setErrorCode(typeof payload?.code === "string" ? payload.code : null);
      };

      const confirm = () => {
        if (request.kind === "stop") return stop();
        return remove(false);
      };

      const stop = () => {
        setBusy(true);
        setError(null);
        setErrorCode(null);
        callHost(STOP_PATH, { sessionId: request.sessionId })
          .then((payload) => {
            if (payload.ok !== true) {
              fail(payload);
              return;
            }
            setBusy(false);
            const kinds = Array.isArray(payload.stopped) ? payload.stopped.join("、") : "";
            setResult(payload.idle === true ? t("stop.idle") : t("stop.done", { kinds }));
          })
          .catch((reason) => fail({ message: reason instanceof Error ? reason.message : String(reason) }));
      };

      const remove = (stopActivity) => {
        setBusy(true);
        setStopPhase(stopActivity);
        setError(null);
        setErrorCode(null);
        callHost(DELETE_PATH, { sessionId: request.sessionId, stopActivity })
          .then((payload) => {
            if (payload.ok === true) {
              leaveDeletedView(request.sessionId);
              setPending(null);
              return;
            }
            fail(payload);
          })
          .catch((reason) => fail({ message: reason instanceof Error ? reason.message : String(reason) }));
      };

      const stopping = request.kind === "stop";
      const title = t(stopping ? "stop.title" : "confirm.title");
      const description = t(stopping ? "stop.desc" : "confirm.desc", {
        title: request.displayTitle ?? request.sessionId
      });
      const busyText = request.kind === "stop"
        ? t("stop.pending")
        : stopPhase
          ? t("confirm.stopping")
          : t("confirm.pending");

      return h(
        React.Fragment,
        null,
        h("style", { key: "style" }, DIALOG_CSS),
        h(
          "div",
          { className: "dsd-root", role: "presentation", key: "layer" },
          h("div", { className: "dsd-mask", "aria-hidden": "true", onClick: close }),
          h(
            "div",
            {
              ref: dialogRef,
              tabIndex: -1,
              className: "dsd-dialog",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": title
            },
            h(
              "div",
              { className: "dsd-content" },
              h(
                "div",
                { className: "dsd-header" },
                h("h2", { className: "dsd-title" }, title),
                h(
                  "button",
                  { type: "button", className: "dsd-close", "aria-label": t("close"), onClick: close },
                  h(CloseIcon, null)
                )
              ),
              result === null ? h("p", { className: "dsd-description" }, description) : h("p", { className: "dsd-description" }, result),
              busy ? h("div", { className: "dsd-status", role: "status" }, busyText) : null,
              error === null ? null : h("div", { className: "dsd-error", role: "alert" }, error)
            ),
            h(
              "div",
              { className: "dsd-footer" },
              h(
                "button",
                { type: "button", className: "dsd-button dsd-outline", disabled: busy, onClick: close },
                result === null ? t("cancel") : t("close")
              ),
              result !== null ? null : h(
                "button",
                {
                  type: "button",
                  className: stopping ? "dsd-button dsd-outline" : "dsd-button dsd-outline dsd-danger",
                  disabled: busy,
                  onClick: confirm
                },
                stopping ? t("stop.action") : t("confirm.action")
              ),
              result === null && stopping === false && STOPPABLE.includes(errorCode)
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "dsd-button dsd-outline dsd-danger",
                      disabled: busy,
                      onClick: () => remove(true)
                    },
                    t("confirm.stopAndDelete")
                  )
                : null
            )
          )
        )
      );
    }

    /** The dismissible update notice; nothing renders while there is no update. */
    function UpdateNotice({ t }) {
      const { updateState: state, installState: install } = useUpdate();
      const version = state?.latest ?? null;
      if (state?.available !== true || version === null || dismissed === version) return null;
      return h(
        React.Fragment,
        null,
        h("style", { key: "style" }, NOTICE_CSS),
        h(
          "div",
          { className: "dsd-notice", role: "status", key: "notice" },
          h("div", { className: "dsd-notice-title" }, t("update.title")),
          h(
            "div",
            { className: "dsd-notice-desc" },
            install.message ?? t("update.desc", { current: state.current ?? "?", latest: version })
          ),
          install.error === null ? null : h("div", { className: "dsd-notice-error", role: "alert" }, install.error),
          h(
            "div",
            { className: "dsd-notice-actions" },
            h(
              "button",
              {
                type: "button",
                className: "dsd-button dsd-outline",
                disabled: install.running === true,
                onClick: () => dismiss(version)
              },
              t("update.later")
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsd-button dsd-outline",
                disabled: install.running === true || install.message !== null,
                onClick: () => {
                  setInstall({ running: true, message: null, error: null });
                  callHost(UPDATE_INSTALL_PATH, { version })
                    .then((payload) => {
                      if (payload.ok !== true) {
                        setInstall({ running: false, error: typeof payload.message === "string" ? payload.message : t("error.fallback") });
                        return;
                      }
                      setInstall({
                        running: false,
                        error: null,
                        message: payload.restartRequired === false
                          ? t("update.applied", { version })
                          : t("update.installed", { version })
                      });
                    })
                    .catch((reason) => {
                      setInstall({ running: false, error: reason instanceof Error ? reason.message : String(reason) });
                    });
                }
              },
              install.running === true ? t("update.pending") : t("update.action")
            )
          )
        )
      );
    }

    /* --------------------------------------------------------------- plugin */

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        runtimeCtx = ctx;
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "session-delete: dictionaries");
        ctx.slots.inject(MENU_SLOT, function* () {
          yield ctx.slots.register(
            { name: MENU_SLOT, id: "session-delete-stop", order: STOP_ORDER, locale: NS },
            StopSessionMenuItem
          );
          yield ctx.slots.register(
            { name: MENU_SLOT, id: "session-delete", order: DELETE_ORDER, locale: NS },
            DeleteSessionMenuItem
          );
        });
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: "session-delete", locale: NS }, SessionDeleteOverlay)
        );
        /* The detail is also the only evidence a log can carry that THIS bundle
           generation mounted: the Host half logs it verbatim. */
        void callHost(CLIENT_READY_PATH, {
          detail: `features=stop,delete,update+menu=${MENU_SLOT},overlay=${OVERLAY_SLOT}`
        }).catch(() => {});
        void refreshUpdateState();
        ctx.effect(() => {
          const timer = setInterval(() => {
            void refreshUpdateState();
          }, UPDATE_POLL_MS);
          /* Maintenance polling must never hold a process open; browsers have no unref. */
          timer.unref?.();
          return () => {
            clearInterval(timer);
          };
        }, "session-delete: update polling");
      }
    };
  }
});
