# Decisions
## 2026-10-02 · 坑门禁做成独立插件 code-pit-guard（读侧动手前提 + 失败未记录落债），不加新工具、不改提示词

mistakes.md 的写入侧（code_record(kind="mistake")）与开局读取侧（code_brief 的 ## Known mistakes）早已存在，缺的是「动手那一刻」的触发，所以只补触发点。实现落在新文件 lib/pit-guard.js，注册进 cordis.patch.yml 的 code-memory 组（第 7 行）：1) tools/pre-execute 里按 mistakes.md 的 files: 栏反查本次编辑目标（按路径段匹配，不做子串猜测），命中就把该条 do not repeat 原文 + 条目位置排进队列，由 agent/pre-step 作为 notice 推到模型，同一会话同一条只推一次；2) tools/post-execute 识别失败命令（[exit code: N] 或 isError），agent/turn-stopping 时若该轮失败过且没有写入任何 mistake，就往 journal 落一条 mistake_unrecorded 债，code_brief 新增「## Failing commands nobody wrote down」段在**下一个会话**顶出，记一条 mistake 即结清。债的结清刻意**不**采用「之后跑通验证」：命令跑通不证明有人写下了为什么它跑不通。

Rejected: ① 加一个新工具（如 code_pit_check）——否决：模型不会主动调用它，等于把「记得查」又交回给态度，与 DESIGN 第 1 节的核心判断冲突。② 在提示词里加一条「先查 mistakes.md」——否决：提示词是背景噪音，且改 prompt.js 属于动缓存前缀。③ 复用既有 code-budget/code-gate 插件塞进新逻辑——否决：它们的职责已满（预算/未验证债），塞进去会让一个模块两个 owner。④ 失败指纹用相似度匹配历史失败——否决：会误伤固定脚本、重启服务这类合法重跑，噪声会把真信号淹掉（LESSONS 第 2 条同一个病）。

## 2026-10-02 · 机器级账本做成同一份 lib/ledger.js 的第二个 scope（~/.dsh-code/），坑新增 trigger: 命令正则走 pit-guard 的命令侧

需求：有些坑不属于任何项目而属于这台机器（PowerShell 5.1 写文件那次），记在项目账本里每个仓库都要重付一次。做法：ledgerDir/ledgerPath/exists/readProject 与 writeProject/initLedger/recordDecision/recordMistake/recordVerified 都加末位 scope 参数（SCOPE.global），globalDir() = DSH_CODE_GLOBAL_DIR 覆盖 ?? ~/.dsh-code；brief 新增 global 段（权重 5 / 上限 900，读机器账本的 project.json 事实 + mistakes.md 的坑，含各自的 trigger）；code_record 加 scope 参数并拒 kind=progress+global（任务板属于项目）；pit-guard 的读取侧查两个账本，编辑侧匹配 files:、命令侧匹配条目自己写的 trigger: 正则。**不新增模块、不加 plugin 行**，所以组合判据 build-preset 不变、只有一个 owner。探针里用 DSH_CODE_GLOBAL_DIR 指到 temp（受限通道写不了用户主目录）。

Rejected: ① 单独一套全局账本实现或新插件行 —— 否决：同一职责两个 owner，规则必漂，且要改 cordis.patch.yml 并重启。② 把机器事实写进每个项目的 .dsh-code/ —— 否决：这就是现状，换仓库必须重付。③ 全局坑只进 code_brief（被动）—— 否决：与 DESIGN 第 1 节的核心判断冲突（提示词/开局背景治不了动手那一刻）；只在开局出现的坑，动手时已不在注意力里。④ trigger 用相似度或关键词猜命令 —— 否决：本项目此前已否决过「失败指纹用相似度匹配」，会误伤固定脚本；trigger 必须是条目自己写的显式正则，写错就静默不响（已写进 DESIGN 第六节边界）。⑤ 放进 ~/.dsh/（DSH 自己的目录）—— 否决：那是宿主管理的目录，账本要能被用户直接读；放同级的 ~/.dsh-code/。

## 2026-10-02 · probes/ 写权限不做 ACL/SACL 手术：fixture 进 temp、报告在不受限通道刷新、新鲜度交给 debt-audit R3 说破

受限通道写不了工作区子目录（见 mistakes.md 的 MIC/标签那条），所以 probes/ 里的报告不可能在受限通道刷新。确定的分工：**fixture 一律 os.tmpdir()**（29 条检查因此两个通道都能跑）；**跨运行的报告留 probes/**，探针容忍写不进去（stderr 说明 + 退出码只看检查）；**报告的新鲜度由 debt-audit R3 判定**（报告不得比 budget-probe.mjs 或 lib/budget.js 旧），红了就在**一次不受限调用**里重跑探针刷新。2026-10-02 实测：完全权限重跑后 `debt-audit 15/15`、报告时间戳 14:58:40。

Rejected: ① 继续 ACL/SACL 手术让子目录可写 —— 否决：实测净效果为零（43 files processed 但文件仍无标签、4 个目录 Access denied），写 SACL 要提权，而本机护栏要求不手动提权。② 把三份报告也挪到 temp —— 否决：debt-audit 要跨运行比对它们，而 `$env:TEMP` 是每条命令一次性目录（铁律 11），下一条命令读不到。③ 删掉 R3、回到"md 与 json 互相一致"就算过 —— 否决：两份一致的陈旧产物正是这个仓库抱怨过的「绿的是 harness 不是产品」，删掉它等于把刚补上的洞再挖开。④ 让 budget-probe 在写不进去时静默跳过报告 —— 否决：静默正是问题本身；现在它把失败写到 stderr、退出码只看检查，由 R3 负责在简报/判据层把它说破。

## 2026-10-02 · 上下文成本做成可复跑的报告（probes/context-cost.mjs），不做成会失败的门禁

需求来自实测：一次重启后的未缓存输入 306k 没人能当场说清原因，我为它临时写了三个弃用脚本。改成常设报告 `probes/context-cost.mjs`：复用 `paths.mjs` 的 `sessionLogs()` 与 `unzstd.cjs` 读最新会话日志，输出未缓存/缓存读/输出总量、每次请求的未缓存占比、"前缀重发事件"（未缓存占比 > 50% ＝ 前缀被整体重发而不是追加）、超过 40k 的非重发大轮次。判据用**自校准比例**而不是绝对阈值，所以换模型/换预算都不用改。`--all` 打印每一次请求。它不改任何东西、退出码恒为 0，文件头写清楚"报告，不是门禁"。

Rejected: ① 做成门禁（超过阈值就 exit 1）——否决：重启后"恢复会话"天然会产生一次前缀重发，而本项目禁止"没有结算路径的告警"，一个每次重启都变红的门禁只会训练人忽略它。② 只写文档、让人手工分析——否决：这正是今天的做法，代价是三个一次性脚本 + 半小时。③ 塞进 `code_brief`（每会话自动报）——否决：它是"成本看起来不对时才看"的诊断，进简报等于给每个会话加固定开销，与它要治的病相反。

## 2026-10-02 · 探针的默认 stdout 只报摘要与 check id，全文进 temp 报告，`--all` 恢复原样

起因是实测：一次会话里 gate-probe 的汇总行被读进上下文两次，每次 3,869 字节（**我原先估的 ~50 KB 是错的**，子 agent 量出来并纠正了）。改成：默认 stdout 只打印 `{summary, findings:[ids], report, config?}`（`config` 仅在 JSON < 400 字节时带上），完整对象写 `tempReport('gate-report.json')`，`--all` / `--verbose` 打印原样。实测 3,869 → 182 字节（-95.3%），37/37 与退出码不变，四条 findings 全文（556/509/651/577 字符）都在报告文件里。理由：探针的 stdout 是喂给模型的，报告文件是喂给人的，两者不该共用一份格式。

Rejected: ① 直接从 stdout 删掉 findings 文本 —— 否决：调试失败时那正是唯一有用的东西；改成写进 temp 报告 + `--all` 恢复。② 加 `--quiet` 开关、默认不变 —— 否决：默认路径才是每会话花钱的那条，省钱开关要人记得加就等于没省。③ 把 `config` 硬编码丢掉 —— 否决：改成按长度动态判断（JSON < 400 字节才带），换配置不用改代码。④ 让所有探针都改 —— 否决：先只改实测最贵的那条（gate-probe），其余等有测量再动。

## 2026-10-02 · 审计报告：文档里"探针通过数"无人看管，已实测陈旧两处（TESTING.md 20/20 与 11/11）

本轮实测事实（命令与输出均在 journal）：① `node probes/guard-probe.mjs` → passed 27/failed []；`node probes/debt-audit.mjs` → passed 16/total 16；而 TESTING.md:17 写「期望 passed 20/20」、:18 写「期望 passed 11/11」，**两条都陈旧**；② HANDOVER.md:27 与 :74 写 debt-audit 16/16（对），但 :82 写「让 debt-audit 回到 15/15」（错，同一份文档自相矛盾）；③ DESIGN.md:58 写「probes/ 十一个判据文件」，实际 probes/ 下 .mjs/.cjs 共 15 个；④ HANDOVER.md:27 写「全仓 29 个文本文件」，而 debt-audit E1 的 shippedText 实际是 30 项（lib 8 + probes 15 + 7 份文档）；⑤ 没有被怀疑的：guard-probe 27/27、pit-guard 24/24、acceptance 19/19、budget 29/29、budget-chain 16/16、gate 37/37、aegis 5/5、build-preset PASS、code 41 条 / code-memory 7 行 / DESIGN 的 41 条嵌套条目 —— 全部与文档一致。根因：`debt-audit` 的 D5/D6 只钉「行数」与「嵌套条目总数」，R4 只钉 budget-report 一处数字，**没有任何 check 钉住各探针自己的 passed/total**，所以这类数字只能靠人记性。修法（最小、可判据化）：新增 checks 执行**只需普通 node 的探针**（guard-probe / build-preset --check / check-prompt-section），从它们的真实输出取数字与 PASS，再与 TESTING.md 的「期望 …」行、probes/README.md 表格、HANDOVER 表格逐处比对；Electron 通道那几个仍靠 R3/R4 的新鲜度规则挡。这条之所以值得先做：`probes/README.md` 自己写着「Every bug this mode has had becomes a check here」，而「文档数字陈旧」正是本仓库复发率最高的一类 bug（LESSONS 开篇 5 个缺陷里就有 1 个是它）。

Rejected: ① 从探针源码静态数 `check(` 调用数 —— 否决：实测 guard-probe 静态 23 个 `check(` 而运行 27 条（第 146 行的 check 在 for 循环里跑 5 次），静态计数会系统性地算错，且错了以后没人能发现。② 让每个探针把结果写进 probes/ 的 JSON 报告、audit 读报告 —— 暂不采用：受限通道写不了 probes/（铁律 10），会把「数字对不对」变成「这次通道能不能写」，实测 budget-report 已经为此吃过一次 R3 变红。③ 只改文档数字、不加 check —— 否决：改一次数字只是把债推给下一个人，本仓库的规矩是自己会变成 check 的 bug 才叫修完。④ 把 Electron 探针也拉进 audit —— 否决：audit 是普通 node 通道，拉 Electron 会把「跑得动」变成前置条件，环境不对时 audit 全红，噪声换真信号。

## 2026-10-02 · P1 落地：债只能被「对得上」的证据结清，对不上的降级点名而不是静默消失

**规则**：一笔债只能被「对得上它的证据」结清，对不上的一律不消失。① unverified 债（改了文件没跑命令）：证据是之后的 `code_verify`，且必须 `ok:true`、非 claimed（沿用原规则）**并且**与被改文件对得上——两种对法任一即可：(a) 结构对得上：那次验证是在被改文件的祖先目录里跑的（新记 `cwd` 字段，`lib/ledger.js` 的 `coversPath`）；(b) 字面对得上：验证的命令行或输出尾部点到那个文件名（`fileTokens`/`mentionsPath`）。② mistake 债（命令失败又没写下来）：证据是之后记的一条 mistake，且它必须**点到这次失败**（记的 files:/任意栏文本里出现那条命令或它的失败特征），否则不算。③ 对不上但不能消失（铁律：任何省略都要说出来）：仍在债列表里，但降级成一行点名——「另有 N 笔更早的债，最近一次验证/最近记下的坑都没点到它们，仍在 journal 里」，并给出补记的写法。**为什么**：实测（探针临时脚本，证据在 journal）`code_verify` 不带 expect 时只要求 exit 0，所以一条 `echo hi` 就能让「## Turns that changed code and ran nothing」整段消失；一条无关的 mistake 同理。这两个段是本模式的核心卖点，静默清空等于把卖点变成摆设。**代价与维护**：`(a)` 的结构匹配会让「在仓库根跑一次验证」结清该仓库下任何文件的债——宽，但和「在同一个项目里跑过测试」的直觉一致；要更紧就把记录里的 cwd 当成项目根来缩小范围。新增的 `cwd` 字段是向后兼容的：老 journal 条目没有它，就退化成只按 (b) 字面匹配，不会因此丢债。

Rejected: ① 只把水位线改成「必须晚于债」——否决：一个字没解决，`echo hi` 仍然晚于债。② 要求 `code_verify` 的 cmd 里出现被改文件名才算结清 —— 否决：`pnpm test`、`npm run build` 这类项目级命令一个文件名都不提，会把真验证判成没验证（假阴性比原缺陷更伤）。③ 把结算权完全交给模型显式声明「这笔债结清了」——否决：那是把硬判据换回自觉，本模式的立身之本就是不靠自觉。④ 债永不结算、只靠预算裁剪 —— 否决：这是 2026-10-01 已经修过的病（旧债永久占预算、把真信号淹掉）。

## 2026-10-02 · 读包内实现走 asar 探针（probes/asar-read.mjs），不走解包、不改安装目录

安装是 asar 打包分发，`resources\app.asar\dsh` 不是目录；但 ELECTRON_RUN_AS_NODE 下的 Electron 二进制自带 asar 的 fs 钩子，`fs.readFileSync/realdir/readdir('<asar>\dsh\...')` 都能用。于是新增 probes/asar-read.mjs（list/read/lines/grep/to）作为「读内置实现」的唯一入口，复用 probes/paths.mjs 的 ASAR 发现逻辑。约束：sandbox 下 shell 通道不能写工作区、每次命令只给一次性 TEMP 子目录，所以探针的输出要么打印、要么写到当次 $env:TEMP（跨命令拿不到）。

Rejected: ① 解包整个 app.asar 到工作区（121 MB，且会掩盖真实运行的是归档里的副本）；② 直接改安装目录里的文件（安装目录不是源码，改它等于改发布物）；③ 只依赖 Web 文档/记忆推断内置行为（会写出对不上实现的方案）。

## 2026-10-02 · 压缩闸门做成 agent/pre-step 上的旁路闸门，不替换引擎：问人三选一，所有问不到的路径 fail-open

在 agent/pre-step 这条 waterfall 上加一层「先问人」的闸门，而不是替换或调参内置压缩。理由：这条事件是内置引擎自己触发压缩的地方（dsh-compaction-basic/lib/index.js:839 → compactIfNeeded :941），同一条事件上按注册顺序再挂一个 handler 就能抢在它前面；插件返回 {kind:'reject'} 能停回合、next({messages}) 能把指令挂到这一步。所以闸门可以只做「问」和「放行」，压缩仍旧是引擎自己的行为——本插件不新增任何压缩路径，也就不可能产生引擎不会产生的压缩。三个选项各自的代价：压缩=引擎照常（人放弃这次机会）；让我继续=不压但记账（按占用率+5% 才再问，避免每步都弹卡）；写交接文档=把收尾指令挂在这一步（不是停回合，因为停回合不会让模型去写文档，只会把回合结束掉，模型根本没机会读那条指令）。另一条硬约束：所有「问不到」的路径必须 fail-open 放行——一个拦不住的拦截器比没有拦截器更糟（NO_PROVIDER/超时/答案无法识别/窗口未知/表抛异常）。「让我继续」不会被无限滥用：真的接近 100% 时 provider 会报 context overflow，dsh-compaction-basic 的 agent/request-error 兜底路径（:861）会强制压一次。

Rejected: ① 把内置 compaction 行整个换成本项目自己的引擎：等于把「压缩到底怎么压」也接过来维护，而这一版只想要一个「先问人」的岔路——收益一样、代价大得多。② 只把 thresholdRatio 调到 0.95 让压缩晚点来：改的是引擎的阈值（对所有人所有会话都生效），而且不改行为——到点还是悄悄压，人还是没得选；且越接近 100% 越容易撞 provider 的 context overflow 硬报错。③ 只做「提醒」不做「拦」：靠模型自觉收尾；实测这类提醒会被忽略（本模式自己的 LESSONS：只记录不改行为的半边等于没做）。④ 在 80% 处直接 reject 这一步、逼人先回答：丢掉「本来还能做完的最后几步」，而且人不在时整个回合白停。

## 2026-10-03 · 压缩闸门从 0.8/0.65 降到 0.75/0.6：判据全绿但一次没响，因为线画在真实会话够不到的 80 万处

用新探针 probes/gate-chance.mjs 读 90 个真实会话日志量出：真实 contextWindow 一律 1,000,000（来自真实 request/context 帧），单会话峰值分布双峰，右峰 28 个会话压在 75-80%，历史最高 79.86% = 798,563，**0 个会话到过 80%**；闸门挂载之后（2026-10-02T14:49Z 起）连 65% 都没到过。于是原阈值（gateRatio 0.8 = 80 万，warnRatio 0.65 = 65 万）等于永久沉默——32 个会话越过提醒线，没有一个越过提问线。拍板降到 gateRatio 0.75 / warnRatio 0.6：0.75 落在 p75-p95 之间（28/90 个历史会话会越过），0.6 给提醒留 15 个百分点的缓冲。同时把判据补成不靠默认值互证：R1 改成断言「引擎自己仍是 0.8」这个字面量（原来拿它比闸门的库默认值，同一个默认的两份拷贝互相作证，正因如此 30/30 全绿而功能空转）；新增 R5（预设声明的线必须低于 0.8 这个真实会话够不到的天花板）与 R6（声明值经 resolveLimits 真的成为挂载边界）。文档三处通过数 30→32 同步；debt-audit 独立复跑确认（23/23，wrong: []）。代价与边界：这次改的是 config 不碰提示词（不会作废前缀缓存），但**必须重启 DSH 才生效**；且阈值只是必要条件——「真实会话里真的弹卡、三个选项各自生效」仍然没有现场证据，`gate-chance.mjs` 现在会在下次越线时给出第一个证据点。

Rejected: ① 保持 0.8 不动、只加可观测（照 code-gate 的 DSH_CODE_GATE_JOURNAL 加调试开关）：能留下现场证据，但阈值本身不可达，等不到证据，等于把问题留到以后。② 降到 0.5-0.6 让闸门更早介入：更早拿到选择，但长会话会频繁弹卡，而且 0.5 已经在多数会话（中位数 26.57% 之外）也会触发，噪声太大。③ 不动阈值、改去调引擎的 thresholdRatio：改的是引擎行为（对所有会话生效），闸门只是跟着动，等于放弃「先问人」这条独立岔路。④ 把 done 反自证那类「软提醒」当替代方案：实测过这类提醒会被忽略，本模式自己的 LESSONS 已记「只记录不改行为的半边等于没做」。

## 2026-10-03 · 账本有界化：简报=选集+索引+检索，写入侧合并而非追加；三条结构性缺口同轮闭合

实测起点（probes/ledger-census.mjs）：项目 30 条坑 29,696 字符、机器 77 条 80,571 字符、决策 10 条 9,454，而简报全段预算 8,900——真机上简报只显示「76 条机器坑因长度被丢弃」，读者看不到也问不到。改法分三层：① 读侧有界且有路——`shapeEntries()` 按重要性排序（recurred > trigger > files > 新 > 短）显示完整条目，其余渲染成一行索引（标题+trigger+files），索引放不下时给出「还有 N 条，用 code_brief({topic}) 取名」的标记；`brief()` 的**硬界在末尾强制**（按 maxChars 收口，不再只靠「按构造」），并且**先把发现提示与丢弃标记的额度预留出来再分配各段**（此前是先让各段花光、再追加提示，实测导致提示被裁掉——「有界」不等于「可读」）；② 取回路径——`code_brief({topic})` 现在同时检索两个账本的 mistakes+decisions（此前只搜项目库，机器库 96% 的规则按任何方式都取不到），提示段写明读法协议；③ 写侧只记重要的——同一症状（按 slug，不按带日期的标题）再记一次**合并**进原条目并标 `recurred:`/`last:`（复发是「规则确实需要」的唯一真实证据，也让它排到最前），既无规则又无检索坐标的条目被拒；**永不删除历史**，有界的是简报，文件仍是完整档案。同轮闭合三条缺口：Electron 三探针（acceptance/compact-gate/pit-guard）并入 debt-audit 的 probeRuns，改走 `DSH_PROBE_REPORT` 文件报告 + `stdio:'ignore'`，于是 R5 覆盖它们的 exit+报告、R6/R7/R8 覆盖三份文档数字（此前 acceptance 被文档写成 24/24 而实际 22/24，无人发现）；新探针 `probes/pit-liveness.mjs` 做 trigger/files 存活检查（只对「trigger 编译失败 / triggerSample 全不命中 / 有 sample 无 trigger」判红，过期路径只 WARN，global 的相对路径单独归类）；`lib/compact-gate.js` 写明库常量只是 fallback、挂载策略唯一权威是 preset，P1 的措辞随之改为「库回落」而非「产品默认」。判据证据：guard-probe 44/44（新增 A6/A7、I1–I5）、compact-gate 32/32、pit-guard 24/24、acceptance 24/24、debt-audit 23/23（R5 逐条列出四个探针 exit=0/reported=True）、build-preset PASS；真实账本下 brief 3510/4000 字符且发现提示在场。**未验证**：真实会话里新简报/检索的手感，需要重启 DSH 并新开会话（lib/prompt.js 已改，前缀会换，必须新开会话）。

Rejected: ① 直接加大简报预算（4000→8900 或更大）：模型不会读完更长的简报，而且这不能解决「总有一条最新的会被显示、其余永远沉底」——只是把墙往后推。② 给账本加淘汰/TTL（删旧条目）：与项目已有原则冲突（债靠补证据结清，不靠抹历史），而且旧的坑正是最贵的那批。③ 把索引全列出来（107 条约 9,600 字符）：超过总预算，等于用一个更大的段取代所有别的段。④ 把 trigger/files 存活检查塞进 debt-audit：那份审计是封装物属性、必须在任何机器上绿，而存活检查读本机账本、条目会合理变旧——混进去会让审计因某个项目的历史而红（本仓库已因同类原因被坑过一次）。⑤ 让受检探针改形状去适配审计的读取器：改为让审计同时读两种既有形状，不去动已经稳定工作的探针输出。

## 2026-10-04 · 转接文档改为「取 margin，不再问第二次」；不彻底禁用内置压缩（引擎 0.8 不可配，故保留为兜底）

用户要的是「上下文快满时写转接文档 + 新开对话」，并明确不彻底禁用压缩（保留自动压缩当兜底）。落地只有一处行为改动，全在 lib/compact-gate.js 的 action===2 分支：原来 `memory.granted = undefined`，于是选完「写转接文档」下一步又越线就**再问一次卡**；现在改成 `memory.granted = ratio`（复用「让我继续」已有的 marginRatio 机制，约 2 行，无新机制）并把 `memory.warned = false` 重新武装——理由是「写转接」是对**整段会话**的决定而不是对一步的决定，人类已经答过就不该再被问；但重新武装让撞到引擎那条线的那次越线仍然被说出来（静默地让引擎压掉正是本文件存在的意义要防的遗漏）。指令文案同步指向「新开对话」而不是「这步之后会被压缩」，卡片选项描述也写了「then open it as a new conversation」。**为什么不去动内置压缩的阈值**：引擎的 0.8 是 dsh-compaction-basic 里的常量（compact-gate.js:8-16 记它落在该包 lib/index.js:15），本仓库文档里 `thresholdRatio` 零命中、唯一被记录过的键是 `auto`（profile 已是 auto: true），所以「把引擎抬到 0.9」落在配置面之外——早先那条建议已撤回，不去猜键名写进 profile。**新开对话仍由人手动**（包内没有启动会话的能力），接续靠账本：转接写进 tasks.json 的 active 与 HANDOVER.md，新会话的 code_brief 带出来。

Rejected: ① 彻底禁用内置压缩（profile `compaction-basic: auto:false`）——用户否决：那会连「提供方溢出恢复」与修剪路径一起关掉，超窗时请求被直接拒，等于拆安全网。② 把引擎阈值抬到 0.9 让「先问人、不答才兜底」更贴合原意——撤回：0.8 是常量不是配置项，且 profile 注释只记录过 `auto` 一个键，猜键名风险大于收益。③ 只改文案不改行为——否决：用户要修的正是「写完转接还被再问一次」这个行为缺口。④ 给「写转接」加一条独立的 grant 机制——否决：marginRatio 已经在同一文件里做同一件事（G2/G3/G4 已钉住），再建一个就是第二个 owner。

## 2026-10-04 · 转接文档限定为「账本里没有的东西」；注入侧有界（静态提示段 + 简报字符硬界），代价是冷条目转为需检索

用户问两件事，都在已实测的机制上有确定答案。① **转接文档能不能只写「和项目最新进展/注意事项有关」的**——能，且这才是它本来的定位：转接指令（handoverText）现在是「范围限定 + 不写什么」两段，明确禁止把会话总结进去。真正的理由是**账本已经承载了其余部分**（project.json=怎么跑、tasks.json=在飞的任务、decisions.md=已拍板及理由、mistakes.md=已失败的、journal.jsonl=跑过什么），所以转接里重述这些就是重复劳动；转接只该装「下一段会话无法自己重新推出来的东西」：在飞任务的坐标、已验证 vs **未验证**的区分、已知半成品与下一步、会被踩到的注意事项。**不写**：会话摘要/叙事、试过又否决的探索（除非一行就能挡掉重来）、工具输出与命令流水（下一段能自己读）、token 计数与对任务标题的重述。② **账本无界增长会不会把注入撑爆**——注入侧是有界的，与账本大小无关：`lib/prompt.js` 的提示段是**静态文本**（源码第 14-18 行自述），属于每个请求的缓存前缀，不随账本增长；动态的部分只有 `code_brief` 一次调用，有硬界——工具默认 `maxChars 4000`（tool-brief.js:10），分节分配 `SECTION_BUDGET` 八个节各有硬顶（mistakes/decisions 各 1400、global 1100、project 1700 …），库常量 `UNCAPPED_TOTAL = 8900`。实测当前：两账本合计约 127,195 字符（项目 mistakes 35 条 34,295 + decisions 12 条 12,329；机器 mistakes 77 条 80,571），而简报只花 3,597/4,000（hard bound holds: true、omittedSections: []）、结尾一行自报「35 条坑与 12 条决定在项目、77 条机器坑」。**真正的代价不是注入变大，而是索引化**：一行索引约 79–94 字符，112 条全索引约 10,000 字符 > 简报预算，所以冷条目不再默认可见、只留计数，必须靠 `topic` 检索取回（这是 P9 有意选的取舍：可见的摘要 + 可检索的全文）。写入侧靠同症状合并（标 `recurred:`，重复反而是这条规则有用的最强证据）抑制增长，但**唯一新条目永不被裁剪**（本仓库明令永不删除历史）。**已知缺口（未修，登记在案）**：journal.jsonl 无界增长（现 328 行 / 396,412 字节），逐字节全读它的探针（guard-probe、pit-liveness）会随之变慢；它不进简报，所以不影响注入。


## 2026-10-04 · 未缓存输入增长与 Hindsight 插件无关（实测：103 个日志里只有本会话带其注入文本；峰值出自我改 prompt.js）；该插件当前因无 API token 而零价值

用户问「未缓存输入变多是不是因为装了记忆插件」。实测结论（`probes/hindsight-cost.mjs`，扫 103 个会话日志）：**不是。** ① 103 个日志里只有 **1 个**（本会话）带 Hindsight 自己的横幅文本（`bank_id`/`vectorize.io`/`hindsight_knowledge`），其余都**没有**它的注入文本——所以插件在这台机器上对提示词的边际成本，只有它注册的工具目录（静态、每次请求完全一致，属于可缓存前缀）。② 那 23 个「提到 hindsight 但没有横幅」的日志经字符串取证是**另一个不相关的 AstrBot 插件**（`astrbot_plugin_hindsight_memory`），与 DSH 的 Hindsight 无关——这正是「只数出现次数会得出错误结论」的实例，必须看字符串而不只是计数。③ 真正的未缓存峰值有明确出处：`context-cost --all` 显示 **19:27:29 那次 100% 未缓存（14,659）是我本轮中途改 `lib/prompt.js`（系统提示段）造成的整段前缀重发**，与本机已记的坑完全一致。**关于「值不值得留」的诚实回答**：`hindsight_diagnose` 报 `api_token_configured: false`、配置文件不存在，本会话每次 Hindsight 调用都 401——也就是说它现在提供**零记忆价值**，同时占着工具目录与反复 401 的失败。不是「便宜所以留着」，而是「没配 token 所以现在只有成本没有收益」。判断依据限于可观察行为 + 本会话日志，我没有审计该插件源码，所以「它架构上好不好」我说不了。

## 2026-10-04 · F2/F6 的修法：抽取 pit-guard 的有界正则匹配器给 ledger 复用，而不是在 ledger.js 里写第二份

背景（2026-10-04 实测）：`code_brief({topic})` 走 `lib/ledger.js:2416` 的裸 `new RegExp(trigger,'i').test(query)`，记录 trigger `(a+)+$` 后 26 字符 topic 实测 21,432 ms（14 字符 14ms／20 字符 337ms，≈×4/字符），34 字符不返回；`lib/ledger.js:2769` 的 `matchesExpectation`（code_verify 的 `expect:"re:..."`）同形。而 `lib/pit-guard.js:208-249` 早在 2026-10-04 就为**同一个病**修好了：内联预算 `PATTERN_INLINE_BUDGET_MS` + `expensivePatterns` 记忆 + 有界 worker，超时判 false。<br><br>**决定**：把这段能力抽成**一个**共享模块（canonical owner），`pit-guard.js` 与 `ledger.js` 都从它拿匹配器；`ledger.js` 的两个调用点改为 await 该匹配器（`searchEntries` 与 `matchesExpectation` 因此要变成 async，必要时把 `brief` 的调用链一起调整）。**否决**在 `ledger.js` 里复制一份等价逻辑——本项目正为「两个 owner 漂移」付过学费（`withLedgerLock` 的注释就写着 append 与 merge 曾各持一套锁语义），复制第二个匹配器下次只会再修一半。也否决「只在写入侧拒绝嵌套量词」：`expect:"re:..."` 由模型现场给出，不经过写入侧，拒绝不了。也否决「直接砍掉 trigger 正则匹配」：那一侧是坑门禁的核心价值（命令侧命中）。<br><br>**提交的后果**：`code_brief`/`code_verify` 的一小段变成异步路径；匹配器超时时必须回答 false 而不是抛错（一次跑不完的正则＝不命中，绝不能让门禁卡死回合）。判据要正反两向钉：① 病态 trigger + 长 topic 必须在有界时间内返回且不抛；② 正常 trigger 仍要命中（不能因为加预算就让规则失效）。

Rejected: ① 在 ledger.js 里复制一份有界匹配器——否决：两个 owner 必然漂移，本项目已为同类问题付过学费；② 只在写入侧拒绝嵌套量词——否决：code_verify 的 expect 由模型现场给，不经过写入侧；③ 直接取消 trigger 正则匹配——否决：那是坑门禁命令侧的核心价值；④ 把整段 brief 放进 worker——否决：改动面远大于病本身，且 brief 要读文件、传上下文，成本与风险都不成比例。

## 2026-10-05 · 转接收窄成两段（接下来/避免），因此改为从账本派生，而不是让模型每次写整篇

用户 2026-10-05 把转接（handover）的内容收窄成只有两件事：**接下来要做的** + **需要避免的**；并明确排除"不相关的话"与"用户的气话"。<br><br>**决定**：`handover()` 做成 `lib/ledger.js` 里的一个**只读派生函数**，复用 brief 的同一批内部读函数（`boardSummary`/`unverifiedExcerpt`/`unrecordedMistakes`/`mistakeExcerpt`/`decisionExcerpt`/`restartPending`/`clip`），输出**恰好两段**有界 markdown；调用方只传两个不可派生字段 `nextMove`（下一步）与 `stoppedBecause`（为何停）。<br><br>**理由**：① 收窄后几乎全部内容都可派生——"接下来"≈任务板在飞任务与未验证的债，"避免"≈带 `trigger:`/`files:` 的坑与不该重争的决定；② "用户的气话不要"这条由**结构**保证而不是由提示词约束——渲染器只读结构化账本条目，从不读对话原文，所以气话在结构上无法进入；唯一可能漏进语气的是模型写的那两个字段，而它正好被已有的写入侧告警（`PROSE_FIELD_LIMIT`、"既无 files 又无 trigger"告警）盖住；③ 派生不会陈旧，手工维护会。<br><br>**判据**：新增 `probes/handover-derive-probe.mjs`，其中 N3 是**反向**判据（叙事关键词必须进不来，且要先证明这组关键词有牙齿），N7 钉住 `handover()` 只读（调用前后账本字节不变）。

Rejected: ① **保持现状**：让模型每次收尾自己写整篇转接（`handoverText` 现在的做法）——被否，因为那正是"用户的气话/无关话"能漏进来的唯一入口，且每次成本随会话长度增长。<br>② **用户最初提议的"把转接文档写进账本、实时更新"**——被否：转接就不再是转接，而变成**第二份摘要**，账本一份、转接一份，两份会漂移；本项目已为"两个 owner 漂移"付过学费（`pattern-matcher` 那次，task note 有原话）。改成派生视图后，同一份事实只有一个 owner。<br>③ **把转接写进全局账本**（用户提"全局账本共通"）——被否：全局的定义是"换个项目还会咬你的事实"，转接正好是它的反面（极度项目专属、极度易腐），写进去会把本项目在飞的工作泄漏进这台机器上每个会话的 brief。

## 2026-10-05 · 效果审计不重算 liveness（那是 pit-liveness 的 owner），只 own 门禁代价与净成本

初稿的 `PLAN-effect-audit.md` 打算让效果审计重算「命中率 / 从未命中 / 零产出机制」——**那是在造第二个 owner**。`probes/pit-liveness.mjs` 已经在做 liveness（坏 trigger、失效指针、never-seen 命令、file-keyed never-matched、跨项目晋升候选），而且它的口径**已经被修过一次**：`neverSeen` 从"重放 trigger 正则"改成读真实 `trigger_hit` 事件，理由写在任务板上——重放会因命令被截断 200 字符而漏报、因复述而误报。再写一份必然与它漂移。<br><br>**决定**：效果审计的分工收窄为**只 own 无人拥有的三项**——① 门禁代价；② 每回合/每会话净上下文成本（`context-cost`/`mode-cost` 有算法，但没人做跨会话聚合）；③ 会话级/回合级代价分布。liveness 部分**引用 `pit-liveness` 的输出**，不重算；两边数字不一致时**报为缺陷**，而不是各自算各自的。<br><br>**同一轮查到的、决定这件事怎么做的事实**：`DSH_CODE_GATE_JOURNAL`（`lib/ledger.js:1959`）是一个**指向文件的路径**（不是布尔开关），`lib/gate-verify.js` 在 `edit`/`run`/`other-tool`/`notice`/`notice-delivered`/`turn-stopping` 六处调 `appendGateJournal`。实测 glob：**磁盘上不存在任何 gate-journal 数据文件**，只有读它的 `probes/gate-journal-probe.mjs`。所以**门禁代价没有历史数据、不可能事后补算**，想量只能从现在开始开着收。但有一个**已经无条件在落盘**的替代：`lib/ledger.js:1987` 的 `recordUnverified` 写 `kind:'unverified'` 条目，不受该开关约束——brief 的「Turns that changed code and ran nothing」段就是读它。所以效果审计第一步可回溯地回答「多少回合改完代码却没有任何证据收尾」，而「这次 notice 有没有送达」仍需 gate-journal。

Rejected: ① **效果审计自己重算 liveness**（初稿）——被否：第二个 owner，且必然与 `pit-liveness` 修过的口径漂移；本项目已为「两个 owner 漂移」付过学费（`pattern-matcher`）。<br>② **直接把 `pit-liveness` 改名/扩成效果审计**——被否：它跑在受限通道里有 spawn 限制的历史，且它的判据（坏 trigger、失效指针）与"代价"是两类问题，混在一个探针里会让"红了到底是机制坏了还是代价变高了"无法分辨。<br>③ **先开 `DSH_CODE_GATE_JOURNAL` 收一段时间再建审计**——被否（暂时）：开关是进程级环境变量，改了要重启 DSH，而重启会终结本会话；而且 `kind:'unverified'` 已经能让第一步今天就跑。

## 2026-10-05 · 不强行触发闸门验证，改为自动发现；并把"零证据机制"与人欠的动作都变成账本里的待办

用户 2026-10-05 指出「强行推到 0.75 过于浪费 token」，并提议「写个自动审核机制，如果我忘了就你上场记录了」。<br><br>**决定**：Gate 0 从"必须由人制造一次越线"改为"**自动发现**自然发生的越线"。理由不止省钱：人为填满上下文得到的是一次**非代表性条件下的测量**，而本项目自己的规矩是 *run it the way the real caller will*（这条在项目 working habits 里）；而且**「它会不会自然发生」本身就是该报的结果**——90 个会话里 28 个峰值落在 75-80%，但闸门挂载后同一项目反而没接近过（挂载后最大单请求 86,585），这个反差本身就是信息，不该用人造条件抹掉。<br><br>**机制三件**（写进 `PLAN-effect-audit.md` 第八节）：① 机制的「首次真实触发」自动发现——`compact-gate` 的判据是它在真实会话日志里作为消息源的次数（今天 **0** 次），这正是当初查出「两条通知从未送达」的同一个检测法，且已被证明有效（同批日志 `pit-guard` 1398 次、`gate-verify` 8 次）；② 「零证据机制」清单进 brief 的**预留 notices**（复用 `restart_pending` 已建的那条通道，它专门修过「通知被 clipTail 裁掉」）；③ 人欠的动作落成账本里有坐标的待办，由证据结清。<br><br>**为什么第 ③ 条是缺口**：今天**机制欠的债有人管**（`unverified`、`unrecordedMistakes`、`restart_pending` 三条都已建），而**人欠的动作只有散文在管**——Gate 0 原先只活在消息和一个 task note 里，跨会话就会丢。<br><br>**预算约束（已写进 plan）**：`code_brief` 是读函数（`lib/ledger.js` 明确注释它故意不写 `session_start`），所以检查必须纯读，且必须先定有界口径（只看最新 N 份日志／用已落盘标记做增量）并把口径写进报告——否则它自己就变成一条"从未被验证过成本"的机制。

Rejected: ① **按原计划强行把上下文推到 0.75**——被否：非代表性条件，且为一个人造数据点烧掉大量 token；用户明确指出这一点。<br>② **完全放弃验证，等它自然发生再说**——被否：那就回到了"人得记得去看"，而 110 个会话里没人看过一次（`code-compact-gate` 消息源计数 **0**）。缺的不是等待，是**自动发现**。<br>③ **新增一个定时任务/后台守护去轮询会话日志**——被否（本轮）：本会话没有可持久的调度器；`code_brief` 是天然的每会话钩子，且预留 notices 通道已存在，复用比自己造调度便宜得多。

## 2026-10-05 · T1 转接首屏被永久积压占据：只记档、不本会话改 lib/

2026-10-05（新会话实测，用户拍板）。T1 的 `handover()` 第一次对着真实账本产出转接文本后，`## Next` 首屏被一段「40 条失败命令没人写下来」占据。解剖后：67 条去重失败、覆盖 16 个会话、最早 2026-10-02、**属于当前会话的 0 条**、且**每个旧会话事后都记过 mistake**。它们结不清是因为 `mistakeSettlesFailures`（`lib/ledger.js:2290`）要求 mistake 正文**逐字**引用失败命令行或它的签名，而历史 mistake 写在"当时那条坑"上、不引用旧命令。<br><br><b>决定：只报不改</b>（用户选项一）。理由：① journal 是 append-only、没有"已处理"标记，改口径必须动 `lib/`，而本会话已到 79% 窗口，动 `lib/` 又要一次重启；② 三条候选修法里两条有害——删 journal 行违反"账本是证据"，放宽结清匹配会让一条含糊的 mistake 结清无关失败；③ 唯一要改的是**转接的取数口径**（`## Next` 只带最近一个会话、更早的降级成点名计数），这属于与 `lib/` 改动同批做的事。<br><br><b>落档</b>：写进 `PLAN-effect-audit.md` 第十三节，作为「零证据机制」家族的第四个处置对象。理由与另外三个同族：它们都让某种"从未发生"看起来像"还没轮到"，而这一条让"没人写下来"看起来像"欠着"——它其实是一条无人能还的债，却正被 T1 派生成下一个会话的首要任务。<br><br><b>另一条同时拍板</b>：两份 `PLAN-*.md` 提交为评审件（用户选项一），因为它们是目前唯一记录 T2–T6 与四个处置对象的地方。


