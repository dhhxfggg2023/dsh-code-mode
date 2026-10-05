# 编程模式 交接文档

> 给下一个会话（尤其是没有任何上下文的会话）看。最后更新：2026-10-01。
> 安装/坑见 `INSTALL.md`，判据跑法见 `probes/README.md`，人工走查见 `TESTING.md`，实战教训见 `LESSONS.md`。

## 一、这是什么，在哪

- **「编程模式」= DSH 的第五个 agent preset**，mode id `code`，与内置 `standard`/`ptc`/`minimal`/`cordis` 同级。
- **包目录 `E:\projects\dsh-code-mode\`**（2026-10-01 从 `E:\tools\DSH\dsh-code-mode\` 迁出 —— 包不该住在 DSH 应用目录里，因为那个目录也可能被选作工作区，而 agent 在那里干活能弄坏应用）：`cordis.patch.yml`（preset 声明，19 段标准子插件 + `code-memory` 组 7 行；内置 `compaction` 组里另有一行本项目的 `code-compact-gate`）、`lib/`（8 个插件模块 + 账本纯库）、`probes/`（判据集）、`INSTALL.md` / `LESSONS.md` / `TESTING.md` / `DESIGN.md` / 本文。
- 装载：profile manifest 里 `"dsh-code-mode": "link:E:\\projects\\dsh-code-mode"`，且 `dsh.profile.bundles` 含 `dsh-code-mode`；junction 在 `C:\Users\dhhxfggg\.dsh\profiles\desktop\node_modules\dsh-code-mode`。
- **本模式是 standard 的严格超集**（33 个嵌套条目一项不缺），判据 `probes/build-preset.mjs --check`。
- **账本分两层（2026-10-02 加的机器层）**：项目事实在项目内 `.dsh-code/`（五份文件，随项目进 git），机器事实在 `~/.dsh-code/`（同名同格式、**无 `tasks.json`**；`DSH_CODE_GLOBAL_DIR` 可改指向，探针用它）。两层由同一份 `lib/ledger.js` 读写，判据是「换个项目还会不会咬你」。见 `INSTALL.md` 的「机器级账本」一节。
- 探针不写死安装目录：`probes/paths.mjs` 按 `DSH_ASAR`/`DSH_EXE` → `process.execPath` → profile → 常规位置 的顺序发现 `<install>`（包搬出应用目录后，靠相对位置猜安装目录会猜错，这是迁移时踩到的）。

## 二、当前状态（2026-10-02 更新）

全部判据通过，且都在包内可复跑（`probes/README.md`）：

| 判据 | 结果 | 查什么 |
| --- | --- | --- |
| `acceptance-probe.mjs` | 24/24 | 八个模块经宿主真工具注册表加载注册 + 三个工具端到端；**新增**：写坏 `trigger:` 必须被拒（否则那条坑永远不响且不报错）、`triggerSample` 必须回显命中了哪些样本/漏了哪些、只有 sample 没有 trigger 要拒 |
| `pit-guard-probe.mjs` | 24/24 | 坑的读取侧：命中该文件的已知坑推一次、无关文件/只读不推、失败未记录 → 落债 → 跨会话顶出 → **记一条点到该失败的 mistake** 才结清（J6 现在真的走 `recordMistake` 的 journal 路径，所以它同时钉住了「journal 必须记下整个条目，不能只记 symptom」） |
| `compact-gate-probe.mjs` | 35/35 | 压缩闸门：纯策略的 warn/ask/granted 边界（含浮点：`0.8 + 0.05` 不等于 `0.85`，靠定点比较挡住「人类答应 85%、却在 86% 才被问」）、提醒一次且跨过阈值回落才重置、问人时**先问后跑这一步**、三个选项各自的下场、以及 fail-open（超时/无应答方/答案看不懂/窗口未知/占用率测不出来——全部放行给引擎）。挂载侧四条：`R1` 把「引擎自己仍是 0.8」当**字面量**断言（此前是拿它去比闸门的库默认值——同一个默认的两份拷贝互相作证，正是这个功能空转 30/30 的原因）；`R2`/`R4` 只证明预设文本里闸门行在前、且在同一个组里（**是投递顺序，不是运行时调用顺序**，没有任何判据量后者）；`R5`/`R6` 钉住预设声明的线在真实会话够得到的范围内（0.75，提醒 0.6）并确认它经 `resolveLimits` 真的成为挂载边界。**2026-10-03 实测的教训**：上面这些全部通过，而闸门一次都没响过——30 项里的 28 项驱动的是**编造的 100,000 窗口**，而每个真实会话解析出的窗口是 **1,000,000**；这条探针至今**不读真实会话**，读真实会话的是 `gate-chance.mjs`。**同日 `G7`/`G8`/`G9`**：选「写转接文档」现在与「让我继续」共用同一份 margin（一个决定不再问第二次卡），同时把提醒重新武装，让撞到引擎那条线的越线仍然被说出来 |
| `handover-grant-probe.mjs` | 12/12 | 转接分支（`lib/compact-gate.js`）：它取的 margin、重新武装的提醒、发出的指令文本（必须仍点到 `code_record`、`HANDOVER.md` 与「新开对话」，而不是「这步之后会被压缩」）、这一步是被放行而非扣住、以及 config 面仍只有预设声明的那五个键。**H9/H10/H11**：指令必须**明确禁止把会话总结写进去**、必须点到账本（`mistakes.md`/`decisions.md`/`journal.jsonl`）承载其余部分、必须要求写出会被踩到的注意事项并区分「已验证 / 未验证」。它存在的理由：`compact-gate-probe.mjs` **在受限会话通道里跑不起来**（那条要从 asar 加载宿主解析、需要 Electron 二进制，而这种通道根本起不动它——2026-10-03 实测：无输出、`$LASTEXITCODE` 为空）。这条桩掉库里仅有的两个裸导入、在普通 node 下驱动**真的** `agent/pre-step` handler，所以行为是执行出来的而不是读出来的。它是**可达**的判据，不是替代品：边界、恢复、fail-open 与预设接线仍然归 `compact-gate-probe` |
| `effect-audit-probe.mjs` | 8/8 | **效果审计**：问的是所有别的探针都问不出的那个问题——这些机制**到底有没有产生过价值**（其余每个探针问的都是"它是否按规格工作"）。范围刻意收窄，且 `E4` 把这条收窄钉住：**门禁代价**（改了代码却没有任何证据收尾的回合，来自 `lib/gate-verify.js` 无条件写的 `kind:'unverified'`，**含轮转段**）加上这些债后来有没有被结清，以及本模式自己那份每请求前缀。liveness 与上下文成本**只点名归属、不重算**（`pit-liveness` / `context-cost` / `mode-cost`），因为这个仓库已经为"一份读两个 owner"付过两次学费。`E1` 从**字节**上读债的总体而不是数行——journal 合法地带着非债行（`initLedger` 先写 `project` 再写 `init`），拿债数去比**所有**行从一开始就是红的、并且在"初始化过账本的 fixture"里恒不可满足；原始行数留在旁边当收据，轮转那一半用来挡住"只读 live 文件、于是越写越瞎"的读者。`E2` 要求更晚的覆盖性证据**移除**一条债，并用 `laterProofs:false` 把全部放回去作为对照。`E3`/`E3b` 把 `state:"none"`/`"ran"`/**缺失** 三个桶与**字节**比，而不是与手数的字面量比——那组字面量按构造就不可满足（它要求一个写着三条 `none`、三条 `ran` 的 fixture 满足 `none !== ran`）。`E5` 把**不存在**的 journal（`unjudgeable` + 原因）与**空**的（真实的 0，且写一行控制债必须让它动起来）分开。`E6` 只读、且对照看得见一次真写入；`E7` 要求报告写出读过的文件/段/上限，并且降低上限真的读得更少。**文件名里的 `-probe` 是承重的**：`debt-audit` 从子进程文件名推导报告路径，叫 `effect-audit.mjs` 会让审计去找 `effect-audit.mjs-report.json`、判 `reported:false`、把 R5 判红，而探针本身是绿的 |
| `handover-derive-probe.mjs` | 19/19 | 转接**派生器**（`lib/ledger.js` 的 `handover()`，T1）：转接收窄成"接下来要做的 / 需要避免的"两件事后几乎全部可从账本派生。`N1`–`N1d`：在飞任务只带 id + 标题（**不搬运 note**）、两个调用方字段、休眠的 `lib/` 改动都进 `## Next`；`N2`/`N2c`：未验证的债与"没人写下的失败"各自独立成块，而"已验证"只是另一行——`N2b` 用**一条覆盖该编辑的、更晚的通过证据**让那个块消失，证明这是算出来的而不是摆样子；`N3` 反向钉住"没有会话叙事"（`N3a` 先证明关键词表真有牙齿，`N3b` 证明塞进一段叙事就变红），而且这是**结构性**的：这个函数根本没有对话可读；`N4` 空账本 `empty: true` 且不留空洞标题；`N5` 在远大于上限的账本上仍被裁住，且低于两段地板的上限原样返回（只有末尾那次 clip 做得到）；`N5b` 啰嗦的调用方把派生内容挤出去时，被裁的部分必须**被点名**；`N6` 带 `files:`/`trigger:` 坐标的坑排在纯散文坑之前——两半**先分再排**，因为 `shapeEntries` 自己的顺序会把 `recurred:` 的坑排第一（`N6b` 把这条**测**出来而不是当假设：它用账本自己的排序跑同一对条目，得到 `prose-first`，再要求转接把它反过来），对照可判红；已定的事只留标题一行、没点名的计数；`N7` 一个字节都不写（`N7b` 证明这个比对看得见真写入）。**写它当场抓到一个真缺陷**：把调用方两个字段排在最后时，啰嗦的 `nextMove` 会把**债**挤出 `## Next`（首跑 `N2`/`N2c` 红）——有界段里丢错了那一半，于是 `## Next` 的次序改成"这段文字唯独承载的排最前、能从文件重读的排最后" |
| `journal-rotation-probe.mjs` | 5/5 | `journal` 是唯一「上面没有天花板、又被整份读」的账本文件，所以越过段大小就改名让位、新起一份。最要紧的是 `J2`：**跨段不丢行、顺序与写入时一致**——轮转丢行或乱序会毁掉完成门禁所读的证据；`J3` 证明落到轮转段里的旧行仍能被 `brief` 的债段找到（走真实调用路径而不是辅助函数）。**`J4`/`J5` 于 2026-10-04 重写**：`J4` 原先断言「只改名、从不删除」，而 ledger-core 审计的 F5 证明这条不可能成立——最高槽被占后移位无处可放，轮转**永久停止**（真实账本：9 个槽只用 1 个，319 KB / 524 KB 阈值），同时读取顺序与写入相反（最新内容在 `.000` 而读者按升序读）。`J4` 现在只断言仍然必须成立的（读者拿到的每段都存在可读，只退役最旧那段），`J5` 预填最高槽——当年卡死的那状态——要求轮转继续转且窗口有界；旧规则会在同一断言上失败，这就是它的对照 |
| `write-rule-probe.mjs` | 12/12 | 写入侧告警（过长 1,600 字符 / 既无 `files:` 又无 `trigger:` 的不可检索条目，**照常记录、只是警告**，`W4` 反向钉住「带坐标的短条目一句不说」）+ **命中记账**（`trigger_hit`/`file_hit` 落 journal 并按条目计数——文件侧因此第一次有了「到底命中过没有」的统计，而 35 条坑里 31 条是 `files:` 键控的）+ **重启追踪**（`lib/` 改动休眠到重启，只由**另一个进程**的启动结清，因为重启是新进程而不是新会话；`DSH_CODE_BOOT` 让它可测）。写这 12 条的过程本身抓出了功能里两个真 bug：通知被 `clipTail` 裁掉（必须走预留的 notices）、以及 journal 里存有两个 boot 的启动记录时会把结清状态**反悔**（结清必须 latch） |
| `brief-full-probe.mjs` | 4/4 | `code_brief({full:true})`：默认按重要性排序并把其余条目索引成一行，这在读者还不知道该搜什么时不够用；`full` 解除分节除法，让每节花满自己的天花板。`B2` 钉的是这个功能存在的理由——**可达条目严格变多**（完整条目 + 索引行；被索引点名即可找到，两处都没有才是不可见）；`B3` 钉住它仍然是**有界**的，最大有界视图不等于整份文件 |
| `guard-probe.mjs` | 45/45 | 简报预算 / done 反自证 / 债结算 / 任务板归一化 / 机器层 B1–B7；**新增 E/E2**：债只能被**对得上**的证据结清——无关的通过验证、无关的 mistake 都不许让债段消失，只能把它降级成一行点名（`proofCoversTarget`；旧规则下一条 `echo hi` 就能清空整个债段，2026-10-02 实测）；**新增 H1/H2**：四个并发写进程不丢条目、不留锁文件（2026-10-03 起改走**文件报告** `stdio:'ignore'`，所以在受限通道也真的会跑，不再是 skipped）；**新增 A6/A7 + I1–I5（2026-10-03，账本有界化）**：40 条的账本仍在预算内成简报、且查询能取回简报显示不了的条目全文、能到达机器账本、能自证的坑（`trigger:`）排在更新的纯散文坑之前、同一症状记两次合并成一条并标 `recurred:`、有界化绝不裁剪文件；**新增 B7（2026-10-03）**：机器事实段按**最近写入**排序、装不下的会被**点名**（含字数）而不是按大小丢弃 |
| `budget-probe.mjs` | 29/29 | 事前拦（大文件读被拒）+ 裁剪算法；**fixture 改到 `os.tmpdir()`**，报告仍重写自己那三份（写不进去时只报 stderr，退出码只看检查） |
| `budget-chain-probe.mjs` | 16/16 | 裁剪链与 `code_brief` 工具面 |
| `gate-probe.mjs` | 39/39 | `code-gate` 事件链（提醒、落债、文档后缀豁免、轮次顺序）；**3a 与 4.verified-turn-silent 改为新契约**：跑在 `code_verify` 之外的命令**不再算证据**——它现在落一条 `state:"ran"` 的债（带命令原文），只有 `code_verify` 让回合静默收尾，`state:"none"` 与 `state:"ran"` 在 journal 里可区分 |
| `gate-journal-probe.mjs` | 7/7 | **新增**：`DSH_CODE_GATE_JOURNAL` 开关下，门禁真实做过的每个决定都落成 JSONL（edit/run/notice/notice-delivered/turn-stopping）；没开开关时一个字都不写；追踪路径写不进去时被吞掉、绝不因此弄坏回合。这是「code-gate 缺可复跑端到端判据」那一项的落地 |
| `debt-audit.mjs` | 23/23 | **文档断言 vs 代码事实**（专治散文陈旧）；**D5/D6**（三份文档的行数、DESIGN 的嵌套条目总数）、**R3/R4**（报告新鲜度、HANDOVER 引用 budget 报告的数字）、**E1**（全仓文本文件必须是严格合法 UTF-8）、**R5–R10**（真去**跑**只需普通 node 的探针，拿它们自报的 passed/total 与 TESTING.md 的「期望」行、probes/README 的 check 数、HANDOVER 的结果表逐处比对，并盯住本审计自己的条数——这类数字此前无人看管，实测已陈旧两处）。**2026-10-04 起 `RUNNABLE` 增加下面两条**，两者都必须写 `-report.json`（本审计用 `stdio:'ignore'` 起子进程，读不到 stdout，没有报告文件就判「没有结论」） |
| `pattern-budget-probe.mjs` | 17/17 | 坑的**正则必须有界**：ledger-core 审计 F2 实测 `code_brief({topic})` 在 26 字符 topic 上 21,432 ms、34 字符不返回。这条判据存在的理由写在账本里——**「别把一次测量当成边界存在的证明」**：这个修法的第一版是用一个锚在字面空格上的模式「验证」的，0 ms 返回、边界从未触发。所以 `P1` 断言的是**耗时**（病态模式必须快速返回），`P2` 断言决定来自有界路径而非内联，`P3` 反向钉住「加了边界不能把功能弄死」（普通模式仍命中），`P4` 走真实 `brief({topic})`，`P5` 覆盖 `code_verify` 的 `expect:'re:…'` 且 `m` 标志仍在，`P6` 钉住 `pit-guard` 用的异步路径契约不变。**过程中它抓出三个我自己的真 bug**：缓存键少拼 `flags`（同步路径从未命中过任何已证便宜的 pair）、共用一个 worker 导致队列被病态模式饿死（后 8 个任务含普通模式全部超时）、以及 `retireWorker` 不结算在飞任务会让 `await` 永不 settle |
| `repeat-identity-probe.mjs` | 17/17 | 坑的**标题是身份**：审计 F6 实测两种塌缩（`.slice(0,60)` 截断、非 CJK 非 ASCII 症状一律退化成 `mistake`）都会把无关的坑并进别人条目里，第二条的规则永远进不了 `mistakes.md`。修法是整串输入的摘要只在**有损**时追加。但身份一旦过于精确就有反向失败：**真重复不再合并**，`recurred:` 不涨而账本变长。所以 `R1` 钉住同一症状两次仍合并（修法可能弄坏的功能）、`R2` 前缀相同的不同坑不再合并且两条规则都可读、`R3` 非拉丁症状各有稳定身份且同一症状仍合并、`R4` 改述过的重复**不被静默吞掉**而是点名提示、`R5` 短输入保持旧 slug 逐字节不变、`R6` 提示折进 `summary` 而不是新增键（`output.schema` 是 `additionalProperties:false`，新增键会在**写入之后**被拒） |
| `build-preset.mjs --check` | PASS | 组合未漂移（standard 33 / code 42，无 unexpected additions） |
| `check-prompt-section.mjs` | PASS | `code-ledger` 提示段（含 Working habits）真的进了请求 |
| `aegis-activation-probe.mjs` | 5/5 | Aegis 停在 `explicit`、skill 目录仍在 |

真实会话侧另有两条独立证据：① 系统提示里已是账本协议 + Working habits 六条、**Aegis 的 routing bootstrap 已消失**；② `code-budget` 在真实会话里拒绝了一个 300 KB 的整文件读（理由带真实大小与 token 估算）。

## 三、铁律（都是踩出来的）

1. **profile 依赖必须用 `link:`，不能用 `file:`** —— `file:` 会拷副本，之后改工作区代码宿主仍加载旧版。
2. **新增任何 `@deepseek-ai/*` import，必须同步写进 `peerDependencies`** —— 裸包名路由只认它，少一个就 `ERR_MODULE_NOT_FOUND`。
3. **改 `lib/*.js` 或 `cordis.patch.yml` 后必须重启 DSH** —— preset 行会热加载，但子插件模块只在挂载时 import 一次。
4. **绝不在会话中途改 profile / 组合 / 插件文件** —— 实测代价：一个 60 万 token 的会话里，两次这样的编辑各触发一次整段缓存作废，单次约 59 万 token 按全价重读。
   **第二次量到（2026-10-02）**：改完 `lib/prompt.js` 后重启、并且**恢复**（而不是新开）旧会话，那一次请求的**未缓存输入 306,313 tokens**（占该请求 99.3%、占整个会话未缓存输入的 66%），因为系统提示段在请求前缀的最前面、文本一变就整段换不上缓存；同会话其它请求每次只新增 200–1,200。**量法**：`node probes/context-cost.mjs`（新增，报告"前缀重发事件"＝未缓存占比 > 50%）。
   **怎么免掉（三条）**：① 这类编辑**攒到会话开头做**（新会话只有系统提示 ~10k，恢复旧会话要重发整段历史）；② 改完先跑 `node probes/context-cost.mjs` —— 它会比较**磁盘上的 `lib/prompt.js` 正文**与**最后一次真正发出的 `system/message`**：相等 = 缓存安全，`LIVE DIFFERS` = 下一步重启就会换前缀，并直接给出"新开会话"的建议（也可用 `DSH_CODE_PREFIX_FILE` 指向别的提示文件）；③ **重启后开新会话，不要恢复**。
5. **`.txt` 不算文档**：`code-gate` 的 `docExtensions` 默认只有 `.md/.mdx/.rst`。想验证门禁要写代码后缀的文件。
6. **装/改模式走官方路径：`plugin_manager`** —— 新建或覆盖 preset 都是 bundle 补丁，用 `plugin_manager` 装进 profile（客户端文档原文），本模式与 profile patch 都已放开这个工具。**它的每个动作需要审批**：会话审批策略必须是「询问」，设成 `never` 时调用会被直接拒绝、看起来像卡死（这就是当初把它禁掉的原因）。手工改 manifest + 跑 pnpm 只是绕过审批的绕道，审批可用时不要用。
7. **PowerShell 会骗人**：控制台把 UTF-8 中文显示成乱码；`Get-Content`→`Set-Content` 回写会把文件按 ANSI 重编码、**不可逆地毁掉标点**（本仓库三份文档就被这样毁过一次，只能重写）。判文件内容/完整性一律走 Node + `JSON.stringify`；**写文件不要用 `Set-Content`**。
8. **DSH 重启后 fs 观察不持久化** —— 改文件前先 `read`，否则报 `file has not been read`。
9. **billion-context 已弃用**（profile patch 里 `bili-native: disabled`，并加 `compaction-basic: auto: true` 覆盖它的 bundle 补丁）—— 它的压缩付全价重读、省的是便宜的缓存读。
10. **受限通道写不写得了，取决于对象有没有「低完整性标签」，不只是 ACL**（2026-10-02 查清机制）：沙箱子进程以 **Low 完整性**运行，而 DSH 只给工作区**根目录**加了写授权（`S-1-4-<host-specific>:(OI)(CI)(W,D,DC)`）与标签（`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`）；**已存在**的子目录（本仓库的 `probes/`、`lib/`、`.dsh-code/`）两样都没有，于是往它们里面写文件就是 `EPERM`——而同一条命令写工作区根目录却成功。**给子目录补 ACL 写授权不够**（实测补完仍 EPERM：缺的是标签），补标签要写 SACL、需要提权，本机护栏禁止提权（`icacls /setintegritylevel /T` 实测报 43 files processed，但事后查文件仍无标签、4 个目录 Access denied）。`code_verify` 那条 shell 更严（写 `$env:TEMP` 可以、写工作区被拒）。结论：探针的 **fixture 一律 `os.tmpdir()`**；跨运行要留存的**报告只能在一次不受限调用里生成**，其新鲜度由 `debt-audit` R3 把陈旧报告变成红判据、而不是让它静默地绿。宿主定性标记：`[sandbox denied this command under the session's current file policy]`。
11. **`$env:TEMP` 是每条命令一次性目录**，命令结束即清空 —— 「写 TEMP、下一条命令再读」不通。
12. **`$env:X='1'` 会留在 `pwsh` 工具的进程里活到本会话结束** —— 一条命令里设了 `ELECTRON_RUN_AS_NODE='1'` 之后接着跑别的探针，那个探针会以 node 模式启动，于是报出与代码无关的 `EPERM`/`ERR_MODULE_NOT_FOUND`。跨步骤跑探针时在同一行里显式清理。
    另注：`budget-probe.mjs` / `budget-chain-probe.mjs` / `acceptance-probe.mjs` / `gate-probe.mjs` / `aegis-activation-probe.mjs` **要用 Electron 二进制**跑（经 asar 加载宿主解析）；`guard-probe.mjs` / `build-preset.mjs` / `debt-audit.mjs` / `check-yaml.mjs` / `check-prompt-section.mjs` 普通 node 即可。
13. **机器事实写 `scope="global"`，别在每个项目重付一次**（2026-10-02）：`code_record({kind:'mistake', scope:'global', trigger:'…'})` 落 `~/.dsh-code/mistakes.md`，每个项目的 `code_brief` 开局都会带出 `## Machine-wide facts` 段（含 `files:`/`trigger:`）。坑的 `trigger:` 在**动手前**匹配命令行（`pwsh`/`bash`/`shell`/`code_verify` 的 `cmd`/`command`/`script`，大小写不敏感），是条目自己写的显式正则；**写错 = 那条坑不响而且不报错**，所以写新的 trigger 要在探针里造一次真实命中。

## 四、几处容易误判的地方

- **别用关键词包含判「某段在不在」**：mistake 正文里会引用「## Turns that changed code and ran nothing」这句话本身，`text.includes(标题)` 会假报「债还在」。用标题的精确索引或按 `\n\n## ` 切段。
- **别把主机级失败说成工具坏了**：`web_fetch` 只是对 github/huggingface 这类域名被 DNS 策略拒（`example.com` 正常）。
- **asar 头部记录的 `offset` 不可用**（block packing 会让它落到无关 blob）：要按文件首行定位内置 preset（`# Agent preset standard`）。
- **`code_record(kind="verified")` 只是声称**（journal 里 `claimed: true`），不算证据；要真证据只能用 `code_verify` 跑一遍。

## 五、已经拍板的事

- **账本位置（2026-10-02 修订）**：**项目事实**在项目内 `.dsh-code/`——`project.json`/`tasks.json`/`decisions.md`/`mistakes.md` 进版本控制随项目走，只有 `journal.jsonl`（机器证据流水）排除在外，规则写在该目录自己的 `.gitignore` 里。**机器事实**在 `~/.dsh-code/`，同名同格式、无 `tasks.json`。最初「一律放项目内、否决宿主目录」的理由是「跨项目复用但换机器就丢」，这条只对项目事实成立，对机器事实恰好相反（它装的就是这台机器的事实，本就该跨项目复用）。两个 scope 共用 `lib/ledger.js`，不新增模块与 plugin 行。
- **与 Aegis 的关系**：本模式内不再有 routing bootstrap 并存。做法是 Aegis 官方开关 `~/.config/aegis/config.toml` 里 `activation_mode = "explicit"`（Aegis 文档 §5 明确：`explicit` 只停自动注入，skill 目录仍完整、显式点名照常）。代价是**全局**；回滚 = 改回 `"auto"` 或删文件后重启。
- **工具清单**：沿用 standard 并追加，未换 `tool-presentation: ptc`。
- **`plugin_manager` 已放开（2026-10-01）**：profile patch（`C:\Users\dhhxfggg\.dsh\profiles\desktop\cordis.patch.yml`）里加了 `- id: tool-plugin-manager` + `disabled: false`，按 id 覆盖掉 preset 行内联的 `disabled: true`。这样「用创造模式新建/覆盖 preset」就能走官方路径：写 bundle 补丁 → `plugin_manager` 装进 profile。实测：`plugin_manager(list_plugins)` 列出 `include:tool-plugin-manager` 为 `enabled: true / active / patchId: tool-plugin-manager`；`set_plugin(target:"include:tool-plugin-manager", enabled:true)` 返回 `{"application":"applied"}`（**target 必须是列表里的 `entryId`，传 patchId 会报 `unknown-plugin`**）。
  代价：该工具的说明写着每个动作都「需要 danger-full-access 或本次调用获批」，所以**会话审批策略必须是「询问」**；设成 never 时它会被直接拒（表现为点了没反应）。审批策略是宿主会话设置（`ctx.approval`，不是配置文件），在 GUI 里切换。

## 六、仍未做的
- **`code-gate` 的端到端判据已补（2026-10-02）**：`lib/gate-verify.js` 现在有显式开关 `DSH_CODE_GATE_JOURNAL`——开着它，门禁在真实宿主里做过的每个决定（edit / run / notice / notice-delivered / turn-stopping）都落成 JSONL，`probes/gate-journal-probe.mjs`（7/7）把开关的两个方向都钉住了（不开→一个字不写；开了→决定齐全；追踪路径写不进去→吞掉、绝不弄坏回合）。**仍未实测的只剩一件事**：在一个真实会话里开着这个开关跑一轮，用产出的 JSONL 与桩驱动的 `gate-probe` 结果对照（桩已经 39 项）。这条现在是「还没跑」，不再是「没法跑」。
- **`code_verify` 通道只读**、**`web_fetch` 部分主机被拒**：宿主侧问题，本包只能记录（见 `INSTALL.md` 已知缺口）。
- **`done` 反自证是按会话计数的**：长会话里跑过任何无关验证，未验证的 done 就不再被警告。
- **冷启动与跨项目隔离**未实测：需要一个真实新会话选「编程模式」，确认开局自动 `code_brief` 且读写的是该工作目录的 `.dsh-code/`。
- **`code-pit-guard` 已在真实会话里跑过（2026-10-02 补记，两次都真的响了）**：读取侧——编辑 `probes/budget-probe.mjs`、`INSTALL.md`、`lib/ledger.js` 时分别收到对应坑的 `do not repeat` 原文（原文出处唯一：`lib/pit-guard.js:168`/`pitNotice`，整份 `app.asar` 里没有这些句子）；写入侧——本会话第一条 `pwsh` 命令死在宿主准备阶段（`SetNamedSecurityInfoW failed … grantWrite`，命令还没跑就抛）之后，后续每一轮都收到「This turn ran a command that failed, and nothing has been recorded as a mistake yet」+ 失败命令行，写下 mistake 后停止。**`trigger:` 命令侧也已验证（2026-10-02 15:03 重启后）**：一条含 `Set-Content` 的命令在执行前收到 notice，原文引用机器账本那条坑。
- **`budget-report.{json,md}` 的新鲜度由 `debt-audit` R3 盯着（2026-10-02 已处理一次）**：报告陈旧时 R3 会（正确地）变红——修法是**在一次能写 `probes/` 的调用里重跑 `budget-probe`**。原因是铁律 10：`probes/` 对受限通道不可写。所以审慎的规矩是：**改了 `lib/budget.js` 或 `probes/budget-probe.mjs` 之后，在能写的通道跑一次探针**，否则下一次 `debt-audit` 会用红判据告诉你报告在说谎。**另加一层（2026-10-02）**：`debt-audit` 的 R5–R9 会自己去**跑** `guard-probe` 与 `check-prompt-section`，并把它们自报的数字与三份文档里的数字逐处比对——以后「文档里的通过数」不再靠人记得改。
- **机器级账本（`scope="global"`）已在真实会话验证（2026-10-02 15:03 重启后）**：① `code_brief` 正文里真的出现了 `## Machine-wide facts (true of this host, every project)`，带 `Ledger: <home>\.dsh-code`、5 条机器事实与机器坑，超预算时按条数点名丢弃；② `code_record({kind:'mistake', scope:'global', …})` 真的写进 `~/.dsh-code/mistakes.md`（第 4 条，手写与工具写的混排无异常）；③ 命令侧：一条含 `Set-Content` 的命令在**执行前**收到 notice，原文引用机器账本那条坑并注明出处是 `~/.dsh-code/mistakes.md`。**判据侧的缺口**：`globalExcerpt()` 的 `Facts:` 行仍只有手验、没有 check 钉住（已登记任务）。
- **`lib/*.js` 的改动以「重启」为界**：今天 14:49–14:59 改完、15:03 重启，重启后本会话继续跑，新代码即时生效——这条是机器级事实（每个项目都适用），已落 `~/.dsh-code/`。
- **P4（技能树 `skills.registerProvider`、client 面板）** 未做（可选，`code_brief` 的账本协议已覆盖主要收益）。

## 七、下一步建议

1. **重启 DSH**，然后在一个真实会话里只看三件事：① 开局 `code_brief` 是否带出 `## Machine-wide facts`（先要有 `~/.dsh-code/` 的第一条机器事实——建议就用 PowerShell 写文件那条）；② 跑一条含 `Set-Content` 的命令，是否真的收到那条坑的原文（`trigger:` 命令侧）；③ 编辑一个 `mistakes.md` 里点到的文件，是否收到坑原文（**这一条 2026-10-02 已经在真实会话里通过**）。
2. `probes/` 在本工作区对**受限通道**不可写（第六节）：探针的 fixture 一律在 `os.tmpdir()`，但跨运行留存的报告只能在能写的通道重跑。`debt-audit` 现在是 22/22，而且 R10 会盯住这个数字本身。
3. 用一件真活跑一遍（第一次已经做过：给 `wrap()` 加连字符折行，抓到两个真缺陷 —— 见 `LESSONS.md`）。
4. **`done` 反自证按会话计数**与**`files:` 路径写错也静默**（与 `trigger:` 同类，但 `files:` 无法在写入时验证——路径可能还没建）这两项还没动，是下一批的候选。
