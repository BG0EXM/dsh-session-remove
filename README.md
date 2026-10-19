# dsh-session-remove

**Stop and permanently delete sessions from the DeepSeek Harness sidebar — plus a notice when a new release is out.**
**给 DeepSeek Harness 侧栏的会话菜单补上「停止」与「删除」，并在有新版本时提示更新。**

[中文](#中文) · [English](#english)

---

<a id="中文"></a>

## 中文

**版本：1.0.5 ｜ 更新：2026-10-19**

DSH 的会话行菜单只有 **重命名 / 分叉 / 归档** —— 归档只是把会话藏起来，日志一个字节都没少；
而想停掉一个会话的工作，你得先打开它、再按停止。这个插件把这两件事都放回你最常点的位置
（会话行的 `⋯` 菜单）。

```
⋯ 菜单 → 停止会话…     取消运行中的回合、子代理、后台任务与定时提醒
        → 删除会话…     永久删除该会话的本地数据（不可恢复）
```

安装后不需要重启 DSH，也不需要刷新页面。

### 为什么不是又一个 DOM 补丁

同类插件普遍靠注入 DOM 或沿 React fiber 取行数据来塞菜单项，核心 UI 一改就可能失效。
本插件走的是官方开放的扩展点：

- 菜单项注册进官方 slot **`sidebar.workspaces.session.menu.item`** ——
  Pin / Rename / Fork / Archive 本身就是这个 slot 里的注册项，插件行按 `order` 排序；
- 停止走官方的 **`workspace/session-stop`** 准入（`ctx.workspaceRegistry.stopSessionActivity()`），
  由 `dsh-agent` / `dsh-subagent` / `dsh-jobs` / `dsh-schedule` 四个 provider 分别停掉回合、子代理、后台任务与提醒；
- 删除通过 **`ctx.workspaceRegistry`** 与 **`storageDomain`** 的公开 API 完成，不 shell 出 `rm`；
- 删完 emit 官方事件 **`api-session/removed`**（会话被销毁时会话控制器自己发的那条），侧栏该行当帧消失；
- 只删能自证身份的目录：日志路径由持久化后端的 `locate()` 给出，并要求 `basename(dir) === sessionId`，
  否则直接拒绝而不是猜。

### 安装

```sh
# 桌面版：侧栏 → 插件 → 添加插件 → 填包名
dsh-session-remove

# 其它 profile（web / tui / 自建）
dsh plugin --profile web add dsh-session-remove
```

> **中国用户注意**：如果你的 npm 默认源是 `registry.npmmirror.com`，新发布的包在镜像上可能有
> **同步延迟**。若安装时报「`declares no dsh.bundle`」，请在安装对话框里把**安装源**改成
> **npm 官方源**，或改用 tarball 地址：
> `https://registry.npmjs.org/dsh-session-remove/-/dsh-session-remove-<版本号>.tgz`

升级：本插件带更新提示（见下），也可以在插件页卸载后重新安装。

### 用法

鼠标移到侧栏任意会话行 → 点 **⋯**：

| 菜单项 | 做什么 |
|---|---|
| **停止会话…** | 取消运行中的回合，并停掉该会话的子代理、后台任务与定时提醒 |
| **删除会话…** | 永久删除该会话的本地数据 |

**停止的一个要点**：这条停止路径与归档用的是同一条（`workspace/session-stop`），
它**丢弃排队中的输入**（界面上的停止按钮会保留）。确认框里写明了这一点。

**删除**遇到仍在跑的工作时，弹窗会说明原因并多给一个 **停止并删除** 按钮，一步完成。

### 删除的是什么

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/sessions/<项目>/<会话id>/` | 会话日志（`session.v4.jsonl.zstd`）与写租约，整个目录移除 |
| `$DSH_HOME/sessions/<项目>/<子代理会话id>/` | 该会话名下**每一层子代理 / 团队会话**的日志与写租约，同样整目录移除 |
| `session_projcache` 存储域 | 该会话及每个子代理会话的投影检查点记录 |
| `$DSH_HOME/storages/workspace.json` | 工作区成员位置、置顶、归档记录 |
| 可选：会话工作区里的新建文件 | 勾选「同时删除本会话产生的文件」后，删除会话创建之后新建的文件，并移除因此变空的目录 |
| 可选：`$DSH_HOME/attachments/v1/objects/…` | 同一勾选会回收**只被该会话引用**的内容寻址附件对象；仍被其它会话引用的附件保留 |
| 页面 | `api-session/removed` 事件让该行立即消失，无需刷新 |

子代理会话是**独立的存储会话**：它们的目录和父会话并排放在同一个项目目录下，一旦父会话
被删，侧栏、搜索和子代理寻址就都够不到它们了，所以删除必须连带清理。可以按需关闭：

```yaml
- id: session-remove
  name: 'dsh-session-remove'
  config:
    deleteSubagentSessions: false   # 默认 true；关闭后只删选中的会话
```

**分叉会话不连带删除**：fork 产生的会话虽然也带 `parentSession`，但它是独立对话，不会随源会话消失。

**工作区文件与附件默认不动，可显式勾选清理**。工作区是项目目录，可能被多个会话共用，附件按哈希
跨会话去重，因此这两类数据不会被默认删除。删除对话框会先询问宿主，并在存在候选时给出带数量的选项：

- 「同时删除本会话产生的文件（N 个工作区文件、M 个附件）」——默认**不勾选**；
- 勾选后只删除**会话创建之后新建**的工作区文件（已存在的文件即使被覆盖也不会删），
  然后移除因此变空的目录；
- 附件只回收**不再被任何其它持久化会话引用**的对象；枚举失败或其它会话超过 64 个时跳过并告警；
- 想让它每次都自动执行（不再询问），配置 `deleteSessionFiles: always`；完全不清理用 `off`：

```yaml
- id: session-remove
  name: 'dsh-session-remove'
  config:
    deleteSessionFiles: confirm   # confirm（默认）| always | off
```

搜索索引不需要额外处理：它按持久化列表对账，会话从列表消失即被清理。

### 安全边界

| 情况 | 行为 |
|---|---|
| 仍有回合 / 子代理 / 后台任务 / 定时提醒 | 拒绝，并提供「停止并删除」 |
| 停止后仍在收尾（有界等待内未清零） | 拒绝，提示稍候再试 |
| 某个子代理会话仍在运行 | 先停止并等待；收尾不过来则拒绝，父会话的文件此时一个都还没动 |
| 会话仍被进程持有 | 先释放它再删（见下） |
| 释放后的持久化屏障失败 | 拒绝，避免活句柄把刚删的日志写回来 |
| 子代理会话定位失败 | 父会话照常删除，对话框报告哪些子代理数据没清掉 |
| 无法枚举子代理会话（存储列表读取失败） | 拒绝，避免只删掉一半数据 |
| 工作区文件候选 | 仅在显式勾选（或 `always`）时删除；扫描按创建时间归属，已存在的文件绝不删除 |
| 附件仍被其它会话引用 | 保留，不回收 |

**为什么删除前要先释放**：一个还活着的写句柄会在下一次 flush 时把刚删掉的日志重新创建出来。
注册表的归档流程把释放交给会话的登记方，而 seam 没给第三方留受支持的入口，所以插件调用
存储服务的公开方法 `detachEntered(entry)`，并在删除文件前跑一次持久化屏障：

```
释放会话 → 停止工作 → 等待清零 → flush 屏障 → 删除文件
```

两处顺序都不能颠倒：**先释放再停止**，否则被停止的会话会唤醒 agent 去处理被杀任务的结果、
甚至重新启动新的工作，那份新工作会活过删除变成孤儿；**先释放再删文件**，否则写句柄会把日志写回来。
取不到释放凭据（不同版本）时会退化为拒绝并提示先切换会话——功能降级，但绝不会留下半删状态。

每个子代理会话也走同一条链路：先停掉并等它清零、释放它，再随父会话的文件一起删除；
任何一个子代理会话还在跑或还持有写句柄，都会在父会话的文件被碰之前拒绝掉。
删除父会话后若有子代理数据没能清掉，对话框会明确列出会话 id，不会假装全部成功。

> 删除**当前正在查看**的会话后，主区域会自动回到空状态（与官方归档当前会话的行为一致），
> 不会停在已经不存在的旧页面。

### 更新提示

插件会定期问一次注册表（默认 npm 官方源，失败回退 npmmirror）自己是不是最新版。
**只提示，不静默替换**：右下角出现一条可关闭的提示，点「更新」才通过 profile 自己的插件管理器
安装。替换已安装的包需要重启才能加载新的宿主模块，所以提示里会写明「重启后生效」。

包名取自自身的 `package.json`，默认即可工作；只有把包部署成别名时才需要覆盖 `updatePackageName`。

### 配置

所有字段都是可选的，写在插件行的 `config` 下：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `deleteSubagentSessions` | `true` | 删除会话时连带删除其名下所有子代理 / 团队会话；`false` 只删选中的会话 |
| `deleteSessionFiles` | `confirm` | 工作区文件与附件清理策略：`confirm`（弹窗勾选）、`always`（每次自动）、`off`（从不）；也接受 `true`（等于 `always`）与 `false`（等于 `off`） |
| `updateMode` | `notify` | `notify` 只提示新版本；`off` 关闭更新检查 |
| `updateRegistry` | `https://registry.npmjs.org/` | 更新检查使用的注册表 |
| `updateFallbackRegistry` | `https://registry.npmmirror.com/` | 主注册表失败时的回退 |
| `updateIntervalMs` | `21600000`（6 小时） | 检查间隔，最小 `60000`（1 分钟） |
| `updatePackageName` | 自身包名 | 仅在以别名发布时需要覆盖 |
| `stopWaitMs` | `10000` | 停止后等待工作清零的上限（毫秒），最小 `500` |
| `logPath` | `$DSH_HOME/plugin-session-remove.log` | 调试日志路径 |
| `debugLog` | `true` | 设为 `false` 关闭调试日志 |

### 工作原理

| 半边 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | 在 `/api` 鉴权围栏内注册 7 条精确 Fetch 路由：`session-delete.delete` / `.inspect` / `.stop` / `.update-state` / `.install-update` / `.client-ready` / `.status` |
| Client | `client.js` | 注册两个菜单项与一个 `shell.overlay` 条目（确认框 + 更新提示），中英双语跟随界面语言 |

浏览器半与宿主半同源通信，凭据由浏览器会话自动携带。

### 兼容性

- 实测 DSH **0.2.0-rc.2** 与 **0.2.1-rc.1**（DeepSeek Harness Desktop）
- 0.2.1-rc.1 的宿主 API、持久化 `locate/stat/list/flush`、workspace 注册表与客户端 slot 契约均未破坏性变化；
  其中官方在同一菜单新增了 `session-id` 行（order 450），本插件的「停止」放在 460、「删除」保持 500
- DSH 的插件兼容性门禁按**预发布版本也参与匹配**（`includePrerelease`）评估 peer 范围，
  因此 `>=0.2.0-rc.2 <0.3.0` 已覆盖 0.2.1-rc.1，不需要为每个 rc 版本改 peerDependencies
- 需要组合里存在 `connection` / `sessionPersistence` / `workspaceRegistry`（Web profile 默认满足）
- 零依赖、零构建

### 排查

插件会写一行/次操作到 `$DSH_HOME/plugin-session-remove.log`：

```
host half active (build r5-unified@1.0.0, 7 routes, update mode notify)
client half mounted (features=stop,delete,update+menu=sidebar.workspaces.session.menu.item,overlay=shell.overlay)
update check: current 1.0.0, latest 1.0.1 (update available)
stop session-…: asked job (settled: true)
released session-… from the live store
found 2 subagent session(s) under session-…
session files for session-…: 1 workspace file(s), 1 dir(s), 1 attachment(s)
deleted session-… (+2 subagent sessions +3 session files) (session-dir:…, projection-cache)
refused session-…: session-held
```

- 没有 `client half mounted` → 页面半没装载（检查插件是否启用、页面是否刷新过）
- `refused <id>: <code>` → 宿主拒绝了这次操作，代码含义见「安全边界」
- 安装时报 `declares no dsh.bundle` → 见「安装」里的镜像同步说明

### 已知限制

- **删除不可恢复**：没有回收站，也没有撤销。
- 子代理会话默认随父会话一并删除；用 `deleteSubagentSessions: false` 可关闭这一连带行为。
- 分叉会话是独立对话，删除源会话**不会**删掉它（即使它带 `parentSession`）。
- 子代理会话清理失败时父会话仍然会被删除（用户的主要意图已完成），残余目录只能在磁盘上手工处理；对话框会列出会话 id。
- 工作区清理是**按创建时间的启发式归属**：会话期间被覆盖的已有文件不会被删除（只会留下新内容），
  扫描有 2 万条目上限，超出部分会跳过并告警。
- 附件是内容寻址去重的；只有确认不再被其它会话引用的对象才会回收，被共享的附件保留。
- 删除**正被界面打开**的会话时会被先释放（主区域回到空状态）。
- 「停止」会丢弃排队中的输入，这是它所复用的官方停止路径的语义。
- 更新需要重启才生效；旧版本的宿主模块会一直留在内存里直到重启。

### 测试

测试不随 npm 包分发（`files` 白名单中没有 `test/`），安装后的插件目录不含测试文件。

---

<a id="english"></a>

## English

**Version: 1.0.5 | Updated: 2026-10-19**

DeepSeek Harness's session row menu only offers **Rename / Fork / Archive** — archiving hides a
session but keeps every byte on disk, and stopping a session's work means opening it first and
pressing Stop. This plugin puts both back where you already click: the session row's `⋯` menu.

```
⋯ menu → Stop Session…     cancels the running turn, subagents, background jobs and reminders
       → Delete Session…   permanently removes that session's local data (no undo)
```

No DSH restart and no page reload needed after installing.

### Why not another DOM patch

Comparable plugins inject DOM nodes or walk React fibers to add a menu row, so a change to the
core UI can break them. This one uses open extension points only:

- the row registers into the official slot **`sidebar.workspaces.session.menu.item`** —
  Pin / Rename / Fork / Archive are registered entries in that same slot, so a plugin row is
  ordered by its own `order`;
- stopping goes through the official **`workspace/session-stop`** admission
  (`ctx.workspaceRegistry.stopSessionActivity()`), answered by `dsh-agent` / `dsh-subagent` /
  `dsh-jobs` / `dsh-schedule` for the turn, subagents, background jobs and reminders;
- deleting uses the public **`ctx.workspaceRegistry`** and **`storageDomain`** APIs — it never
  shells out to `rm`;
- the deletion emits the official **`api-session/removed`** event (the one the Session controller
  itself emits when a live Session is disposed), so the row disappears on the spot;
- only a directory that can prove its identity is removed: the log path comes from the persistence
  backend's `locate()`, and `basename(dir) === sessionId` must hold, or the plugin refuses instead
  of guessing.

### Install

```sh
# Desktop: sidebar → Plugins → Add plugin → enter the package name
dsh-session-remove

# Other profiles (web / tui / custom)
dsh plugin --profile web add dsh-session-remove
```

> **Behind the npmmirror registry?** A freshly published package can lag on the mirror. If the
> install refuses with `declares no dsh.bundle`, switch **Install source** to the official npm
> registry in the dialog, or install the tarball URL
> `https://registry.npmjs.org/dsh-session-remove/-/dsh-session-remove-<version>.tgz`.

Upgrading: this plugin offers an update notice (below), or uninstall and reinstall in the Plugins
page.

### Usage

Hover any session row in the sidebar → click **⋯**:

| Menu row | What it does |
|---|---|
| **Stop Session…** | cancels the running turn and stops that session's subagents, background jobs and reminders |
| **Delete Session…** | permanently removes that session's local data |

**One thing to know about stopping**: this is the same path archive uses
(`workspace/session-stop`), and it **discards queued input** (the in-conversation stop button keeps
it). The confirmation dialog says so.

When a **delete** meets running work, the dialog explains why and offers a **Stop and delete**
button that does both in one step.

### What gets deleted

| Location | Content |
|---|---|
| `$DSH_HOME/sessions/<project>/<session-id>/` | the session log (`session.v4.jsonl.zstd`) and its write lease — the whole directory |
| `$DSH_HOME/sessions/<project>/<subagent-session-id>/` | the log and write lease of **every subagent / teammate session beneath it**, at any depth — likewise the whole directory |
| the `session_projcache` storage domain | the projection checkpoint record of the session and of each subagent session |
| `$DSH_HOME/storages/workspace.json` | workspace membership, pin and archive entries |
| opt-in: files the session created in its workspace | with the dialog's "also delete the files this session produced" checked, files created after the session started are removed, then the directories they leave empty |
| opt-in: `$DSH_HOME/attachments/v1/objects/…` | the same choice reclaims content-addressed attachment objects **referenced only by that session**; objects another session still references are kept |
| the page | the `api-session/removed` event removes the row without a reload |

A subagent session is a **separate stored Session**: its directory is a sibling of its parent's
under the same project directory, and once the parent is deleted the sidebar, search and subagent
addressing can no longer reach it — so the deletion has to take it along. Opt out per profile:

```yaml
- id: session-remove
  name: 'dsh-session-remove'
  config:
    deleteSubagentSessions: false   # default true; then only the selected session is deleted
```

**Forks are not cascaded**: a forked conversation also records `parentSession`, but it is an
independent conversation and survives its source.

**Workspace files and attachments are left alone by default, and cleaning them is an explicit
choice.** A workspace is a project directory that other sessions may share, and attachments are
deduplicated by content hash across sessions, so neither is removed implicitly. The delete dialog
asks the Host for candidates and offers a counted option:

- "Also delete the files this session produced (N workspace files, M attachments)" — **unchecked**
  by default;
- when checked, only files **created after the session started** are removed (a pre-existing file
  is never deleted, even if the session overwrote its contents), then the directories they leave
  empty;
- attachment objects are reclaimed only when **no other stored session references them**; when the
  other sessions cannot be enumerated, or there are more than 64 of them, the sweep is skipped with
  a warning;
- make it automatic with `deleteSessionFiles: always`, or keep it off entirely with `off`:

```yaml
- id: session-remove
  name: 'dsh-session-remove'
  config:
    deleteSessionFiles: confirm   # confirm (default) | always | off
```

The search index needs no help: it reconciles against the persistence listing, so a session that
leaves that listing leaves the index too.

### Safety boundaries

| Situation | Behaviour |
|---|---|
| A turn / subagent / background job / reminder is still running | refused, with a **Stop and delete** action |
| The stop has not settled within the bounded wait | refused, asking you to retry in a moment |
| A subagent session is still running | stopped and awaited first; if it does not settle, refused before any parent file is touched |
| The session is still held by this process | released first, then deleted (below) |
| The durability barrier after a release fails | refused, so an open handle cannot rewrite a removed log |
| A subagent session cannot be located | the parent is still deleted; the dialog names the subagent data that was left |
| Subagent sessions cannot be enumerated (the persistence listing fails) | refused, so the parent is never deleted while unknown children remain |
| Workspace-file candidates | deleted only after an explicit check (or `always`); attribution is by creation time and pre-existing files are never deleted |
| An attachment another session still references | kept, never reclaimed |

**Why a held session is released first**: a live write handle would flush the log back into
existence right after we removed it. The registry's archive flow relies on the Session's own owner
to release it, and the seam gives third-party plugins no supported way to do that, so the plugin
calls the storage service's public `detachEntered(entry)` and runs a durability barrier before
touching any file:

```
release the session → stop its work → wait for it to settle → flush barrier → remove files
```

Neither order may be swapped: **release before stopping**, or the stopped session wakes its agent to
consume the killed job's result and can even start new work — which would outlive the deletion as an
orphan; **release before removing files**, or the write handle recreates the log. When the release
credential is unavailable (a different DSH version), the plugin degrades to refusing and asking you
to switch sessions — never a half-deleted state.

Every subagent session follows the same pipeline: stop it, wait for it to settle, release it, then
remove its files together with the parent's. A subagent that is still running or still holds a write
handle refuses the whole deletion before any parent file is touched. If some subagent data cannot
be cleaned up after the parent is gone, the dialog names the session ids instead of pretending
everything succeeded.

> Deleting the session the main area is showing clears that view (the same thing the built-in
> archive does for the current session), so you never sit on a conversation that no longer exists.

### Update notice

The plugin periodically asks the registry (official npm first, npmmirror as fallback) whether a
newer version exists. It **only reports**: a dismissible notice appears in the bottom-right corner
and nothing is replaced until you click **Update**, which installs through the profile's own plugin
manager. Replacing an installed package needs a restart to load a fresh Host module generation, so
the notice says so.

The package name comes from the plugin's own `package.json`, so it works with no configuration;
`updatePackageName` only matters if you deploy it under an alias.

### Configuration

Every field is optional and goes under the plugin row's `config`:

| Field | Default | Meaning |
|---|---|---|
| `deleteSubagentSessions` | `true` | delete every subagent / teammate session beneath the session too; `false` removes only the selected session |
| `deleteSessionFiles` | `confirm` | workspace-file and attachment policy: `confirm` (offer it in the dialog), `always` (every delete), `off` (never); `true` is accepted as `always` and `false` as `off` |
| `updateMode` | `notify` | `notify` only reports a newer release; `off` disables the update check |
| `updateRegistry` | `https://registry.npmjs.org/` | registry used by the update check |
| `updateFallbackRegistry` | `https://registry.npmmirror.com/` | tried when the primary registry fails |
| `updateIntervalMs` | `21600000` (6 hours) | check interval; minimum `60000` (1 minute) |
| `updatePackageName` | the package's own name | only needed when deployed under an alias |
| `stopWaitMs` | `10000` | upper bound, in milliseconds, on waiting for stopped work to clear; minimum `500` |
| `logPath` | `$DSH_HOME/plugin-session-remove.log` | diagnostic log path |
| `debugLog` | `true` | set `false` to turn the diagnostic log off |

### How it works

| Half | File | Responsibility |
|---|---|---|
| Host | `index.js` | seven exact Fetch routes inside the `/api` authentication fence: `session-delete.delete` / `.inspect` / `.stop` / `.update-state` / `.install-update` / `.client-ready` / `.status` |
| Client | `client.js` | two menu rows and one `shell.overlay` entry (confirmations + update notice), bilingual, following the UI language |

The browser half talks to the Host half same-origin; the browser session carries the credentials.

### Compatibility

- verified against DSH **0.2.0-rc.2** and **0.2.1-rc.1** (DeepSeek Harness Desktop)
- 0.2.1-rc.1 did not break the Host APIs, persistence `locate/stat/list/flush`, the workspace
  registry or the client slot contract; the one visible change is a shipped `session-id` row at
  menu order 450, so this plugin's stop row sits at 460 and its delete row stays at 500
- DSH's plugin compatibility gate evaluates peer ranges with **prereleases included**
  (`includePrerelease`), so `>=0.2.0-rc.2 <0.3.0` already covers 0.2.1-rc.1 and needs no bump per rc
- needs `connection` / `sessionPersistence` / `workspaceRegistry` in the composition (the Web
  profile provides all three)
- zero dependencies, no build step

### Troubleshooting

The plugin appends one line per event to `$DSH_HOME/plugin-session-remove.log`:

```
host half active (build r5-unified@1.0.0, 7 routes, update mode notify)
client half mounted (features=stop,delete,update+menu=sidebar.workspaces.session.menu.item,overlay=shell.overlay)
update check: current 1.0.0, latest 1.0.1 (update available)
stop session-…: asked job (settled: true)
released session-… from the live store
found 2 subagent session(s) under session-…
session files for session-…: 1 workspace file(s), 1 dir(s), 1 attachment(s)
deleted session-… (+2 subagent sessions +3 session files) (session-dir:…, projection-cache)
refused session-…: session-held
```

- no `client half mounted` → the page half did not load (check that the plugin is enabled and the
  page was refreshed)
- `refused <id>: <code>` → the Host refused; the codes are described under Safety boundaries
- install refusing with `declares no dsh.bundle` → see the registry note under Install

### Known limitations

- **Deletion is permanent**: no trash, no undo.
- Subagent sessions are deleted with their parent by default; `deleteSubagentSessions: false` turns
  that cascade off.
- A forked conversation is independent: deleting its source does **not** delete the fork, even
  though the fork records `parentSession`.
- If a subagent session cannot be cleaned up, the parent is still deleted (the user's main intent
  already succeeded) and the leftover needs manual handling; the dialog lists the session ids.
- Workspace cleanup is a **creation-time heuristic**: a pre-existing file the session overwrote is
  not deleted (its new content stays), the walk is capped at 20,000 entries, and the skipped rest is
  reported.
- Attachments are content-addressed and deduplicated; only objects that no other session references
  are reclaimed, shared ones are kept.
- Deleting the session that is open in the UI releases it first (the main area returns to its empty
  state).
- Stopping discards queued input — that is the semantics of the official stop path it reuses.
- An update needs a restart; the old Host module stays in memory until then.

### Tests

The tests are not part of the npm package (`test/` is not in the `files` whitelist), so an
installed copy of the plugin contains no test files.

---

## License

MIT
