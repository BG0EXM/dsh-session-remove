/**
 * Client-half behaviour tests for `@local/dsh-session-delete`.
 *
 * The Web bundle gets React from the page's browser module table, so this test
 * provides a minimal createElement/hook runtime instead: enough to run the
 * factory, apply the plugin, render both menu rows, the confirmation dialogs
 * and the update notice, click them, and observe the Host calls. It cannot
 * replace looking at the page, but it does catch a component that throws, a
 * wrong slot or option, a missing label, or a wrong request payload.
 *
 *   node --test plugins/dsh-session-delete/test/client.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(HERE, "..", "client.js");

const MENU_SLOT = "sidebar.workspaces.session.menu.item";
const STOP_PATH = "/api/session-delete.stop";
const DELETE_PATH = "/api/session-delete.delete";
const UPDATE_STATE_PATH = "/api/session-delete.update-state";
const UPDATE_INSTALL_PATH = "/api/session-delete.install-update";
const CLIENT_READY_PATH = "/api/session-delete.client-ready";

/* ------------------------------------------------------------- mini React */

const Fragment = Symbol("react.fragment");
let current = null;

function createElement(type, props, ...children) {
  return {
    type,
    props: {
      ...(props ?? {}),
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
    }
  };
}

function useState(initial) {
  const instance = current;
  const index = instance.cursor++;
  if (instance.hooks.length <= index) instance.hooks[index] = typeof initial === "function" ? initial() : initial;
  const set = (value) => {
    instance.hooks[index] = typeof value === "function" ? value(instance.hooks[index]) : value;
  };
  return [instance.hooks[index], set];
}

function useReducer(reducer, initial) {
  const instance = current;
  const index = instance.cursor++;
  if (instance.hooks.length <= index) instance.hooks[index] = typeof initial === "function" ? initial() : initial;
  const dispatch = (action) => {
    instance.hooks[index] = reducer(instance.hooks[index], action);
  };
  return [instance.hooks[index], dispatch];
}

function useRef(initial) {
  const instance = current;
  const index = instance.cursor++;
  if (instance.hooks.length <= index) instance.hooks[index] = { current: initial };
  return instance.hooks[index];
}

const React = {
  Fragment,
  createElement,
  useState,
  useReducer,
  useRef,
  useEffect: () => undefined,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn
};

/** Instance state per component function, so a re-render keeps hook values. */
const instances = new Map();

/** Render an element tree to plain `{ type, props, children }` nodes. */
function render(element) {
  if (element === null || element === undefined || typeof element === "boolean") return null;
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (typeof element.type === "function") {
    let instance = instances.get(element.type);
    if (instance === undefined) {
      instance = { hooks: [], cursor: 0 };
      instances.set(element.type, instance);
    }
    instance.cursor = 0;
    const previous = current;
    current = instance;
    try {
      return render(element.type(element.props ?? {}));
    } finally {
      current = previous;
    }
  }
  const children = (element.props.children ?? []).map(render).flat().filter((child) => child !== null);
  if (element.type === Fragment) return children;
  return { type: element.type, props: element.props, children };
}

/** First rendered node matching a predicate, depth-first. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node === "string") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  return find(node.children ?? [], predicate);
}

/** Every rendered node matching a predicate, depth-first. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "string") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  findAll(node.children ?? [], predicate, out);
  return out;
}

/** Concatenated text of a rendered subtree. */
function text(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return text(node.children ?? []);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Whether a rendered tree contains nothing at all (an empty Fragment renders as []). */
const isEmpty = (node) => find(node, () => true) === null;

/* ------------------------------------------------------------ bundle load */

let captured = null;
const storage = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load: (bundle) => {
      captured = bundle;
    }
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value)
  }
};

await import(pathToFileURL(BUNDLE_PATH).href);

/** Load the plugin the way the page's module loader would. */
function loadPlugin() {
  assert.ok(captured !== null, "the bundle registered itself with the module loader");
  return captured.factory((name) => {
    if (name === "react") return React;
    throw new Error(`unexpected require(${JSON.stringify(name)})`);
  });
}

/** A fake client context that records registrations and exposes services. */
function makeContext(services = {}) {
  const registered = { locales: [], slots: [] };
  const ctx = {
    get: (name) => services[name],
    effect: (factory) => {
      const dispose = factory();
      return typeof dispose === "function" ? dispose : () => {};
    },
    locale: {
      register: (namespace, dictionaries) => {
        registered.locales.push([namespace, dictionaries]);
        return () => {};
      }
    },
    slots: {
      inject: (owner, callback) => {
        const result = callback();
        if (result !== null && typeof result === "object" && typeof result.next === "function") {
          for (const _ of result) {
            /* registrations dispose themselves; nothing to keep here */
          }
        }
        return () => {};
      },
      register: (options, component) => {
        registered.slots.push([options, component]);
        return () => {};
      }
    }
  };
  return { ctx, registered };
}

/**
 * Route the bundle's Host calls through one stub and record them.
 * @param routes - path → `{ payload }` or a function of the decoded body.
 */
function stubHost(routes) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ path, method, body });
    const route = routes[path];
    const payload = typeof route === "function" ? route(body) : route ?? { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

/** Load the plugin, apply it, and return every component it registered. */
async function mount(routes = {}, services = {}) {
  const calls = stubHost({ [UPDATE_STATE_PATH]: { ok: true, mode: "notify", available: false }, ...routes });
  const plugin = loadPlugin();
  const { ctx, registered } = makeContext(services);
  plugin.apply(ctx);
  await tick();
  const menus = registered.slots.filter(([options]) => options.name === MENU_SLOT);
  const overlay = registered.slots.find(([options]) => options.name === "shell.overlay")[1];
  const dictionaries = registered.locales.find(([namespace]) => namespace === "session-delete")[1].zh;
  const t = (key, params) => {
    const template = dictionaries[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
  };
  const byId = (id) => menus.find(([options]) => options.id === id)[1];
  return { calls, registered, overlay, t, byId, stop: byId("session-delete-stop"), remove: byId("session-delete") };
}

/** Render one menu row and press it, which publishes its confirmation request. */
function pressMenu(component, t, sessionId = "session-abc", displayTitle = "旧会话") {
  const tree = render(
    React.createElement(component, {
      sessionId,
      displayTitle,
      useMenuOpenState: () => [true, () => {}],
      t
    })
  );
  const button = find(tree, (node) => node.props?.role === "menuitem");
  assert.ok(button !== null, "renders a role=menuitem button");
  button.props.onClick();
  return tree;
}

/* ------------------------------------------------------------------ tests */

test("bundle registers a plugin that injects slots and locale", () => {
  const plugin = loadPlugin();
  assert.equal(captured.id, "dsh-session-remove", "the factory id equals the package name");
  assert.deepEqual(plugin.inject, ["slots", "locale"]);
});

test("apply registers both dictionaries, both menu rows, and the overlay", async () => {
  const { registered, byId } = await mount();

  const locale = registered.locales.find(([namespace]) => namespace === "session-delete");
  assert.ok(locale !== undefined, "locale namespace registered");
  for (const key of ["menu.stopSession", "menu.deleteSession", "stop.desc", "confirm.desc", "update.desc"]) {
    assert.ok(locale[1].zh[key] !== undefined, `zh dictionary has ${key}`);
    assert.ok(locale[1].en[key] !== undefined, `en dictionary has ${key}`);
  }
  assert.ok(locale[1].zh["confirm.desc"].includes("{title}"), "description interpolates the title");

  const menus = registered.slots.filter(([options]) => options.name === MENU_SLOT);
  assert.deepEqual(menus.map(([options]) => [options.id, options.order]), [
    ["session-delete-stop", 460],
    ["session-delete", 500]
  ]);
  assert.ok(menus.every(([options]) => options.locale === "session-delete"));
  assert.equal(typeof byId("session-delete-stop"), "function");
  assert.equal(typeof byId("session-delete"), "function");

  const overlay = registered.slots.find(([options]) => options.name === "shell.overlay");
  assert.ok(overlay !== undefined, "overlay entry registered");
  assert.equal(overlay[0].locale, "session-delete");
});

test("the page half pings the Host half and reads the update state on apply", async () => {
  const { calls } = await mount();
  assert.deepEqual(
    calls.map((call) => [call.path, call.method]),
    [[CLIENT_READY_PATH, "POST"], [UPDATE_STATE_PATH, "GET"]]
  );
  assert.deepEqual(calls[0].body, {
    detail: `features=stop,delete,update+menu=${MENU_SLOT},overlay=shell.overlay`
  });
});

test("both menu rows are menuitems that close the menu", async () => {
  const { stop, remove, t } = await mount();
  for (const [component, label] of [[stop, "停止会话…"], [remove, "删除会话…"]]) {
    const closed = [];
    const tree = render(
      React.createElement(component, {
        sessionId: "session-abc",
        displayTitle: "旧会话",
        useMenuOpenState: () => [true, (open) => closed.push(open)],
        t
      })
    );
    const button = find(tree, (node) => node.props?.role === "menuitem");
    assert.equal(text(button), label);
    assert.ok(find(tree, (node) => node.props?.role === "separator") !== null, "carries the grouping separator");
    button.props.onClick();
    assert.deepEqual(closed, [false], "dismisses the menu itself");
  }
});

test("the stop dialog asks the Host to stop and reports what was stopped", async () => {
  const { stop, overlay, t, calls } = await mount({
    [STOP_PATH]: { ok: true, stopped: ["turn", "subagent"], idle: false }
  });
  pressMenu(stop, t);
  const dialog = render(React.createElement(overlay, { t }));
  assert.ok(text(dialog).includes("停止此会话的工作"), "shows the stop title");
  assert.ok(text(dialog).includes("旧会话"), "names the session");
  assert.ok(text(dialog).includes("排队中的输入会被丢弃"), "warns about queued input");

  find(dialog, (node) => node.type === "button" && text(node) === "停止").props.onClick();
  await tick();
  const after = render(React.createElement(overlay, { t }));
  assert.ok(text(after).includes("已请求停止：turn、subagent"), "reports the stopped families");
  assert.deepEqual(calls.filter((call) => call.path === STOP_PATH), [
    { path: STOP_PATH, method: "POST", body: { sessionId: "session-abc" } }
  ]);
});

test("the delete dialog deletes and closes on success", async () => {
  const { remove, overlay, t, calls } = await mount({ [DELETE_PATH]: { ok: true, removed: [] } });
  pressMenu(remove, t);
  const dialog = render(React.createElement(overlay, { t }));
  assert.ok(text(dialog).includes("删除此会话？"));
  assert.ok(text(dialog).includes("无法撤销"));

  find(dialog, (node) => node.type === "button" && text(node) === "永久删除").props.onClick();
  await tick();
  assert.deepEqual(calls.filter((call) => call.path === DELETE_PATH), [
    { path: DELETE_PATH, method: "POST", body: { sessionId: "session-abc", stopActivity: false, deleteFiles: false } }
  ]);
  assert.ok(isEmpty(render(React.createElement(overlay, { t }))), "the dialog closes after success");
});

test("a running session's refusal offers 「停止并删除」, which retries with stopActivity", async () => {
  let attempt = 0;
  const { remove, overlay, t, calls } = await mount({
    [DELETE_PATH]: () => {
      attempt += 1;
      return attempt === 1
        ? { ok: false, code: "session-active", message: "该会话仍有正在进行的工作（turn）。", activity: ["turn"] }
        : { ok: true, removed: [] };
    }
  });
  pressMenu(remove, t);
  find(render(React.createElement(overlay, { t })), (node) => node.type === "button" && text(node) === "永久删除").props.onClick();
  await tick();

  const refused = render(React.createElement(overlay, { t }));
  const alert = find(refused, (node) => node.props?.role === "alert");
  assert.equal(text(alert), "该会话仍有正在进行的工作（turn）。");
  const stopAndDelete = find(refused, (node) => node.type === "button" && text(node) === "停止并删除");
  assert.ok(stopAndDelete !== null, "offers the stop-and-delete button");

  stopAndDelete.props.onClick();
  await tick();
  assert.deepEqual(calls.filter((call) => call.path === DELETE_PATH).map((call) => call.body), [
    { sessionId: "session-abc", stopActivity: false, deleteFiles: false },
    { sessionId: "session-abc", stopActivity: true, deleteFiles: false }
  ]);
  assert.ok(isEmpty(render(React.createElement(overlay, { t }))), "the dialog closes once it works");
});

test("a held-session refusal offers no stop button", async () => {
  const { remove, overlay, t } = await mount({
    [DELETE_PATH]: { ok: false, code: "session-held", message: "该会话当前已被打开…" }
  });
  pressMenu(remove, t);
  find(render(React.createElement(overlay, { t })), (node) => node.type === "button" && text(node) === "永久删除").props.onClick();
  await tick();
  const refused = render(React.createElement(overlay, { t }));
  assert.equal(find(refused, (node) => text(node) === "停止并删除"), null);
  assert.ok(text(refused).includes("已被打开"));
});

test("the update notice installs on request and reports the restart", async () => {
  const { overlay, t, calls } = await mount({
    [UPDATE_STATE_PATH]: { ok: true, mode: "notify", available: true, current: "0.1.0", latest: "0.2.0" },
    [UPDATE_INSTALL_PATH]: { ok: true, version: "0.2.0", restartRequired: true }
  });
  const notice = render(React.createElement(overlay, { t }));
  assert.ok(text(notice).includes("有新版本"), "shows the notice title");
  assert.ok(text(notice).includes("当前 0.1.0，最新 0.2.0"), "names both versions");

  find(notice, (node) => node.type === "button" && text(node) === "更新").props.onClick();
  await tick();
  const after = render(React.createElement(overlay, { t }));
  assert.ok(text(after).includes("已安装 0.2.0，重启应用后生效"), "reports the install and the restart");
  assert.deepEqual(calls.filter((call) => call.path === UPDATE_INSTALL_PATH), [
    { path: UPDATE_INSTALL_PATH, method: "POST", body: { version: "0.2.0" } }
  ]);
});

test("the update notice stays hidden when up to date, and 「稍后」 remembers the version", async () => {
  const fresh = await mount({ [UPDATE_STATE_PATH]: { ok: true, mode: "notify", available: false } });
  const quiet = render(React.createElement(fresh.overlay, { t: fresh.t }));
  assert.ok(isEmpty(quiet), "nothing renders while there is no update");

  const { overlay, t } = await mount({
    [UPDATE_STATE_PATH]: { ok: true, mode: "notify", available: true, current: "0.1.0", latest: "0.2.0" }
  });
  find(render(React.createElement(overlay, { t })), (node) => node.type === "button" && text(node) === "稍后").props.onClick();
  assert.ok(isEmpty(render(React.createElement(overlay, { t }))), "dismissed for this version");
  assert.equal(storage.get("dsh-session-remove:update-dismissed"), JSON.stringify("0.2.0"));
});

test("deleting the Session the main area is showing clears that view", async () => {
  const view = [];
  const { remove, overlay, t } = await mount(
    { [DELETE_PATH]: { ok: true, removed: [] } },
    { uiWorkspace: { mainReference: { sessionId: "session-abc" }, clearMain: () => view.push("cleared") } }
  );
  pressMenu(remove, t);
  find(render(React.createElement(overlay, { t })), (node) => node.type === "button" && text(node) === "永久删除").props.onClick();
  await tick();
  assert.deepEqual(view, ["cleared"], "the main area leaves the deleted conversation");
});

test("deleting another Session leaves the main area alone", async () => {
  const view = [];
  const { remove, overlay, t } = await mount(
    { [DELETE_PATH]: { ok: true, removed: [] } },
    { uiWorkspace: { mainReference: { sessionId: "session-other" }, clearMain: () => view.push("cleared") } }
  );
  pressMenu(remove, t);
  find(render(React.createElement(overlay, { t })), (node) => node.type === "button" && text(node) === "永久删除").props.onClick();
  await tick();
  assert.deepEqual(view, []);
});

test("a workspace service without clearMain still leaves the view", async () => {
  const view = [];
  const { remove, overlay, t } = await mount(
    { [DELETE_PATH]: { ok: true, removed: [] } },
    { uiWorkspace: { mainReference: { sessionId: "session-abc" }, startSession: () => view.push("started") } }
  );
  pressMenu(remove, t);
  find(render(React.createElement(overlay, { t })), (node) => node.type === "button" && text(node) === "永久删除").props.onClick();
  await tick();
  assert.deepEqual(view, ["started"]);
});
