# dsh-session-remove

**给 DeepSeek Harness 侧栏的会话菜单补上「停止」与「删除」，并在有新版本时提示更新。**

DSH 的会话行菜单只有 **重命名 / 分叉 / 归档** —— 归档只是把会话藏起来，日志一个字节都没少；
而想停掉一个会话的工作，你得先打开它、再按停止。这个插件把这两件事都放回你最常点的位置
（会话行的 `⋯` 菜单）。

```
⋯ 菜单 → 停止会话…     取消运行中的回合、子代理、后台任务与定时提醒
        → 删除会话…     永久删除该会话的本地数据（不可恢复）
```

安装后不需要重启 DSH，也不需要刷新页面。

---

## 为什么不是又一个 DOM 补丁

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

## 安装

```sh
# 桌面版：侧栏 → 插件 → 添加插件 → 填包名
dsh-session-remove

# 其它 profile（web / tui / 自建）
dsh plugin --profile web add dsh-session-remove
```

> **中国用户注意**：如果你的 npm 默认源是 `registry.npmmirror.com`，新发布的包在镜像上可能有
> **同步延迟**。若安装时报「`declares no dsh.bundle`」，请在安装对话框里把**安装源**改成
> **npm 官方源**，或改用 tarball 地址：
> `https://registry.npmjs.org/dsh-session-remove/-/dsh-session-remove-1.0.0.tgz`

升级：本插件带更新提示（见下），也可以在插件页卸载后重新安装。

## 用法

鼠标移到侧栏任意会话行 → 点 **⋯**：

| 菜单项 | 做什么 |
|---|---|
| **停止会话…** | 取消运行中的回合，并停掉该会话的子代理、后台任务与定时提醒 |
| **删除会话…** | 永久删除该会话的本地数据 |

**停止的一个要点**：这条停止路径与归档用的是同一条（`workspace/session-stop`），
它**丢弃排队中的输入**（界面上的停止按钮会保留）。确认框里写明了这一点。

**删除**遇到仍在跑的工作时，弹窗会说明原因并多给一个 **停止并删除** 按钮，一步完成。

## 删除的是什么

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/sessions/<项目>/<会话id>/` | 会话日志（`session.v4.jsonl.zstd`）与写租约，整个目录移除 |
| `session_projcache` 存储域 | 该会话的投影检查点记录 |
| `$DSH_HOME/storages/workspace.json` | 工作区成员位置、置顶、归档记录 |
| 页面 | `api-session/removed` 事件让该行立即消失，无需刷新 |

搜索索引不需要额外处理：它按持久化列表对账，会话从列表消失即被清理。

## 安全边界

| 情况 | 行为 |
|---|---|
| 仍有回合 / 子代理 / 后台任务 / 定时提醒 | 拒绝，并提供「停止并删除」 |
| 停止后仍在收尾（有界等待内未清零） | 拒绝，提示稍候再试 |
| 会话仍被进程持有 | 先释放它再删（见下） |

**为什么删除前要先释放**：一个还活着的写句柄会在下一次 flush 时把刚删掉的日志重新创建出来。
注册表的归档流程把释放交给会话的登记方，而 seam 没给第三方留受支持的入口，所以插件调用
存储服务的公开方法 `detachEntered(entry)`，并在删除文件前跑一次持久化屏障：

```
释放会话 → 停止工作 → 等待清零 → flush 屏障 → 删除文件
```

两处顺序都不能颠倒：**先释放再停止**，否则被停止的会话会唤醒 agent 去处理被杀任务的结果、
甚至重新启动新的工作，那份新工作会活过删除变成孤儿；**先释放再删文件**，否则写句柄会把日志写回来。
取不到释放凭据（不同版本）时会退化为拒绝并提示先切换会话——功能降级，但绝不会留下半删状态。

> 删除**当前正在查看**的会话后，主区域会自动回到空状态（与官方归档当前会话的行为一致），
> 不会停在已经不存在的旧页面。

## 更新提示

插件会定期问一次注册表（默认 npm 官方源，失败回退 npmmirror）自己是不是最新版。
**只提示，不静默替换**：右下角出现一条可关闭的提示，点「更新」才通过 profile 自己的插件管理器
安装。替换已安装的包需要重启才能加载新的宿主模块，所以提示里会写明「重启后生效」。

包名取自自身的 `package.json`，默认即可工作；只有把包部署成别名时才需要覆盖 `updatePackageName`。

## 工作原理

| 半边 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | 在 `/api` 鉴权围栏内注册 6 条精确 Fetch 路由：`session-delete.delete` / `.stop` / `.update-state` / `.install-update` / `.client-ready` / `.status` |
| Client | `client.js` | 注册两个菜单项与一个 `shell.overlay` 条目（确认框 + 更新提示），中英双语跟随界面语言 |

浏览器半与宿主半同源通信，凭据由浏览器会话自动携带。

## 兼容性

- 实测 DSH **0.2.0-rc.2**（DeepSeek Harness Desktop）
- 需要组合里存在 `connection` / `sessionPersistence` / `workspaceRegistry`（Web profile 默认满足）
- 零依赖、零构建

## 排查

插件会写一行/次操作到 `$DSH_HOME/plugin-session-remove.log`：

```
host half active (build r5-unified@1.0.0, 6 routes, update mode notify)
client half mounted (features=stop,delete,update+menu=sidebar.workspaces.session.menu.item,overlay=shell.overlay)
update check: current 1.0.0, latest 1.0.1 (update available)
stop session-…: asked job (settled: true)
released session-… from the live store
deleted session-… (session-dir:…, projection-cache)
refused session-…: session-held
```

- 没有 `client half mounted` → 页面半没装载（检查插件是否启用、页面是否刷新过）
- `refused <id>: <code>` → 宿主拒绝了这次操作，代码含义见「安全边界」
- 安装时报 `declares no dsh.bundle` → 见「安装」里的镜像同步说明

## 已知限制

- **删除不可恢复**：没有回收站，也没有撤销。
- 附件是内容寻址去重的，不做按会话回收。
- 删除**正被界面打开**的会话时会被先释放（主区域回到空状态）。
- 「停止」会丢弃排队中的输入，这是它所复用的官方停止路径的语义。
- 更新需要重启才生效；旧版本的宿主模块会一直留在内存里直到重启。

## 开发

架构说明、配置项、测试与发布流程见 [DEVELOPING.md](https://github.com/BG0EXM/dsh-session-remove/blob/main/DEVELOPING.md)。

## License

MIT
