# 变更记录

本文件只记**对使用者可见**的变化。

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
