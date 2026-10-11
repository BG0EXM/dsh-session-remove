# DEVELOPING — dsh-session-remove

> **English summary** — Architecture, design decisions, configuration, tests and the release flow
> for this plugin. The user-facing documentation is [README.md](README.md) (中文 / English);
> publishing steps are in [PUBLISH.md](PUBLISH.md).

面向维护者：结构、设计取舍、配置项、测试与发布流程。
用户文档在 [README.md](README.md)，发布步骤在 [PUBLISH.md](PUBLISH.md)。

## 结构

```
index.js              Host 半：6 条 /api/session-delete.* 精确 Fetch 路由 + 删除/停止/更新逻辑
client.js             Client 半：两个菜单项 + 一个 shell.overlay 条目（确认框 + 更新提示）
cordis.patch.yml      组合包补丁：插入 session-remove 行
locale/{zh,en}.json   插件管理页卡片的标题与描述
test/host.test.mjs    Host 行为测试（模拟 ctx 驱动真实 apply）
test/client.test.mjs  Client 渲染测试（最小 React 运行时真实渲染并模拟点击）
scripts/build-publish.mjs  生成可发布产物（dist/）
```

两半都在同一个包里：`dsh.bundle.patch` 让包成为组合包，`dsh.client` + `exports["./client"]`
让 Web 端加载浏览器半，客户端 bundle 的模块 id 必须等于包名。

## 设计取舍

**官方 slot，不碰 DOM。** `sidebar.workspaces.session.menu.item` 是 ui-workspace 声明的 list slot，
Pin/Rename/Fork/Archive 本身就是注册项；插件行只需给出 `order` 就能排在归档之后。
同类社区插件的 DOM/fiber 注入在核心 UI 调整时会失效，这里不会。

**浏览器半 → 宿主半走自建 Fetch 路由。** 官方建议的 `ctx.remote.commands.execute()` 要求目标会话
有活跃 agent，而侧栏要操作的通常正好是冷会话，所以改用 `ctx.connection.fetch.register()`
（与官方 UI 插件 `dsh-client-ui-deliverables` 同款），路由落在 `/api` 的鉴权围栏内。

**删除顺序：释放 → 停止 → 等待清零 → flush → 删文件。** 两处顺序都有具体理由：

- *先释放再停止*：`workspace/session-stop` 的取消不等待收敛，被杀的后台任务的结果会唤醒 agent，
  它可以**重新启动新的工作**；若不先释放，新工作会活过删除变成孤儿进程（实测踩过）。
- *先释放再删文件*：写句柄还开着时，下一次 flush 会把刚删掉的日志重新创建出来。

释放用的是存储服务的公开方法 `detachEntered(entry)`，entry 取自 `ctx.sessions.store`——
seam 没有给第三方留受支持的释放入口，因此做了能力检测，取不到就退化为拒绝（`session-held`），
绝不半删。

**维护定时器一律 `unref()`**，包括客户端轮询，避免拖住宿主进程退出。

**构建标记 `BUILD`** 出现在激活日志里（`host half active (build r5-unified@1.0.0, …)`），
因为宿主半不会随源码热重载，必须能从日志分辨跑的是哪一版。包名与版本都从自身
`package.json` 读（`createRequire`），不重复硬编码。

## 配置

```yaml
- id: session-remove
  name: 'dsh-session-remove'
  config:
    debugLog: true                                   # 默认 true
    logPath: /absolute/path/to/session-remove.log    # 可选，覆盖默认日志路径
    updateMode: notify                               # notify | off
    updatePackageName: dsh-session-remove            # 仅当部署名与包名不同才需要
    updateRegistry: https://registry.npmjs.org/
    updateFallbackRegistry: https://registry.npmmirror.com/
    updateIntervalMs: 21600000                       # 6 小时，最小 1 分钟
    stopWaitMs: 10000                                # 删除时等待工作清零的上限
```

## 测试

```sh
node --test test/host.test.mjs test/client.test.mjs     # 41 项
```

- **Host（28 项）**：用模拟 ctx 驱动真实 `apply()`。覆盖删除链路、停止链路、`stopActivity` 的三种结局、
  路径安全护栏、拒绝码、更新检查的每条路径（有新版本 / 无更新 / 404 / 安装 / 无插件管理器 / 安装失败 / 关闭检查），
  以及 semver 比较表（含 `1.0.0-rc.10 > 1.0.0-rc.2` 这类）。测试从 `package.json` 读版本，发版不需要改测试。
- **Client（13 项）**：用最小 React 运行时（createElement + hooks）真实渲染两个菜单项、两个确认框与更新提示，
  模拟点击并核对请求载荷、失败文案、以及「删除当前查看的会话后清空主区域」。

## 本地开发安装

插件页 → 添加插件 → 填**本目录的绝对路径**（以 `link:` 方式装，改 `client.js` 刷新页面即可生效；
改 `index.js` 需要重启应用，宿主半不随源码热重载）。

## 发布

见 [PUBLISH.md](PUBLISH.md)。要点：`node scripts/build-publish.mjs --author … --repo …` 生成 `dist/`，
README 原样复制（仓库与 npm 页面用同一份），然后 `npm publish`。

## 已知坑

- **npmmirror 同步延迟**：新发布会先被镜像抓到占位版本，导致安装器预检报 `declares no dsh.bundle`。
  在安装对话框里把安装源改成 npm 官方源即可（README 的「安装」一节有面向用户的说明）。
- **npm 的 2FA 与暂存发布**：带 2FA 的账号发布时会走 `npm stage publish`（PUT 返回 202），
  需要维护者在浏览器里批准；`npm stage approve` 只接受 TOTP 验证码，通行密钥（passkey）用不了。
- **宿主半的模块不会热重载**：改 `index.js` 后必须重启应用，日志里的 `build` 标记可用来确认。
