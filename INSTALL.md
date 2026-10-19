# 编程模式（Code Mode）安装与扩展

DSH 的第五个 agent preset，与内置 `standard` / `ptc` / `minimal` / `cordis` 同级。
mode id = `code`，显示名「编程模式」由 preset 声明自带（内置 locale 字典只覆盖那四个内置 id）。

**本模式已核实为内置 `standard` 的严格超集**：standard 的 33 个嵌套条目一项不缺，只多出 `preset-code` 本身与 `code-memory` 组。判据：`probes/build-preset.mjs --check`。

## 组成

| 部分 | 文件 | 作用 |
| --- | --- | --- |
| preset 声明 | `cordis.patch.yml` | 一行 `@deepseek-ai/dsh-agent-preset`，`config.id: code`，19 段标准子插件照抄 standard，另加 `code-memory` 组（8 行）。**内置的 `compaction` 组不再有任何本项目自己的行** |
| 提示段 | `lib/prompt.js` | `ctx.systemPrompt.section({ name: 'code-ledger', order: -50 })`：账本协议 + Working habits 八条 |
| 开局简报 | `lib/tool-brief.js` | 工具 `code_brief`：项目/命令/任务板/近期记录/相关踩坑/未验证债。按段分配预算，任何省略都写进正文并回报 `omittedSections` |
| 记账 | `lib/tool-record.js` | 工具 `code_record`，`kind ∈ project｜progress｜decision｜mistake｜verified`；`status:"done"` 会检查本会话有无真实验证 |
| 验证 | `lib/tool-verify.js` | 工具 `code_verify`：跑命令 + 断言期望输出 + 落 journal（期望未命中时即使 exit 0 也判失败） |
| 门禁 | `lib/gate-verify.js` | 插件 `code-gate`：改了文件却一个命令没跑的轮 → 轮内提醒一次 + 落 `unverified` 债（可被之后跑通的 `code_verify` 结清） |
| 坑门禁 | `lib/pit-guard.js` | 插件 `code-pit-guard`：动手前把账本里点到该**文件**（`files:`）或匹配该**命令**（`trigger:` 正则，动手前匹配 `pwsh`/`bash`/`shell`/`code_verify` 的命令行）的坑推给模型（同会话同条只推一次）；两个账本（项目 + 机器）都查；一轮里命令失败却没记坑 → 落 `mistake_unrecorded` 债，下次 `code_brief` 顶出，记一条 mistake 即结清。**唯一的例外**：条目写了 `- hard block: N` 时，第 N 次命中会**拒绝执行**（返回 `{kind:'deny', reason}`，写 `trigger_block` 到 journal）；`DSH_CODE_PIT_HARD=0` 关掉全部硬拦 |
| 预算 | `lib/budget.js` | 插件 `code-budget`：事前拦「整文件读 >256KB」；事后裁超长结果为兜底 |
| 在飞任务复述 | `lib/recite.js` | 插件 `code-recite`：每隔 `reciteEverySteps`（默认 6）步，把 `tasks.json` 里在飞的任务重述一遍，附在引擎自己的决定**之后**（`return { ...decision, messages: [...decision.messages, recite] }`——`next()` 不接参数，`next({messages})` 会被静默丢弃，这条实测过）。**它只读任务板**：不读对话、不读 journal，所以最坏情况是"过时"，不可能编出叙事。`reciteEverySteps: 0` 关掉 |
| 账本库 | `lib/ledger.js` | 纯函数库（无 loader 导出，**不能**作为 plugin 行注册）；同时拥有**项目**与**机器**两个 scope 的读写 |
| 正则兜底 | `lib/pattern-matcher.js` | 纯函数库（无 loader 导出，**不能**作为 plugin 行注册）：在可复用的 worker 线程里跑一个 `trigger:` 并在 250 ms 后放弃。记录的正则是一种可以从账本文件进来的数据，而 JS 没有正则超时，所以约束来自「这个模块能终止的那个线程」；超时算**不匹配**，绝不挂住 `pre-execute` |
| 条目字段 | `lib/entry-fields.js` | 纯函数库（无 loader 导出，**不能**作为 plugin 行注册）：账本条目里 `- symptom:` / `- files:` / `- trigger:` / `- safe case:` 这些字段的**唯一**读取者（`entryField(block, labels)` + `FIELD_SPELLINGS`，兼容 ASCII 与全角冒号/括号）。`lib/pit-guard.js` 与需要读条目的探针都 import 它；2026-10-10 之前同一段读取器被复制到八处，其中一件仪器靠在 `pit-guard.js` 的源码文本里抠正则来"检查副本没漂移"，于是永远落后于主人、并在真账本上把真实的 `safe case:` 行报成读不到 |
| 账本控制台（库） | `lib/ledger-admin.js` | 纯函数库（无 loader 导出，**不能**作为 plugin 行注册）：枚举三处账本、给出健康标记（`store-orphan`/`no-project-root`/`not-pointed-at`/`central-dangling`/`repo-copy-also-live`/`locked`/`machine`/`trash`）、读单个文件、把账本**移入回收站**并恢复；默认删除是 `rename`（可逆），`purgeTrash` 是唯一不可逆动作且要手输目录名。浏览器只能传它发出的 id，永远传不了路径 |
| 账本控制台（宿主） | `lib/web-routes.js` | 插件 `code-ledger-admin`（`inject: ['webServer']`，**顶层行**，故意不进 `code-memory` 组，否则只有跑编程模式的会话才有路由）：`GET /code-mode/ledgers`、`GET /code-mode/ledger?id&file`、`POST /code-mode/action`；只回答回环来源、校验 `Origin`/`Sec-Fetch-Site`，变更请求要带 `x-code-mode-token`。**行名必须是裸包名 `dsh-code-mode`**：`dsh-client-modules` 只对裸 specifier 解析 package.json（`lib/index.js:765-766`），写成 `dsh-code-mode/lib/web-routes.js` 会让浏览器半永远不进 boot graph，宿主路由却照常工作——设置页因此"就是不出现" |
| 账本控制台（浏览器） | `lib/client.js` | 浏览器半（`exports["./client"]` + `package.json` 的 `dsh.client`），**不能**作为 plugin 行注册：手写 `window.__ModuleLoader__.load({factory})` bundle（只 `require('react')`，无构建步骤），在设置页注册 `settings.section` 一节「编程模式账本」 |
| 自动压缩 | `lib/compact-summary.js` 的构造函数 | **不覆盖 `auto`**（2026-10-11 起）：构造函数原样把 config 交给引擎（`super(ctx, config)`），所以本模式用的是 harness 原生的自动压缩——`compaction-basic` 行的 `auto: true` 是它真正读到的值。曾经在这里强制 `auto: false`（2026-10-10，用户要求「完全禁止自动压缩上下文」），2026-10-11 用户撤回了那条要求：压缩是 DSH 自带的能力，这个 preset 不再对它有自己的意见。**为什么这个开关必须在模块里而不是配置里**：`compaction-basic` 是所有 preset 共用的行 id，而 profile patch 是**全局层**（按 id 覆盖、在每个 bundle 层之后生效），写在那里的 `auto` 会连带改掉 standard/ptc/minimal——2026-10-10 实测发生过，所以当时的范围靠构造而不靠配置；现在这条历史留着，是因为任何人想再动这个键都必须先知道它 |
| 压缩检查点 | `lib/compact-summary.js` | **不是库，是一个插件行**：它挂在预设的 `compaction-basic` 行上（`name: 'dsh-code-mode/lib/compact-summary.js'`），是内置引擎的子类，只改写 `summarize()` 这一个口子——压缩**何时**发生是引擎自己的事，但压缩**写成什么**由这里决定：返回**账本派生的交接**（`lib/ledger.js` 的 `handover()`），而不是把整段对话喂给模型去总结。所以压缩本身**零模型调用**（实测那次"让引擎自己压"的代价是单次请求 `uncached=637,706`）。账本为空或读不出时返回一段**明说"中段没了、没有任何东西替代它"**的 stub，仍然零模型调用；唯一的模型出口是 `DSH_CODE_MODEL_COMPACTION=allow`（break-glass）。判据：`probes/no-model-compaction-probe.mjs`（10/10：账本有东西走交接、账本空走 stub、只有 break-glass 才调模型——三件事各自断言，因为两条路径**都返回文本**，不种 marker 就分不出"拒绝总结"与"用模型总结了"） |
| 判据 | `probes/` | 验证工具集（**只在维护这个模式的 checkout 里**，不随发布走），见 `probes/README.md` |
| 能力总览 | `OVERVIEW.md` | 给使用者看的一份「它会做什么」总览：十个能力、两层账本的分法、以及边界（哪些是声称、哪些是实测） |

项目账本落在 `~/.dsh/code/projects/<项目 slug>-<哈希>/`：`project.json`、`tasks.json`、`decisions.md`、`mistakes.md`、`journal.jsonl`。一个项目一个文件夹，由里面的 `project-root` 标记认定身份；项目树里**不再新建** `.dsh-code/`。
2026-10-18 之前在项目里出生的旧账本仍留在原处，迁移后由 `<项目>/.dsh-code/CENTRAL`（内容 `central <项目路径>`）指过去；新代码在下一次读写时认为指针已完成使命并删掉它，空目录一并移除。
机器账本落在 `~/.dsh/code/`（同级，无 `projects/`；同名同格式，无 `tasks.json`）：只装「换个项目还会咬你」的事实，见下节。

## 安装（本机现状 = 已安装）

1. profile manifest `<profile>/package.json`（桌面安装通常是 `~/.dsh/profiles/desktop/package.json`）：

   ```json
   "dependencies": { "dsh-code-mode": "link:<这个包的 checkout 绝对路径>" },
   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-code-mode"] } }
   ```

   **必须用 `link:`，不能用 `file:`**（`file:` 会把本地目录拷进 `node_modules`，之后改工作区代码宿主仍加载旧副本 —— 见「坑 2」）。

2. **官方路径**：用 `plugin_manager` 把 bundle 装进 profile（`install_bundle`），或者对已在 profile 里的包用 `set_plugin` / `set_bundle` 开关。它要求审批，所以会话审批策略必须是「询问」；设成 `never` 时调用会被直接拒绝。`plugin_manager(list_plugins)` / `(list_bundles)` 是只读的，可先用来拿准确 id（**`target` 要用列表里的 `entryId`，例如 `include:tool-plugin-manager`；传 patchId 会报 `unknown-plugin`**）。

   手工兜底（审批不可用时才用）：

   ```
   <install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe ^
     <install>\resources\runtime\pnpm\bin\pnpm.cjs install ^
     --dir <profile> --reporter append-only
   ```

   校验 junction 指向工作区：

   ```powershell
   $i = Get-Item '<profile>\node_modules\dsh-code-mode' -Force
   "$($i.LinkType) -> $($i.Target)"   # 期望 Junction -> <这个包的 checkout>
   ```

   ⚠️ 判空要用 `[string]::IsNullOrEmpty($i.LinkType)`：属性不存在时是 `$null`，`-ne ''` 会把普通目录误判成链接。

3. **重启 DSH**。preset 行会热加载（`dsh.profile.patchReload: live`），但**子插件模块只在挂载时 import 一次** —— 改 `lib/*.js` 后必须重启进程才能生效（这条害过一整天）。

## 关键坑：外部包为什么能 import 内建的 `@deepseek-ai/*`

preset 子行的模块在 asar 之外，而 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 在 `resources\app.asar\dsh\node_modules\` 里。宿主用 `dsh-app-boot` 的运行时解析拦截（`lib/worker/profile-resolution-bootstrap.js`）把裸包名重定向到安装域内的包，规则是：

- 只有当 **importer 落在 profiles 树 / 活动 profile / 某个 linked root** 里才拦截；
- linked root（`<profile>\node_modules` 下指向 profile 之外的 junction）走 `routeLinked()`，它要求**被请求的包名出现在该 linked 包的 `peerDependencies` 里**（内部 `readPeerNames()` 只读 `peerDependencies`）。

所以 `package.json` 的 `peerDependencies` 必须列出本包 import 的**每一个** `@deepseek-ai/*` 包（当前是 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`）。少一个就报 `ERR_MODULE_NOT_FOUND`。
`probes/paths.mjs` 的 `installResolution()` 就是复刻这条链路，供探针使用。

## 坑 2：profile 里悄悄留着一份**旧的**包副本

症状：宿主加载的 `code_record` / `code_verify` 是老行为，而工作区源码明明已改好。

原因：manifest 里写了 `"dsh-code-mode": "file:..."`。pnpm 的 `file:` 协议**不建链接**，而是把目录拷/硬链接进 `node_modules`；之后用编辑器写入工作区文件（断掉硬链接），副本就永久停在旧版本 —— 「探针里全绿、真实宿主里全坏」。

排查与修复：

```powershell
$i = Get-Item '<profile>\node_modules\dsh-code-mode' -Force
$i.LinkType, $i.Target                                   # 普通目录 = 可疑
Get-FileHash '<profile>\node_modules\dsh-code-mode\lib\ledger.js'
Get-FileHash '<这个包的 checkout>\lib\ledger.js'          # 不一致 = 已确认
```

manifest 改成 `link:` → 确认路径无误后删掉那份**普通目录**副本 → 在 `profiles\desktop` 重跑 `pnpm install` → 复查 `LinkType` 是 `Junction` 且两边 SHA256 一致。

## 机器级账本（`~/.dsh/code/`）

第二层账本，2026-10-02 加入：装**机器事实**（这台机器上的 shell 怪癖、解释器路径、宿主级拒绝），位置 `~/.dsh/code/`（2026-10-10 从 `~/.dsh-code/` 搬进来，旧路径只在它还存有账本时被读），与 DSH 自己的 `~/.dsh/profiles/`、`~/.dsh/sessions/` 同级。文件与项目账本同名同格式，**没有 `tasks.json`**（工作属于项目，`kind="progress"` 会被拒）。

为什么需要它：有些坑不属于任何项目，属于**这台机器**。本仓库自己就付过一次学费 —— Windows PowerShell 5.1 把管道里的 `byte[]` 先 stringify 成「每字节十进制值直接拼接」再当文本写，一次毁掉三份文档；这条教训记在项目账本里，下一个仓库还得重付一次。判据很简单：**换个项目还会不会咬你**。

```js
// 机器事实（每个项目的开局简报都会带出来）
code_record({ kind: 'mistake', scope: 'global',
  symptom: 'PowerShell 5.1 把管道里的 byte[] 写成十进制数字串，一次毁掉三份文档',
  cause: '管道把 byte[] 先 stringify 成「每字节十进制值拼接」再当文本写',
  fix: '写文件一律走 Node（fs.writeFileSync）或 edit/write 工具',
  trigger: 'Set-Content|Out-File|Add-Content|Export-Csv|Export-Clixml',
  avoid: '不要用 PowerShell 回写文件内容（写入前先确认这条命令不是回写）' })
```

- **读**：`code_brief` 开局带 `## Machine-wide facts (true of this host, every project)` 段（权重 12 / 上限 1100 字符）。段内**坑优先于事实**：先给最新那条坑留位置，事实拿剩下的，两边被丢掉的数量都点名（实测教训：权重 5 时五条事实 ~600 字符会把配额吃光，简报只剩一句「4 条坑被丢弃」、一条坑都没有）。放不下时按段省略并回报 `omittedSections`。项目连 `.dsh-code/` 都还没有时，这一段照样带出来 —— 冷启动新仓库时正是它最有用。
- **触发**：条目里的 `- trigger: <正则>` 在**动手前**匹配命令行（`pwsh`/`bash`/`shell`/`code_verify` 的 `cmd`/`command`/`script`，大小写不敏感、原样和折叠空白两种形式都试），命中就把该条 `do not repeat` 原文推给模型；`- files:` 仍按编辑目标匹配。两个账本都查，同会话同条只推一次。
- **写 `trigger:` 现在是可验证的（2026-10-02）**：`code_record(kind="mistake", trigger: …)` 写入时就把正则编译一次——**写坏当场报错**，而不再像以前那样「那条坑永远不响、也不报错」（`lib/pit-guard.js` 的 `matchesTrigger` 在匹配时 catch 掉并返回 false，是同一类静默失败）。再给一个可选参数 `triggerSample`：填一条（或几条，用 `;` 分隔）**应该命中**的命令行，写入结果会回显「命中几条、漏了哪几条」，于是这条 trigger 在写下的那一刻就被证明会响。`files:` 写错路径仍然静默（路径可能还没建，写入时无法判断），这是下一批候选。
- **想复盘真实会话里的门禁决定**：把 `DSH_CODE_GATE_JOURNAL` 指向一个文件，`code-gate` 会把它在真实宿主里做过的每个决定追加成 JSONL——`edit` / `run`（含命令原文、是否算证据）/ `notice`（含触发的是哪条规则）/ `notice-delivered` / `turn-stopping`（含 `state` 与是否落债）。不开开关时一个字都不写；追踪路径写不进去也只是静默吞掉，绝不弄坏回合。判据：`probes/gate-journal-probe.mjs`（Electron 通道，7/7）。

  **怎么用（三步，`DSH_CODE_GATE_JOURNAL` 是「启动前」读的，会话里再设对当前进程无效）**：

  ```powershell
  # ① 带着开关启动（GUI 与这条命令只能活一个；先正常关掉正在跑的 DSH）
  $env:DSH_CODE_GATE_JOURNAL = "$env:TEMP\gate-journal.jsonl"
  Remove-Item $env:DSH_CODE_GATE_JOURNAL -ErrorAction SilentlyContinue   # 从空文件开始
  & '<install>\DeepSeek Harness.exe'

  # ② 在 GUI 里开一个「编程模式」的新会话，做一件事就行：
  #    改一个文件 → 不跑命令 → 结束这一轮。想看全三种，再来两轮：
  #    改文件 + 跑一条普通命令（不用 code_verify）；改文件 + 用 code_verify 跑一条并带 expect。

  # ③ 读它（另开一个 pwsh 窗口即可，这个文件不独占）
  Get-Content "$env:TEMP\gate-journal.jsonl" | ForEach-Object {
    $e = $_ | ConvertFrom-Json
    "{0} {1} {2}" -f $e.event, $e.kind, $e.state
  }
  ```

  一眼看懂的标准：第①轮应当出现 `edit` → `notice`（`kind: unproven-completion`）→ `notice-delivered` → `turn-stopping`（`state: none`, `debt: true`）；第②轮 `notice` 的 `kind` 是 `unrecorded-evidence`、`run` 那条里 `proof: false`、`turn-stopping` 是 `state: ran` 且 `debt: true`；第③轮 `run` 那条 `proof: true`、`turn-stopping` 是 `state: proved` 且 `debt: false`（这一轮**不落债**）。**想让开关常开**：把第①行那句写进一个 `.ps1`，以后就用它启动。
- **覆盖**：`DSH_CODE_GLOBAL_DIR` 可以把机器账本指到别处；探针用它，因为受限通道写不了用户主目录。
- **生效**：`lib/*.js` 的改动要**重启 DSH** 才加载（同「安装」第 3 条）。机器账本目录不需要预建，第一次 `scope="global"` 写入时自己建。

## 验证模式是否真的加载

判据、跑法与期望输出集中在 **`probes/README.md`**（一张表：哪个探针、什么运行时、查什么）。人工确认项只有三个：

- 新会话的模式选择器里出现「编程模式」。
- 会话里能看到 `code_brief` / `code_record` / `code_verify`，且 `code_brief` 返回 `# Ledger brief — <cwd>`。
- 重启后想确认插件是否真的加载了新代码：比较 `lib/ledger.js` 的 mtime 与本会话第一条 journal 记录的时间，再看行为是否对得上。

只想确认 preset 行有没有注册（不改任何东西）：`cordis_inspect_query` host/Config/listConfigs `name: '@deepseek-ai/dsh-agent-preset'`，应看到 `include:preset-code`。

## 三层门禁的现状

| 病 | 谁在管 | 说明 |
| --- | --- | --- |
| 同一轮里把同一个调用刷 N 遍 | **DSH 自带** `repeat-tool-reminder` | 根组合默认开启，阈值 `[3,5,8]`。本模式**不叠第二份**：两套阈值会叠加成 2,3,4,5,8，更吵 |
| 没读文件就改 | **DSH 自带** `fs-observation-policy` | 硬门禁：`FS_NOT_OBSERVED` / `FS_STALE_VERSION`。观察不持久化（重启后要重读） |
| 整文件读超大文件 | 本模式 `code-budget` | 硬拒：理由带真实大小、估算 token 与改法 |
| 动了 `mistakes.md` 里点到该文件的文件，却对那条坑一无所知 | 本模式 `code-pit-guard`（动手前） | 编辑前推该条 `do not repeat` 原文 + 条目位置；同会话同条只推一次；不拦调用 |
| 命令跑失败了、这一轮却没记坑 | 本模式 `code-pit-guard`（收尾） | 轮内提醒一次 + 落 `mistake_unrecorded` 债，下次 `code_brief` 顶出，`code_record(kind="mistake")` 即结清 |
| 改了东西、一个命令没跑、还说 done | 本模式 `code-gate` | 轮内提醒一次 + 落 `unverified` 债（`state:"none"`，带编辑目标），下次 `code_brief` 顶出 |
| **跑了不相干的命令就说验证过了** | 本模式 `code-gate`（2026-10-02 起） | 只有 `code_verify`（把退出码与输出写进 journal）才算**证据**，回合才能静默收尾；其他命令落 `state:"ran"` 债（**带命令原文**）并在轮内点名「跑了但没记证据」，提醒里还会带出项目自己声明的 `commands.test`。修法：`code_verify` 重跑一遍，或明说"没验证" |

`code-gate` 的可调项（写进 `cordis.patch.yml` 该行的 `config:` 即生效）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉门禁但不卸载工具 |
| `editTools` | `['edit','write','multiedit','apply_patch','str_replace']` | 算「改动」的工具名 |
| `runTools` | `['pwsh','bash','shell','code_verify']` | 算「跑过」的工具名 |
| `proofTools` | `['code_verify']` | 算「留下证据」的工具名（2026-10-02 新增）。只有这里面的工具执行过，回合才静默收尾；`runTools` 里其余工具落 `state:"ran"` 债 |
| `docExtensions` | `['.md','.mdx','.rst']` | 纯文档编辑不欠验证；`.txt` **故意不在**名单里（纯文本常见于 fixture 与生成数据，那些会改行为） |
| `patience` | `3` | 编辑后容忍多少次非执行调用才提醒 |

默认值同时内联在模块顶部常量与 `Config` 里（`resolveLists()` 兜底），所以即使 `apply` 没拿到 cordis 校验过的配置也不会变成「注册了但永不触发」的空壳。

## 扩展新工具

1. 新建 `lib/tool-<name>.js`（范式照抄 `tool-brief.js`）：导出 `name`（`code-<name>`）、`inject: ['tools']`、`Config`、`apply(ctx, config)`；在 `apply` 里 `ctx.tools.register(defineTool({...}))`。工作目录取 `exec.agent?.session?.header.cwd`。
   `parameters` 是作者 DSL（`type` 只允许 `string|number|integer|boolean|null|array|object|json|oneOf`；`required: true` 只能这么写；联合类型用 `oneOf`）；`output.render(args, value)` 必须返回 content-block 数组。
2. 在 `cordis.patch.yml` 的 `code-memory` 组里加一行；随后跑 `probes/build-preset.mjs --check` 确认组合没漂移、`acceptance-probe.mjs` 确认新模块能注册。
3. 若新文件 import 了新的 `@deepseek-ai/*`，**同步加进 `package.json` 的 `peerDependencies`**。
4. 给新行为**加一条判据**（放进 `probes/`），然后重启 DSH。

## 已知缺口（宿主侧，本包改不了）

- **受限通道的写权限只覆盖工作区根目录**（2026-10-02 查清机制）：沙箱子进程以 **Low 完整性**运行（令牌带 `Mandatory Label\Low Mandatory Level`），要能被它写入，对象必须带低级标签 ACE。DSH 只给工作区**根目录**加了写授权（`S-1-4-<host>:(OI)(CI)(W,D,DC)`）和标签（`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`）；**已存在**的子目录（`lib/`、`probes/`、`.dsh-code/`）两样都没有，于是往它们里面写文件一律 `EPERM`——而同一时刻写工作区根目录是成功的。`code_verify` 经 `ctx.shell` 的通道更严（写 `$env:TEMP` 可以、写工作区被拒，带定性标记 `[sandbox denied this command under the session's current file policy]`）。**补 DACL 不够**：给子目录补上那条写授权后依然 EPERM；补标签要写 SACL、需要提权，而本机护栏禁止提权（实测 `icacls /setintegritylevel /T` 报 43 files processed 但文件仍无标签、4 个目录 Access denied，净效果为零）。**重启不能修。** 因此：探针的 fixture 一律 `os.tmpdir()`；跨运行要留存的产物（`probes/budget-report.*`）只能**在一次不受限调用里**生成，其新鲜度由 `debt-audit` R3 盯着。
- **`$env:TEMP` 是每条命令一次性目录**，命令结束即清空，写进去的报告取不回来。
- **`web_fetch` 对部分主机被拒**（github.com、huggingface.co 报 `resolves to a non-public IP address`），`example.com` 正常 —— 是主机级 DNS 策略，不是工具坏了。
- `code_record(kind='verified')` 记的是**声称**（journal 里 `ok: null` + `claimed: true`）；`verifyCount()` 只统计真正跑通的 `code_verify`。这是「防自证式完成」的地基。
- **`done` 反自证是按会话计数的**：本会话只要跑过任何一条无关的 `code_verify`，未验证的 done 就不再被警告。更严的「按任务关联验证」需要模型判断关联性，因此这一层注定是软的。
