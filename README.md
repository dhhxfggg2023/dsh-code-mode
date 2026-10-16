# 编程模式（Code Mode）— DSH 第五个 agent 预设

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

**两条腿**

- `code-pit-guard` —— 动手**之前**按两个账本反查：改文件按 `files:` 命中路径段，跑命令按 `trigger:` 正则匹配命令行。默认只通知不拦；条目里写了 `hard block: N` 才真拦（第一次仍只提醒）。
- `code-gate` —— 改了文件一条命令没跑就说了「done」→ 轮内提醒一次 + 落一笔**跨会话**的未验证债，下一次简报顶出来。

**一条线**

- `code-recite` —— 每隔几步把 `tasks.json` 的在飞任务重述进对话。**只读任务板**，读不到对话，所以编不出叙事；最坏是过时，而且它会说自己过时。`reciteEverySteps: 0` 关掉。

**一段提示**

- `code-prompt` 在 system prompt 里加 `## Project ledger`（账本协议）与 `## Working habits`（八条真正让这个项目付过钱的教训）。

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

压缩是 DSH 自带的能力，这个模式**不对「何时压缩」再有意见**（早先挂过一个 60% 提醒 / 75% 三选一的闸门，
2026-10-11 按用户裁决删除）。它只保留一件事：**压缩写成什么，由账本决定。**

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
