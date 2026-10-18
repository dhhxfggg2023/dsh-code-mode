# 变更记录

本文件只记**对使用者可见**的变化。

## 0.1.4 — 2026-10-18

**修复 0.1.3 引入的启动崩溃**：0.1.3 把宿主行名改成裸包名后，`dsh.client` 第一次被
`@deepseek-ai/dsh-client-modules` 读到，`lib/client.js` 第一次真正进入浏览器启动清单。
它的 `apply()` 在 `ctx.slots` 还不存在时就访问 `ctx.slots.inject(...)`，直接抛
`TypeError`；Web 启动审计把**任何**未激活的客户端条目都当成致命错误
（`web boot: N entries did not activate`），于是整个外壳变成「Failed to load plugins」——
桌面端表现为一进 DSH 就崩，必须停掉所有第三方插件才能进入。

- `lib/client.js` 现在声明 `exports.inject = ['slots']`，与所有内置 `settings.section`
  贡献者（`dsh-client-ui-settings-plugins`、`dshmarket`）一致：`slots` 由
  `dsh-client-ui-renderer` 提供，声明依赖后 `apply` 会等它就绪，不会再抢跑；
- `apply()` 整段包了 try/catch：一个设置页再出问题也只损失这一页，不会把整个
  会话黑屏。dshmarket 的 `mountMarket` 也是同样的隔离方式。

验收判据：用 `dsh --profile <测试 profile> --port 0 --no-open` 起一个 Web 实例，
浏览器打开后外壳正常，预设选择器里有「编程模式」（标准 / PTC / 极简 / 创造 / 编程 共五个）。

## 0.1.3 — 2026-10-18

**修复 0.1.2 的设置页根本没出现**：0.1.2 的顶层宿主行名是 `dsh-code-mode/lib/web-routes.js`
（子路径），而 `@deepseek-ai/dsh-client-modules` 只在 Loader 行是**裸包名**（或路径）时才解析该行的
`package.json`（`lib/index.js:765-766` 直接返回）。于是 `package.json` 里的 `dsh.client` 从未被读取，
`lib/client.js` 从未进入启动清单——宿主路由 `/code-mode/ledgers` 照常 200，设置页却永远没有这一节，
重启多少次都一样。这一条不修，0.1.2 的功能等于不存在。

- 宿主行 `code-ledger-admin` 的 `name` 改为裸 `dsh-code-mode`；
- `package.json` 的 `main` 与 `exports["."]` 改指 `./lib/web-routes.js`（`lib/ledger.js` 仍在
  `"./lib/*.js"` 子路径下可导入，预设的 `code-memory` 各行不受影响）；
- `dsh.client.inject` 从已不存在的 `@deepseek-ai/dsh-client-runtime` 改为
  `@deepseek-ai/dsh-client-ui-settings`（0.2.1 里 `settings.section` 的声明者，dshmarket 同款写法）。

验收判据不用打开 GUI：重启后 `GET /plugins/events` 的启动清单里出现 `dsh-code-mode` 条目，
再把该条目的 `rev` 代入 `plugins/??dsh-code-mode/client.js&rev=…` 能取到 JS。

## 0.1.2 — 2026-10-18

**新增「编程模式账本」设置页**：在 DSH 设置页里列出这台机器上的全部账本，按项目分组，
能看到每个账本的健康标记（`store-orphan`、`no-project-root`、`not-pointed-at`、
`central-dangling`、`repo-copy-also-live`、`locked`、`machine`、`trash`），
能读 mistakes / decisions / 任务板 / journal，也能**移入回收站**并恢复。

- **删除默认可逆**：账本是「这个项目付过什么代价」的证据，所以默认动作是 `rename` 到
  旁边 `<名字>.trashed-<时间戳>`（同卷，不会 `EXDEV`），恢复后逐字节一致；
  唯一不可逆的 `purge` 只对回收站里的对象生效，且要**手输目录名**。
- **服务端硬拒**：机器账本（只读、永不可删）、当前工作目录自己的账本、带活锁的账本、
  以及任何不在本次清单里的 id。浏览器只能传服务端发出的 id，永远传不了路径。
- **一条顶层 host 行** `code-ledger-admin`（`lib/web-routes.js`，`inject: ['webServer']`），
  故意不放进 `code-memory` 组——否则设置页只在跑编程模式的会话里存在。
  路由只回答回环来源、校验同源，变更请求要带 `x-code-mode-token`。
- **浏览器半是手写的** `lib/client.js`（`exports["./client"]` + `dsh.client`）：
  用宿主基线模块表里的 `react`，不引入 tsdown/esbuild，本包仍然零构建步骤。
- 判据 `probes/ledger-admin-probe.mjs` 8/8（纯 node，fixture 指到 `os.tmpdir()`）；
  它第一次真跑时抓出三个真缺陷：`CENTRAL` 指向的是**项目**路径而非 store 路径，
  导致所有已迁移项目被误标 `not-pointed-at`；`restore` 把 `trash-manifest.json`
  带回了活账本；仓库账本被移走后，`siblingProjects` 再也看不见它，回收站里的那份无法恢复。
- `debt-audit` 23/23、`build-preset --check` PASS、`guard-probe` 45/45 不变。

## 0.1.1 — 2026-10-17

**兼容 DSH `0.2.1-rc.1`**（自 `0.2.0-rc.2` 升级；只升级 DSH、不升本包会坏）。

- **删掉 persona 的 `suffix: Your working directory is {{cwd}}.`**。0.2.1 起提示词变量**严格插值**，
  只注册 `provider` 与 `model`——`cwd` 被移除，工作目录改由 working-directory 的 runtime
  context 提供。旧写法让本模式**每一轮都在系统提示词组装阶段失败**
  （`unknown prompt variable "{{cwd}}"`，模型一个请求都收不到），而换到别的预设一切正常，
  所以很容易误判成账本或工作区坏了。**这一条不修，模式等于不可用。**
- **补齐 0.2.1 内置 `standard` 新增的三行**：`time-context`、`tool-schedule`、
  `tool-plugin-market`（与内置一致，默认关），维持「standard 严格超集」这条判据。
- `dsh.compatibility.dshReleases` 记入 `0.2.1-rc.1`: `compatible`。

判据（全部跑在 0.2.1-rc.1 运行时上）：`acceptance-probe` 24/24、`gate-probe` 39/39、
`pit-guard-probe` 36/36、`guard-probe` 45/45、`budget-probe` 29/29、`debt-audit` 23/23、
`check-yaml` 与 `build-preset --check` 通过。

## 0.1.0 — 2026-10-16

首个可安装的发布形态：补齐了对标其他 DSH 插件的包字段（`license`、`engines`、
`dsh.engines` / `dsh.compatibility`、`README.md` / `LICENSE` 进 `files`），
`private: true` 保留（不上传插件商店，只走 `link:` 安装）。

**发布范围 = 只有运行时**：仓库里只有 `lib/`、`cordis.patch.yml` 与面向使用者的文档
（`README` / `INSTALL` / `OVERVIEW` / `CHANGELOG` / `LICENSE`）。判据集 `probes/`、
`TESTING.md`、`DESIGN.md`、`LESSONS.md`、`HANDOVER.md` 是维护这个模式用的，
**留在维护用的 checkout 里，不进仓库**。

### 移除

- **压缩闸门整体删除**。原先在 60% 提醒、75% 弹卡三选一（压缩 / 继续 / 写转接），
  并从 50% 占用起修剪超大工具结果。压缩的**时机**交还 harness 原生行为。
  按「责任」而非「载体」划范围，住在同一文件里的**在飞任务复述**被救了下来，
  独立成 `lib/recite.js`（插 `code-recite`）。
- **billion-context 联动面删除**：`lib/bili-cache.js`（`## Runtime` 的命中率一行）、
  `lib/compaction.js`（折叠定价）、`probes/fold-gate.mjs`、`probes/bili-*.mjs`，
  以及从 billion-context 抽出的源码树 `probes/src/`、`probes/kernel/`。
  `lib/prompt.js` 的第七条 Working habit（整条折叠经济学）一并删除。
- 两个一次性迁移脚本（按构造带绝对路径，无人引用；**已不在本包中**）

### 恢复

- **自动压缩恢复为 harness 原生行为**：构造函数不再覆盖 `auto`，值归预设配置
  （`compaction-basic` 行 `auto: true`）。
- 仍然有效、没有被推翻的那条：**压缩不许把整段对话交给模型一次性写摘要**。
  引擎真要压缩时拿到的是 `lib/ledger.js` 的 `handover()` 派生交接，零模型调用。

### 修复

- `lib/ledger.js` 的 `unrecordedMistakes()` 会话分桶改用**债务自身的时间戳**排序，
  不再从 journal 的会话顺序推断——原实现在当前会话不在 journal 里时会把全部会话
  当成「更早」，于是债务在结算判定之前就被跳过，`pit-guard-probe` J6 与
  `handover-derive-probe` N8/N8b 因此长红。
- `probes/cross-project-reach-probe.mjs` 的 R2/R4 改为断言**折叠本身**（自带
  phantom fixture），不再断言「本机有几个兄弟项目」——原判据断言的是机器的人口，
  账本迁到共享 store 之后兄弟项目数量变了，判据随之变红而折叠逻辑一行没动。

### 判据

`debt-audit` 20/23 → **23/23，`"failed": []`**。判据集与逐条结果在维护用的 checkout 里
（`TESTING.md`、`probes/README.md`），不随发布走。
