# 发布 `dsh-session-remove`

## 0. 先弄清「发布」在 DSH 里意味着什么

DSH 没有插件市场。所谓发布，就是**发一个 npm 包**，包里有三样东西：

| 声明 | 作用 |
|---|---|
| `dsh.bundle.patch` → `cordis.patch.yml` | 让包成为一个「组合包」；安装时把 `session-delete` 行插入 profile 的组合树 |
| `dsh.client` + `exports["./client"]` | 让 Web 端加载浏览器半（菜单项与弹窗） |
| `exports["."]` | 宿主半（删除路由） |

用户端的安装入口只有两个，都指向同一个 npm 包：

- **桌面版**：侧栏 → 插件 → 添加插件 → 填**包名**（本 profile 由 Electron 独占，CLI 会被拒绝）
- **其它 profile**（web / tui / 自建）：`dsh plugin --profile web add <包名>`

所以「发布」= `npm publish`，之后用户填包名就能装。

## 1. 名字：这个赛道已经很挤了

先查过 npm（2026-10-11）：

| 包名 | 状态 | 说明 |
|---|---|---|
| `dsh-session-delete` | 已占用 | vtxf，0.1.0，会话删除 + 目录级批量归档/删除；菜单靠 **DOM 注入** |
| `dsh-delete-session` | 已占用 | dddmuc，0.1.10，活跃维护；菜单靠 **React fiber 读取 + DOM 克隆** |
| `dsh-session-purge` | 已占用 | verdana，0.4.5，README 明确写了已适配 `0.2.0-rc.2`（与本机运行时一致） |
| `dsh-session-remove` | **空闲** | 已用构建脚本校验过 |
| `dsh-session-delete-plus` | **空闲** | |
| `@<你的npm用户名>/dsh-session-delete` | **必然空闲** | scope 独占，最省心 |

**我们的差异点（值得写进 README 首页）**：前三个社区插件都靠 DOM / React fiber 注入菜单，
核心 UI 一改就可能失效；本插件注册的是官方开放的 slot
（`sidebar.workspaces.session.menu.item`，Pin/Rename/Fork/Archive 本身就是注册项），
删除走 `ctx.workspaceRegistry` + `storageDomain` 的公开 API（不是 `rm` shell），
删完 emit `api-session/removed` 让该行当帧消失，并且有 `basename(dir) === sessionId`
的路径安全护栏。

## 2. 构建可发布的包

源码包名与发布名已经统一为 `dsh-session-remove`，所以 `--name` 可以省略。构建脚本把包
**复制**到 `dist/` 并补上发布才需要的元数据（LICENSE、repository、keywords 等）：

```sh
cd plugins/dsh-session-remove

# 只看看会生成什么
node scripts/build-publish.mjs --author "你的名字 <you@example.com>" --dry-run

# 真正生成到 dist/dsh-session-remove/
node scripts/build-publish.mjs \
  --author "你的名字 <you@example.com>" \
  --repo "https://github.com/yourname/dsh-session-remove" \
  --dsh-peer ">=0.2.0-rc.2 <0.3.0"
```

发布稿的 README 来自模板 [`README.publish.md`](README.publish.md)：脚本会把
`{{name}}` / `{{repo}}` / `{{author}}` / `{{version}}` 渲染成实际值再写进产物，
所以用户看到的是「从 npm 装」的说明，而不是本机的绝对路径。源码目录里那份
[`README.md`](README.md) 是开发/使用说明，不参与发布。

脚本会做四件校验：包名符合 npm 规则、与源码名不同、**npm 上没被占用**（可 `--force` 跳过）、
以及 `exports["./client"]` 与 `cordis.patch.yml` 在产物里真实存在。生成的包不含
`private`，带 `license` / `repository` / `keywords` / `publishConfig`，`files` 白名单保证
`test/`、`scripts/` 不会进 tarball。没给 `--author` / `--repo` 时会打印警告。

## 2.5 先有仓库再发布

本机还没有 git 身份，仓库已经初始化并暂存好（分支 `main`，14 个文件），你只需要：

```sh
cd plugins/dsh-session-remove
git config user.name "你的名字"          # 或用 git config --global
git config user.email "you@example.com"
git commit -m "feat: delete session from the sidebar session menu"
git remote add origin https://github.com/yourname/dsh-session-remove.git
git push -u origin main
```

## 3. 发布

```sh
npm login                      # 本机 npm 10.8.3 目前未登录（npm whoami 报 ENEEDAUTH）
cd plugins/dsh-session-remove/dist/dsh-session-remove
npm publish                    # scoped 包用 npm publish --access public
```

> 提示：`npm` 在受沙箱限制的 shell 里会因无法写 `~/.npm/_cacache` 而报
> 「cache folder contains root-owned files」（这条报错是误导，缓存其实全归你所有，
> 纯属沙箱）。发布请在自己的终端里跑。

## 4. 发布后验证（别跳）

```sh
npm view dsh-session-remove version          # 注册表可见
```

再从一个**非 desktop** 的 profile 真装一次（CLI 只对 desktop 说不）：

```sh
dsh plugin --profile web add dsh-session-remove
dsh --profile web --dump-config | grep -A2 session-delete
```

desktop 侧则回到插件页，把 spec 换成包名再装一次 —— 这一步同时验证了
`pluginManager.inspect` 能识别它是组合包（`not-a-bundle` 之类的诊断会在这里暴露）。

## 5. 升级与兼容

- **没有自动更新**（官方如此），但本插件自带**更新提示**：`updateMode: notify` 时它会定期
  问注册表，发现新版本就在界面右下角提示，点「更新」由 `ctx.pluginManager.installBundle()`
  安装，装完提示重启。包名取自自身的 `package.json`（已统一为 `dsh-session-remove`），
  所以默认就能工作；只有把包部署成别名时才需要覆盖：

  ```yaml
  - id: session-remove
    name: 'dsh-session-remove'
    config:
      updatePackageName: some-other-name   # 仅部署成别名时需要
  ```

  注意重启是必需的：替换已安装的包后，旧宿主模块仍在内存里。
- **发版流程**：改版本号（或 `--version`）→ 重新构建 → `npm publish` → 用户在提示里点更新，
  或在插件页卸载重装（其它 profile 可 `dsh plugin --profile web update <包名>`）。
- **版本门禁**：安装器会在 pnpm 跑之前检查声明的 peer，**只认 `@deepseek-ai/dsh` 和
  `@deepseek-ai/dsh-*`**（`@deepseek-ai/cordis` 之类不参与）。不声明就完全没有这道保险；
  声明了则在不匹配的运行时上以 `incompatible-version` 拒绝安装，并给出
  `dsh plugin allow-version` 的豁免途径。建议声明一个**宽松**范围
  （如 `>=0.2.0-rc.2 <0.3.0`），本机实测 `0.2.0-rc.2` 满足。
  代价：pnpm 会有一条 unmet peer 警告（profile 里 `autoInstallPeers: false`，不会真去装）。
- 每次改完都跑一遍本地测试再发：

  ```sh
  node --test test/host.test.mjs test/client.test.mjs     # 41/41
  ```

## 6. 不发 npm 的三种替代

| 方式 | 用户怎么装 | 注意 |
|---|---|---|
| GitHub 仓库 | 插件页填 `github:yourname/dsh-session-remove` | 带 `prepare` 构建脚本的包需要用户批准 pnpm 的构建授权；本插件零构建，不受影响 |
| Release tarball | 插件页填 tarball URL | 免构建授权，适合内网/离线 |
| 本地路径 | 插件页填绝对路径（就是现在的装法） | 只适合自己或同机同事 |

## 7. 发布前清单

- [ ] 全部测试通过（41/41）
- [ ] `--name` 已被构建脚本确认空闲
- [ ] README 写明**支持的 DSH 版本**（本项目实测 `0.2.0-rc.2`）与「删除不可恢复」
- [ ] 想好与三个既有插件的差异点，写在 README 开头
- [ ] `npm login` 已完成；scoped 包记得 `--access public`
- [ ] 建议初始化 git 仓库并推到 GitHub（`repository` 字段才有意义，也方便用户提 issue）

## 8. 已知功能缺口（发布前可考虑补齐）

- 运行中/已打开的会话被**拒绝**而非「停止后删除」
- 没有回收站 / 撤销（可做「先挪到 `~/.dsh/deleted-sessions/`」的软删除）
- 已归档会话的删除路径只在单元测试里验证过
