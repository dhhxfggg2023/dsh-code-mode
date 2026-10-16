# 编程模式（Code Mode）— DSH 第五个 agent 预设

> **本项目完全由 AI 生成**（代码、文档、判据，以及每一轮决定）。没有任何一行是人工先写好再让 AI 补的，
> 也没有人逐行审阅过全部实现。它能用是因为有一批判据钉住它，不是因为有人看过它——
> 而判据本身也是 AI 写的。请按这个前提评估它。

把「这个项目怎么跑、踩过哪些坑、正在做什么、刚才那步有没有证据」写进账本，
并在你动手的**前后**自动读它、写它、必要时拦你。

它是 DeepSeek Harness 的一个 **bundle patch**：以 profile 依赖的形式装进去，
就多出一个与内置 `standard` / `ptc` / `minimal` / `cordis` 同级、mode id 为 `code` 的预设。

---

## 它治的是四件具体的事

| 病 | 症状 | 这里的做法 |
| --- | --- | --- |
| **记不住** | 换会话就忘了项目怎么跑、决定过什么、否掉了什么 | 开局 `code_brief` 把账本交代出来 |
| **重复踩坑** | 同一个坑踩第二次，因为结论只活在某次对话里 | `mistakes.md` + 动手前按 `files:`/`trigger:` 反查 |
| **自证式完成** | 改了文件、跑了点东西，然后宣称「做好了」 | `code_verify` 跑命令 + 断言期望输出 + 落 journal |
| **烧上下文** | 整读 2 MB 源文件，之后每次请求都背着它 | `code-budget` 硬拒「整文件读超大」 |

核心判断：**提示词治不了这四种病**。提示词是背景噪音，模型在关键决策点不会回头查。
唯一有效的是让正确的东西**在正确时刻必须被读到**——确定性注入，与真正的硬门禁。

---

## 装好之后你多出什么

**三个工具**

| 工具 | 干什么 |
| --- | --- |
| `code_brief` | 开局读账本。按段分配预算，**任何省略都会说出来**（正文点名 + `omittedSections` 回报） |
| `code_record` | 记账。五种：`project` / `progress` / `decision` / `mistake` / `verified`；`scope` 决定写哪一本 |
| `code_verify` | 跑命令 + 断言期望输出 + 落 journal。**期望未命中时即使 exit 0 也判失败** |

**四条腿**

| 插件行 | 干什么 |
| --- | --- |
| `code-prompt` | 在 system prompt 加 `## Project ledger`（账本协议）+ `## Working habits`（八条真正付过钱的教训） |
| `code-pit-guard` | 动手**之前**按两个账本反查：改文件按 `files:` 命中路径段，跑命令按 `trigger:` 正则匹配命令行 |
| `code-gate` | 改了文件一条命令没跑就说了「done」→ 轮内提醒 + 落一笔**跨会话**的未验证债，下一次简报顶出来 |
| `code-recite` | 每隔几步把 `tasks.json` 的在飞任务重述进对话。只读任务板，读不到对话，所以编不出叙事 |

---

## 详细功能

### 一、`code_brief`（`lib/tool-brief.js`）

开局读账本并交代背景。这段不是全文，而是**按重要性分配预算的选集**——

八个段各有权重与上限：`project`(6,1700)、`global`(12,1100)、`journal`(5,1100)、
`unverified`(12,1600)、`mistake_debt`(8,900)、`board`(5,900)、`mistakes`(16,1400)、
`decisions`(16,1400)。默认预算 4,000 字符；装不下时**不是静默截断**——

- 每个被丢掉的段落都写进正文，并通过 `omittedSections` 字段回报；
- 被窗口切过的段落要么保留**完整条目**、要么说明丢了几条；
- `code_brief({full: true})` 走无上限路径（预算足够时每段取自己的 ceiling）。

其它行为：

- `topic` 参数按文件/症状/标题片段/`trigger:` 从**两个账本**检索并读回完整条目；
- 会报出这一段距上次 `code_brief` 变了没有（记长度 + 摘要 `digest`）；
- `## Runtime` 段给出账本目录、机器账本目录、本会话 token 占用；
- 只读。读函数一个字节都不写账本。

### 二、`code_record`（`lib/tool-record.js`）

五种记账动作：

| kind | 写什么 | 特别注意 |
| --- | --- | --- |
| `project` | 这个项目怎么跑、怎么摆 | `patch` 合并进 `project.json` |
| `progress` | 任务移动 | 支持按标题/裸 slug/完整 id 命中；`status:"done"` 会检查**本会话**有没有真实验证 |
| `decision` | 定了什么、否掉什么 | 支持 `supersedes` 顶掉旧条目（旧条目标 `- superseded by:` 而不是删） |
| `mistake` | 症状 / 根因 / 修法 / 涉及文件 / 触发正则 / 别再这么干 | 写入前编译 `trigger`；同族重复会要求改记到既有条目 |
| `verified` | 一条**声称**跑过某命令 | journal 里写 `claimed: true`，**不算证据** |

写侧的两个告警：条目超 1,600 字符会警告；既没写「哪个文件」也没写「匹配什么命令」的条目会被指出来——
因为那意味着它永远无法在动手前被找到。`scope="global"` 与 `kind="progress"` 组合会被拒（任务属于项目）。

### 三、`code_verify`（`lib/tool-verify.js`）

跑命令并断言期望输出，然后把退出码与输出写进 journal。

- 走 `ctx.shell` 而非 `child_process`，所以它套用**会话自己的 sandbox policy 与超时上限**；
- `expect` 支持子串或 `re:` 正则；**期望未命中时即使 exit 0 也判失败**；
- 被 sandbox 拒、runner 崩、超时中断都算失败，并在结果里附上定性标记；
- 这是唯一能在会话里留下「证据」的动作——其它命令只是「跑过」。

### 四、`code-pit-guard`（`lib/pit-guard.js` + `lib/pattern-matcher.js` + `lib/entry-fields.js`）

账本的第三条腿：mistakes 由 `code_record` 写、由 `code_brief` 读，
但在**决策的那一刻**没有任何东西查它们——这一个查。

**文件侧**（`tools/pre-execute`）：遍历两个 mistakes 源，只认 `entry.files` 里的**路径段**命中
（不做子串猜测）。命中即推 `do not repeat` 原文，并写一条 `file_hit` journal 事件。
改了 `lib/*.js` 或 `cordis.patch.yml` 时会额外记一条「需要重启才生效」待办。

**命令侧**：`entry.trigger` 是正则，拿它匹配**原始命令**与**空白折叠后**的命令各一次。

**`trigger:` 不会挂住会话**（`lib/pattern-matcher.js`）：正则可以从账本文件进来，而 JS 没有正则超时。
所以内联预算 40 ms，之后交给 worker 线程跑，**250 ms** 后放弃并视为**不匹配**
——绝不挂住 `pre-execute`。超时的坑不挡命令，但调用方会被告知。

**safe case 机制**：一个写宽的 trigger 会在安全情形反复响，而收窄 trigger 表达不出
「命令里有没有引号」这类前提。所以条目可以写 `- safe case: …`，通知里以
`safe case (check this first):` 插在 `do not repeat` 之后。

**`hard block: N`**：默认只通知不拦。条目里声明了 `hard block: N` 才真拦——
**第一次命中照旧只提醒，第 N 次才真的拒绝执行**，并说明引的是哪条规则、这是本会话第几次。
三条豁免：没有 `hard`、`DSH_CODE_PIT_HARD=0`、以及该条同时带非空 `trigger:` 时不许拒绝编辑。
声明写坏时照旧放行——这条路径唯一危险的方向是「卡死」。

**聚类**：一次编辑最多可命中 14 条（实测）。命中 ≥2 条时合并成**一条**通知
（每条规则一行、条数写在开头、指向完整条目），单条命中仍走完整通知。

**字段读取只有一个主人**（`lib/entry-fields.js`）：这个读取器曾被复制到八处，
主人被加宽（全角分隔符、中文标签）后副本全部说错，两件仪器报「0 of 4 条 safe case」而真调用点读得到全部。

### 五、`code-gate`（`lib/gate-verify.js`）

DSH 没有自带的那一道门，管三件事（全是建议性的，不拦任何调用）：

1. **轮内建议** —— 一次编辑过了 3 次工具调用还没跑任何东西，下一步前给一条通知；
2. **持久记忆** —— 回合结束时改了东西却什么都没跑 → 追加到项目 journal，下一次 `code_brief` 顶出来；
3. **证据而非活动** —— 只是*跑过*的命令曾算作证明；现在只有 `code_verify`（自己记了退出码与输出）算静默收尾，
   其它命令留下一条「跑了命令但什么都没记」的债。

### 六、`code-recite`（`lib/recite.js`）

每隔 6 步（`reciteEverySteps` 可调，`0` 关掉）往对话里插一条从 `tasks.json` 派生的在飞任务提醒，
附在引擎决定**之后**。它只读任务板——不读对话、不读 journal，所以**编不出叙事**；
最坏是过时，而它会在同一句里说「如果那已经不是你在做的事，用 `code_record(kind="progress")` 移走它」。

### 七、压缩：本模式只有一个意见

`compaction-basic` 行挂的是 `lib/compact-summary.js`（引擎的子类）。
引擎真要压缩时拿到的不是模型写的摘要，而是 `lib/ledger.js` 的 `handover()` 派生出来的账本交接，
**零模型调用**（实测「让引擎自己压」的代价是单次请求 `uncached = 637,706`，新会话首请求只要 `17,394`）。

`summarize()` 三条路径：

- 账本有内容 → 返回 `INJECT_HEAD` + 账本派生交接。`INJECT_HEAD` 明说「中段是**没了**，不是被总结了」，
  并点名 `code_brief` 才是记忆；
- 账本为空或读不出 → 返回同样明说的 stub，**仍然零模型调用**，并告诉会话怎么让下一次免费；
- `DSH_CODE_MODEL_COMPACTION=allow`（break-glass）→ 才落到引擎自己的模型摘要器。

### 八、`code-budget`（`lib/budget.js`）

- **事前拒绝**：`read` 一个 >256 KB 的文件且没带 `offset`/`limit` → 硬拒，并告知大小与 token 估算
  （带 `offset`/`limit` 的读一律放行）；
- **事后裁剪**：超长结果按头 12,000 / 尾 4,000 字符裁，并用 `NOTE_RESERVE = 320` 给丢弃标记预留位置，
  绝不把标记本身挤掉。

---

## 账本在哪

两层，判据是一句话：**换个项目还会不会咬你？会 → 机器级；不会 → 项目级。**

| | 位置 | 装什么 |
| --- | --- | --- |
| 项目账本 | `~/.dsh/code/projects/<项目 slug>/` | 这个项目怎么跑、在做什么、已定的事与被否方案、踩过的坑 |
| 机器账本 | `~/.dsh/code/`（同级，无 `projects/`） | 换任何项目都成立的事实：这条 shell 会毁字节、那个解释器在哪 |

五个文件：`project.json`（怎么跑怎么摆）、`tasks.json`（任务板）、`decisions.md`（决定 + 被否方案及**理由**）、
`mistakes.md`（症状 / 根因 / 修法 / 涉及文件 / 触发正则 / 别再这么干）、`journal.jsonl`（逐条机器证据流水）。

前四个进 git（账本随项目走，可审查、可共享）；只有 `journal.jsonl` 排除——每次验证追加一行，进 git 会让每次验证都产生一条 diff。

覆盖方式：`DSH_CODE_GLOBAL_DIR` 与 `DSH_CODE_PROJECTS_DIR`（探针用来做 hermetic，正常使用时不用设）。

> 这个包**不会在你的用户目录里另起一个新文件夹**。两级都在 DSH 自己的 `~/.dsh/` 里，
> 与 `profiles/`、`sessions/`、`storages/` 并列——那是运行 DSH 就会存在的目录，不属于本插件新造的地盘。

---

## 压缩：本模式只有一个意见

压缩是 DSH 自带的能力，这个模式**不对「何时压缩」再有意见**。它只保留一件事：**压缩写成什么，由账本决定。**

引擎真要压缩时拿到的不是模型写的摘要，而是 `lib/ledger.js` 的 `handover()` 派生出来的账本交接，
**零模型调用**（实测「让引擎自己压」的代价是单次请求 `uncached = 637,706`，而新会话首请求只要 `17,394`）。
账本为空时返回明说「中段没了、没有任何东西替代它」的文字，仍然不调模型。
唯一模型出口是 `DSH_CODE_MODEL_COMPACTION=allow`（break-glass，默认不设）。

---

## 装起来

需要一台已装 DSH 的机器。详见 **[INSTALL.md](./INSTALL.md)** —— 一句话版本：

```powershell
# profile manifest 加一行 link: 依赖（不能用 file:）
"dsh-code-mode": "link:<这个包的 checkout 绝对路径>"
# 然后在 <profile>/node_modules/ 建 junction 指向它，让 dsh.profile.bundles 包含 dsh-code-mode
```

装好后在会话里选「编程模式」，第一个动作就是 `code_brief`。

---

## 它做不到什么

- 门禁只看「有没有跑过命令」，**不判断跑的东西能否证明这件事**；
- 提示词协议与轮内提醒都是**软**的，模型可以无视；真正不看态度的是判据与硬拒；
- 它治**懒惰型**失误，治不了**推理型**失误——无法在「我要说一句话」时设卡；
- 坑的 `trigger:` 正则由人写，**写错 = 那条坑不响而且不报错**；
- 提醒有时会误报：匹配的是**命令行文本**（例：字符串里的 `??=` 会命中 PowerShell 7 语法那条坑）。

---

## 文档

| | |
| --- | --- |
| [OVERVIEW.md](./OVERVIEW.md) | 面向使用者的总览：十个机制各自管什么、边界在哪 |
| [DESIGN.md](./DESIGN.md) | 为什么这么设计：四个病、确定性注入、两条不可让步原则 |
| [INSTALL.md](./INSTALL.md) | 安装、扩展、以及「看起来像坏其实是正常」的四类 |
| [TESTING.md](./TESTING.md) | 60+ 条判据怎么跑，两条通道各自能跑哪些 |
| [HANDOVER.md](./HANDOVER.md) | 给下一个维护者：先做这五件事、铁律 13 条 |
| [LESSONS.md](./LESSONS.md) | 一天里修掉的 5 个真缺陷，与四条比 bug 更贵的流程教训 |

## 许可

[MIT](./LICENSE)
