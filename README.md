# dsh-session-remove

给 Harness Web 侧栏的**会话「…」菜单**补两个官方没有的能力，外加一个更新提示：

| 菜单项 | 行为 |
|---|---|
| **停止会话…**（order 450） | 走注册表的官方准入 `workspace/session-stop`：取消运行中的回合、停掉子代理 / 后台任务 / 定时提醒 |
| **删除会话…**（order 500） | 永久删除该会话的本地数据；遇到仍在跑的工作时给出「停止并删除」 |
| 更新提示（右下角，可关闭） | 检查到新版本时提示，点「更新」才安装 |

## 为什么这些得由插件补

- **删除**：持久化 seam 的已知限制写着「**无删除或保留接口**——剪枝已存储会话属于带外后端维护」，工作区注册表也把会话删除写成「彼此独立且尚未提供的功能」。
- **停止**：`workspace/session-stop` 准入本身是给归档用的——归档流程先写入归档集、再请各 provider 停止。插件直接请它停止，等于借用同一条停止路径。
- **更新**：插件管理器明确「插件安装后暂不支持自动更新」。宿主里 `ctx.pluginManager.installBundle()` 是公开服务方法，所以插件可以自己发起，但**替换已安装的包需要重启才能加载新的宿主模块**。

## 停止语义（重要）

`workspace/session-stop` 由四个 provider 回答：

| provider | 停什么 |
|---|---|
| `dsh-agent` | 运行中的回合（用户自己的停止方式：`agent.cancel({ kind: 'user' })`） |
| `dsh-subagent` | 该会话的子代理 |
| `dsh-jobs` | 后台任务 |
| `dsh-schedule` | 该会话的定时提醒 |

它与界面停止按钮的区别：**不带 `keepInbox`，排队中的输入会被丢弃**。确认框里写明了这一点。

## 删除范围

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/sessions/<项目>/<会话id>/` | 会话日志 `session.v4.jsonl.zstd` 与写租约，整个目录移除 |
| `session_projcache` 存储域 | 该会话的投影检查点记录 |
| `$DSH_HOME/storages/workspace.json` | 工作区成员位置、置顶、归档记录 |
| 页面 | emit `api-session/removed`，该行立即消失，无需刷新 |

搜索索引不用管：它在 web profile 里是内存库，会按持久化列表自动对账。

## 会被拒绝的情况

| 代码 | 含义 | 界面表现 |
|---|---|---|
| `session-active` | 仍有回合/子代理/任务/提醒在跑（含「agent 正在 running」） | 弹窗显示原因 + **停止并删除** 按钮 |
| `session-stopping` | 停止后的有界等待（`stopWaitMs`，默认 10s）内工作仍未清零 | 提示稍候再试（点击按钮可再试） |
| `session-held` | 会话仍被进程持有，且**释放失败** | 提示先切换到别的会话 |
| `session-not-found` | 找不到 | 提示可能已删除 |

### 删除一个仍被进程持有的会话

删除前必须先把会话从活动存储里释放，否则写句柄的下一次 flush 会把刚删掉的日志重新创建出来。注册表的归档流程把这件事交给**会话的登记方**（`enter()` 返回的 detacher），而 seam 没有给第三方插件留受支持的释放入口，所以本插件走的是存储服务的公开方法 `detachEntered(entry)`，entry 取自 `ctx.sessions.store`：

```
释放（detachEntered）→ 停止工作 → 有界等待清零 → flush 持久化屏障 → 删除文件
```

两处顺序都不能颠倒：

- **先释放再停止**：被停止的会话会唤醒 agent 去处理被杀任务的结果，它可以**重新启动新的工作**；如果先停止再释放，那份新工作会活过删除、变成孤儿进程。
- **先释放再删文件**：`detachEntered` 会触发配对的 `session/disposed`，后端在那时做最终排空；写句柄还开着的话会把刚删掉的日志重新创建出来。

若取不到 entry 或该方法不存在（版本漂移），就退回 `session-held` 拒绝并提示切换会话——功能降级，但不会造成半删状态，也不会在删不掉的情况下去动用户正在跑的工作。

删除**正在主区域查看**的会话时，客户端会在成功后清空主区域（调用 `ctx.uiWorkspace.clearMain()`，与官方归档当前会话的行为一致），所以不会留下一个已经不存在、却还停在旧内容的页面。

## 自动更新

- **模式**：`updateMode: 'notify'`（默认，只提示）或 `'off'`。安装永远由界面里的一次点击发起（`POST /api/session-delete.install-update`），不会静默替换代码。
- **检查**：激活时一次，之后每 `updateIntervalMs`（默认 6 小时）。先问 `updateRegistry`（默认 npm 官方源），失败再问 `updateFallbackRegistry`（默认 npmmirror）。
- **包名**：直接读自己的 `package.json`（本地开发名与发布名已统一为 `dsh-session-remove`）；只有在你把包部署成别名字时才需要 `updatePackageName` 覆盖。
- **安装**：调 `ctx.pluginManager.installBundle('<name>@<version>', { enabled: true })`；返回里区分 `application: 'applied'` 与需要重启的情况，界面按结果措辞。
- 维护定时器都 `unref()`，不会拖住宿主进程退出。

## 配置

```yaml
- id: session-remove
  name: 'dsh-session-remove'
  config:
    debugLog: true                                   # 默认 true
    logPath: /absolute/path/to/session-remove.log    # 可选
    updateMode: notify                               # notify | off
    updatePackageName: dsh-session-remove            # 仅当部署名与包名不同才需要
    updateRegistry: https://registry.npmjs.org/
    updateFallbackRegistry: https://registry.npmmirror.com/
    updateIntervalMs: 21600000                      # 6 小时，最小 1 分钟
    stopWaitMs: 10000                               # 停止后等待工作清零的上限
```

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：6 条 `/api/session-delete.*` 路由（delete / stop / update-state / install-update / client-ready / status） |
| `client.js` | Client 半：两个菜单项、一个 `shell.overlay` 条目（确认框 + 更新提示）、中英词典 |
| `cordis.patch.yml` | 组合包补丁，插入 `session-remove` 行 |
| `locale/{zh,en}.json` | 插件管理页的标题与描述 |
| `scripts/build-publish.mjs` | 构建可发布包（见 [PUBLISH.md](PUBLISH.md)） |

## 测试

```sh
node --test test/host.test.mjs test/client.test.mjs     # 35 项
```

Host 测试用模拟 ctx 驱动真实 `apply()`：删除链路、停止链路、`stopActivity` 的三种结局、路径安全护栏、更新检查（命中/未更新/404/安装/无管理器/安装失败）、以及 semver 比较表。
Client 测试用最小 React 运行时真实渲染两个菜单项、两个确认框与更新提示，模拟点击并核对请求载荷与失败文案。

## 调试日志

`$DSH_HOME/plugin-session-remove.log`：

```
host half active (6 routes, update mode notify)
client half mounted (menu=…,overlay=shell.overlay)
update checks on for dsh-session-remove@1.0.0 every 360 min
update check: current 1.0.0, latest 1.0.1 (update available)
stop session-…: asked turn, subagent (agent idle: true)
deleted session-… (session-dir:…, projection-cache)
refused session-…: session-held
```
