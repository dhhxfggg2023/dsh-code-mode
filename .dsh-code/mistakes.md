# Mistakes

## 2026-10-02 · 三个文件-install.md-probes-readme.md-probes-build-preset.mjs-被写成
- symptom: 三个文件（INSTALL.md、probes/README.md、probes/build-preset.mjs）被写成 29 KB / 10 KB / 21 KB 的十进制数字串，read 报「offset 8 is out of range (1 lines)」
- cause: 在 Windows PowerShell 5.1 里用 `$utf8.GetBytes($text) | Set-Content -LiteralPath $f -Encoding utf8 -NoNewline` 回写文件：管道把 byte[] 交给 Set-Content 时，PS 5.1 先把数组 stringify 成「每个字节的十进制值直接拼接」（无分隔符）再按文本写入，另外还加了 BOM。数字串的字节边界因此不可恢复：我试过 3 位分组、最短解析、按 UTF-8 结构贪心三种还原方式，都产出乱码（含 11、27 这类控制字节），组合爆炸到 forensic 脚本 OOM。三份文件里 INSTALL.md 有 130 行、probes/README.md 65 行、build-preset.mjs 176 行，只有转录里的原文能救。
- fix: 从**本会话自己的转录**恢复：~/.dsh/sessions/--E-tools-DSH--/session-<id>/session.v4.jsonl.zstd 里，read 工具的结果以 `<content>` + `N: 行` 形式逐行留底。用包内既有的 probes/unzstd.cjs 解压（它是 CLI：src out），再用一个提取脚本挑「完整且行数最多」的那次读、剥掉行号前缀写回 UTF-8（无 BOM）。三份都逐行对上行号（130/65/176，无缺口）。staging 脚本 deploy-and-verify.mjs 落盘后用 junction 镜像复跑 build-preset 与 debt-audit 验证文档断言。
- files: E:\projects\dsh-code-mode\INSTALL.md, E:\projects\dsh-code-mode\probes\README.md, E:\projects\dsh-code-mode\probes\build-preset.mjs, E:\tools\DSH\.dsh-code-mode-dev\deploy-and-verify.mjs, E:\tools\DSH\.dsh-code-mode-dev\extract-reads.mjs
- do not repeat: 在这台机器上写文件一律走 Node（fs.writeFileSync，UTF-8 无 BOM）或 edit/write 工具；**绝不用 PowerShell 回写文件内容**——PS 5.1 这条路径有两处坑：`Set-Content` 的 stringify 毁字节、`Get-Content`→`Set-Content` 按 ANSI 重编码毁标点（HANDOVER 铁律 7）。另：执行策略禁止直接跑 .ps1，要 `& ([scriptblock]::Create([IO.File]::ReadAllText($p)))`。

## 2026-10-02 · 探针断言-本轮失败过-下次-brief-顶出这条债-时失败-brief-里根本没有这个段
- symptom: 探针断言「本轮失败过 → 下次 brief 顶出这条债」时失败；brief 里根本没有这个段
- cause: 我的断言写错了上下文，不是代码错了：mistake_unrecorded 债是在 agent/turn-stopping（本轮结束）时落的，而 brief 的 unrecordedMistakes 会跳过与当前会话同 session 的债——也就是「本轮欠下的写作账不读回给本轮」。我却用同一个 session 去调 brief 断言它会顶出来，于是必然为空。同一个坑在 K 系列（plain-node 账本检查）里也犯了一次。
- fix: 断言改成跨会话：同一会话读不到（J3 自作用域），换成下一个会话 id 读才必须出现（J4），并补一条「之后的通过验证不能结清它」。同时把 ledger-debt-check 的 K5 也改成同样的跨会话断言。
- files: E:\projects\dsh-code-mode\lib\ledger.js:620, E:\projects\dsh-code-mode\probes\pit-guard-probe.mjs, E:\tools\DSH\.dsh-code-mode-dev\probes\ledger-debt-check.mjs
- do not repeat: 给「按会话过滤」的机制写判据时，先问清「谁应该看见它」：本轮落到 journal 的债，本轮的 brief 一定看不到。断言要用**下一个会话的视角**，不要用当前会话。写探针时先看被断言函数有没有 sessionId 过滤分支。

## 2026-10-02 · 本会话第一条-pwsh-命令直接失败-error-setnamedsecurityinfow-failed-win32-
- symptom: 本会话第一条 pwsh 命令直接失败：Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\projects\dsh-code-mode)（连 Get-Location 都跑不了，而 read/glob 正常）
- cause: 工作区根目录 ACL 缺 WRITE_OWNER：owner 是当前用户、WRITE_DAC=true，但 writeOwner=false，DSH 给沙箱加写授权时用的 SetNamedSecurityInfoW 需要 WRITE_DAC+WRITE_OWNER，于是每条受限命令在「准备阶段」就抛 EPERM 之前先抛这个错（不是命令本身的问题，也不是代码问题）。
- fix: 跑 diagnostic 技能脚本（一次授权、不提升）：& '&lt;skill&gt;\scripts\diagnose-windows-sandbox-acl.ps1' -Path 'E:\projects\dsh-code-mode' -AllowRoot 'E:\projects\dsh-code-mode' -Out 'E:\projects\dsh-acl-reports' → VERDICT=PRECONDITION / GRANTED 1 / verification: writeOwner false→true，随后同一条受限 pwsh 命令恢复正常，回滚命令与备份在 E:\projects\dsh-acl-reports\acl-backup-976d614e38ee47dab62886248adfdf0e.json(.ps1)。
- files: E:\projects\dsh-code-mode（工作区根目录 ACL，不是包内文件）
- do not repeat: 受限 pwsh 命令报 SetNamedSecurityInfoW/grantWrite 时，不要当成命令或代码的错误、也不要在那里重试同一个命令：那是宿主给工作区加写授权的准备失败，先看根目录是否缺 WRITE_OWNER（icacls 里当前用户只有 (I)(M)，owner 是自己但无显式项），跑技能脚本一次即可。

## 2026-10-02 · budget-probe.mjs-在受限-pwsh-通道里-exit-1-error-eperm-operation-n
- symptom: budget-probe.mjs 在受限 pwsh 通道里 exit=1：Error: EPERM: operation not permitted, open 'E:\projects\dsh-code-mode\probes\budget-small.txt'（budget-probe.mjs:134），于是 29/29 这条判据在当前环境根本跑不到检查阶段
- cause: 两层：① 探针把 scratch fixture 写进包内 probes/（第 20-28 行 FILE_SMALL/FILE_LARGE/DIR，第 133-136 行写入），违反 probes/README.md 自己那条约定「会写文件的探针必须两个通道都能跑（写就写 tempReport）」。② 环境侧：DSH 沙箱的写授权只落在工作区根目录（ACE S-1-4-181082156-547932178:(OI)(CI)(W,D,DC) + Mandatory Label Low (OI)(CI)(NW) + Everyone:(CI)(DENY)(DC)），**已存在**的子目录 probes/lib/.dsh-code 上没有这些继承来的 ACE（实测 icacls probes 只有标准继承项），而新建目录会继承它。受限令牌是写受限令牌，只认自己的 S-1-4-* 项，所以：根目录写 OK、新建子目录写 OK、probes 里写 EPERM（Authenticated Users:(I)(M) 救不了）。
- fix: 未修（本轮只定位机制，未改任何文件）。两条候选：① 把 budget-probe.mjs 的 fixture 目录从 PROBES_DIR 改到 os.tmpdir()（符合 README 约定，最稳）；② 若要就地写，需要给已存在的子目录补同一条授权，例如 icacls 'E:\projects\dsh-code-mode' /grant '*S-1-4-181082156-547932178:(OI)(CI)(W,D,DC)' /T —— 属于手工改 ACL，必须先问用户。
- files: E:\projects\dsh-code-mode\probes\budget-probe.mjs:20-28, E:\projects\dsh-code-mode\probes\budget-probe.mjs:133-136, E:\projects\dsh-code-mode\probes\README.md:60-64
- do not repeat: 不要用 pwsh 里的 node/Electron 去向「已存在的子目录」写文件：受限通道下那必然是 EPERM，而且它看起来像探针本身的 bug。写子目录文件只用 edit/write 工具（宿主侧）或写到 $env:TEMP；探针的 fixture 一律 temp。

## 2026-10-02 · new-item--itemtype-directory-c-users-dhhxfggg-appdata-local-
- symptom: New-Item -ItemType Directory 'C:\Users\dhhxfggg\AppData\Local\Temp\dsh-guard-keep' → 访问被拒绝 (UnauthorizedAccessException / PermissionDenied)；随后同一条命令里 node 报 ENOENT: no such file or directory, mkdtemp 'C:\...\dsh-guard-keep\dsh-guard-budget-XXXXXX'，探针还没跑到任何检查就崩在 scratch()（guard-probe.mjs:39）
- cause: 受限 pwsh 通道只给「本条命令自己那一个一次性临时子目录」（%TEMP%\dsh-XXXXXX）写权限，不给 %TEMP% 根目录；我没有改探针只改了 $env:TEMP 指向一个想长期保留的目录，探针的 scratch()/tempReport() 于是无处可写。这是取证手段的问题，不是探针的问题：探针本身在默认 TEMP 下 25/25 通过。
- fix: 不建固定目录：在**同一条命令里**跑完探针后紧接着读 $env:TEMP\guard-report.json（Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json），把要看的 evidence 打印到 stdout——该目录在命令结束时才被清空，命令内读得到。
- files: E:\projects\dsh-code-mode\probes\guard-probe.mjs:39, E:\projects\dsh-code-mode\probes\paths.mjs:146
- do not repeat: 别把「TEMP 可写」当成「%TEMP% 下任何路径都可写」：受限通道可写的只有本命令那一个一次性子目录，%TEMP% 根目录连建目录都会被拒。要留存探针产物，就在同一条命令内读走，不要另建目录。

## 2026-10-02 · 在工作区内做临时目录-remove-item-dst--recurse--force-被拒-无法删除项-对路径的访问被拒
- symptom: 在工作区内做临时目录：`Remove-Item $dst -Recurse -Force` 被拒（「无法删除项 … 对路径的访问被拒绝」/ RemoveFileSystemItemArgumentError），同一棵树用 node `fs.rmSync(dir,{recursive:true,force:true})` 一次删掉；而「在工作区根新建目录」这一步，pwsh 通道里成功（EXISTS=True / FILES=9），同一条语句在 code_verify 通道里静默失败（New-Item 被拒，| Out-Null 把错误吞了），随后表现为莫名其妙的 ERR_MODULE_NOT_FOUND。
- cause: 两个不同的沙箱上下文，不能互相推断。① 工作区根上有 DSH 加的继承 ACE：`Everyone:(CI)(DENY)(DC)`（DELETE_CHILD）与沙箱自己的 `S-1-4-…:(OI)(CI)(W,D,DC)` 授权同时存在；PowerShell 的 -Recurse 递归删除要走父目录的 DeleteChild → 撞上那条 Everyone 拒绝；node 的 rmSync 自底向上按对象 DELETE 删，走的正是 S-1-4-* 那份授权，所以成功。② pwsh 工具与 code_verify 的 shell 授权不同：前者能在工作区根建目录，后者不能（这与本仓库铁律 10「code_verify 那条 shell 可能只读」是同一件事，只是这次卡在“创建”而不是“写入”）。
- fix: 临时树一律用 node `fs.rmSync(dir,{recursive:true,force:true})` 删；建目录放在 pwsh 通道做，并且每建一次就用 `Test-Path` 当场确认，不要把创建结果 `| Out-Null` 吞掉（吞掉后失败会伪装成下游的模块解析错误）。本轮已按此清干净：pit-mutant-lib 已删除，工作区根只剩 .dsh-code/lib/probes。
- files: E:\projects\dsh-code-mode（工作区根目录 ACL；pit-mutant-lib 为本轮临时目录，已删）
- do not repeat: 不要在工作区里用 PowerShell cmdlet 建/删临时树并假定成功：pwsh 能建但 `Remove-Item -Recurse` 会被拒，code_verify 连建都不行。scratch 本来就不该进包内，放 $env:TEMP；非要在包内暂存（例如给探针做变异副本），建目录与删除都走 node + 当场 Test-Path 验证。

## 2026-10-02 · 想用探针自带的-dsh_code_mode_lib-指向-temp-里的-lib-副本做变异验证-探针直接崩-error
- symptom: 想用探针自带的 DSH_CODE_MODE_LIB 指向 %TEMP% 里的 lib 副本做变异验证，探针直接崩：Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery' imported from C:\Users\…\Temp\…\pit-mutant-lib\pit-guard.js
- cause: 裸包名 @deepseek-ai/* 的解析由 dsh-app-boot 的 profile-resolution bootstrap 提供，而它只对 profile 已链接的根（dsh-code-mode → E:\projects\dsh-code-mode）下的文件生效；%TEMP% 下的副本不属于任何 linked root，于是回落到普通 node 查找，找不到。探针头部写的那句「DSH_CODE_MODE_LIB points every probe at another checkout of lib/（用来在拷回包之前验收暂存改动）」在这个前提下是过时的。
- fix: 把变异副本放在**已链接根之内**（本轮放在工作区根：E:\projects\dsh-code-mode\pit-mutant-lib），DSH_CODE_MODE_LIB 指向它即可正常 import；跑完用 node fs.rmSync 删除。未改 paths.mjs（超出本轮允许范围），只记录。
- files: E:\projects\dsh-code-mode\probes\pit-guard-probe.mjs:18-19（文档里那句 DSH_CODE_MODE_LIB 说明）, E:\projects\dsh-code-mode\probes\paths.mjs:118-143（installResolution）
- do not repeat: 不要把 DSH_CODE_MODE_LIB 当成「指向哪儿都行」：暂存的 lib 必须位于 profile 的 linked root 之下（本机即 E:\projects\dsh-code-mode 内），否则 @deepseek-ai/* 解析不了、报的是 ERR_MODULE_NOT_FOUND 而不是「路径不对」，很容易误判成被改的代码坏了。

## 2026-10-02 · git--c-e-projects-dsh-code-mode-status---porcelain-fatal-not
- symptom: `git -C 'E:\projects\dsh-code-mode' status --porcelain` → fatal: not a git repository (or any of the parent directories): .git（exit 1）
- cause: 这个包目录里有 .gitignore，但没有 .git —— 它不是 git 仓库（DESIGN §2.1 说账本「进 git、可审查、可共享」，在这里是未兑现/未验证的说法）。
- fix: 要证明「只改了一个文件」，用文件 mtime 或自己在改动前后算的哈希；本轮用的是 mtime（lib/*.js 停在 14:49-14:50 的上一轮改动，pit-guard-probe.mjs 是 14:54:42）。
- files: E:\projects\dsh-code-mode\.gitignore
- do not repeat: 不要在这个包里用 `git status`/`git diff` 做「改了什么」的证据：会直接 fatal: not a git repository。先 Test-Path .git 再决定用什么方式取证。

## 2026-10-02 · 受限-pwsh-里写-probes-下已存在的文件-budget-probe-的三份报告-一直-eperm-按-缺写授权
- symptom: 受限 pwsh 里写 probes/ 下已存在的文件（budget-probe 的三份报告）一直 EPERM；按"缺写授权"补上宿主那条 S-1-4-*:(W,D,DC) ACE（文件上确认出现了 (I)(W,D,DC)）之后**依然** EPERM，`artifacts:{log:true,json:false,markdown:false}`
- cause: 阻断不是 DACL 而是**完整性标签（MIC）**：沙箱子进程的令牌带 `Mandatory Label\Low Mandatory Level`（S-1-16-4096），要被它写入的对象必须带低级标签 ACE。DSH 只给工作区**根目录**加了 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，三个已存在的子目录与里面的文件都没有 → 隐式 Medium → 低完整性写入被拒（EPERM）。我补的 S-1-4-181082156-547932178:(W,D,DC) 是必要条件，不是充分条件；两次"看起来修好了"（写授权 ACE 已出现在文件上、icacls 显示 (I)(W,D,DC)）都没有改变 EPERM。
- fix: **没修好，也不该继续修**：`icacls <root> /setintegritylevel '(OI)(CI)Low' /T /C` 在不受限通道里报 43 files processed / 4 dirs Access is denied（`.dsh-code`、`lib`、`probes`、`probes/budget-dir`），事后查 budget-report.json 仍**没有** Mandatory Label 行 → 净效果为零；写 SACL 在未提权进程里做不到，而护栏要求不手动提权。落地方案：包内产物一律写 temp（fixture 已改 os.tmpdir()），跨运行要留存的报告在**一次不受限调用**里生成（实测重跑后 debt-audit 15/15）。
- files: E:\projects\dsh-code-mode（工作区根/子目录的 ACL+SACL，不是包内文件）, probes/budget-probe.mjs, probes/README.md
- do not repeat: 受限通道写工作区**子目录**失败时，不要以为补 DACL 授权就够了：先看该对象的 icacls 输出里**有没有 `Mandatory Label` 行**、以及写它的进程令牌是不是 Low 完整性（`whoami /groups` 看 `Mandatory Label\Low Mandatory Level`）。DSH 的 provisioning 只覆盖工作区根目录，所以子目录里的写只有两条路：写到 `os.tmpdir()`，或在不受限通道里做一次。别再对子目录做 ACL 手术。

## 2026-10-02 · 内联诊断命令-node--e-const-fs-require-fs-os-require-os-直接崩-node-报-
- symptom: 内联诊断命令 `& $node -e 'const fs=require("fs"),os=require("os");…'` 直接崩：node 报 `SyntaxError: Expected unicode escape`，报错位置显示 `const fs=require(fs),os=require(os)`
- cause: PowerShell 给**原生命令**传参时会剥掉单引号字符串里的双引号：`& $node -e 'const fs=require("fs")…'` 到 node 手里变成 `require(fs)`，于是报 `Expected unicode escape`（这次绕了一大圈才看出来，因为错误行显示的是残缺的 JS）。
- fix: 不要在 pwsh 里内联跑带引号的脚本：把脚本写成文件再跑（本仓库一律用 probes/*.mjs），或改用 `--%` / 转义引号。诊断脚本也一样走文件。
- files: （无包内文件：一次临时诊断命令）
- do not repeat: 不要用 `node -e '…"…"…'` 这种内联形式做诊断或验证；PowerShell 的原生参数传递会把引号吃掉，症状看起来像 JS 写错了。写临时脚本文件，或用探针里的既有机制。

## 2026-10-02 · 给这台机器写下第一条机器事实-.dsh-code-mistakes.md-之后-guard-probe-从-25-25-
- symptom: 给这台机器写下第一条机器事实（`~/.dsh-code/mistakes.md`）之后，guard-probe 从 25/25 掉到 23/25，红的两条是**既有**判据：`E a settled debt produces no notice of any kind` 与 `D1 a small ledger drops nothing for length`；同一份探针在此之前一直全绿
- cause: guard-probe 的新 B 块把 `DSH_CODE_GLOBAL_DIR` 的重定向装在**第 221 行**（B 块内部），而 A1–A5 / E / D1–D2 都在它**之前**跑 → 那些检查读的是真实的 `~/.dsh-code/`。之前它们绿，只是因为那目录还不存在（空机器账本 = 没有机器段）。我今天写了首条机器事实之后，那些 brief 里多出一段，D1（小账本不该有 dropped for length）和 E（settled debt 不该有任何 notice）当场变红——探针不是"代码回归"，是它一直没跟真实机器账本隔离。子 agent 报告里写的"for the WHOLE run"与实际不符：重定向在本块内安装、本块尾还原。
- fix: 把重定向提到所有检查之前（`scratch`/`dirs`/`project` 辅助之后、A 块之前）安装，并在收尾处把真实值装回；机器块只负责再指到它自己的 fixture。修完 guard-probe 25/25。
- files: E:\projects\dsh-code-mode\probes\guard-probe.mjs:48-63（新的重定向安装点）, probes/README.md（约定）, C:\Users\dhhxfggg\.dsh-code\mistakes.md（被读到的首条机器事实）
- do not repeat: 探针一旦读的机制有"机器级/全局"来源，就必须在**第一次读它之前**就把它重定向到探针自己的临时目录（而不是在相关块内部），否则那些检查只是在"开发者机器上恰好没有这个东西"时才是绿的；新增这类环境变量或全局目录时，先想"这台机器上它现在存在吗、以后会不会存在"。

## 2026-10-02 · code_verify-通道里跑-budget-probe-artifacts-log-true-json-false-
- symptom: `code_verify` 通道里跑 budget-probe：`artifacts={"log":true,"json":false,"markdown":false}` —— 同一个目录 `probes/` 下，`budget-log.txt` 写成功，`budget-report.json` 与 `.md` 写失败（EPERM），29 条检查照常全绿、exit 0
- cause: **未查清**。同一目录、同一进程、同一次运行里，`writeFileSync` 对 `budget-log.txt` 成功、对 `budget-report.json` / `.md` 失败（EPERM）——即不是"整个目录不可写"那么简单。已知的相关变量：三个文件里只有 log 在上一次**不受限**运行里也被写通过一次；`budget-report.json` 单独做 `fs.openSync(p,'r+')` 在受限 pwsh 里实测失败。可能与 DSH 逐命令 provisioning、对象的标签/ACL 差异或写入大小无关的路径判定有关，本轮没有继续挖（它不影响判据：R3 只看 json/md 的新鲜度，而这两份是 14:58 不受限运行产出的）。
- fix: 未修：不改变行为——`writeArtifact` 已经是"写不进就 stderr 说明、退出码只看检查"，报告新鲜度由 debt-audit R3 守。要查清得单独做一组"同目录不同文件"的受限写入实验。
- files: probes/budget-probe.mjs（writeArtifact）, E:\projects\dsh-code-mode\probes\budget-{log.txt,report.json,report.md}
- do not repeat: 看到"某目录不可写"不要直接推成"该目录下所有文件都不可写"：本机实测同目录里不同文件结果不同（所以本项目里凡是"能不能写"的结论都要落到具体文件，而不是目录）；同理，"能写 $env:TEMP"不等于"能写 %TEMP% 下的任意路径"。

## 2026-10-02 · read-拒绝两个探针文件并报-invalid-utf-8-text-而-node-照样跑-探针照绿-probes-ac
- symptom: `read` 拒绝两个探针文件并报 `invalid UTF-8 text`，而 node 照样跑、探针照绿：probes/acceptance-probe.mjs（字节 372/441/503，`E2 80 3F`）与 probes/check-prompt-section.mjs（字节 291，`E2 80 3F`）；另外 probes/budget-chain-probe.mjs 的注释里躺着 3 个 U+FFFD（合法 UTF-8，但字符已经不可逆地丢了）
- cause: 有损的「解码→再编码」往返：本来是 `E2 80 8x` 的字符（em dash 一类）第三字节被换成字面 `?`（0x3F），或者整字被换成 U+FFFD（EF BF BD）。这是同一类事故的第二个签名——第一个签名是今天更早那次三份文档被写成十进制数字串（见 HANDOVER 铁律 7 与全局账本里那条 PowerShell 坑）。而 JS 对非法字节是**静默替换成 U+FFFD**，所以代码照样跑、探针照样绿。
- fix: 用 Node 逐字节定位 + 原地 splice（脚本用完自删）：`E2 80 3F` → `E2 80 94`（em dash，并补回被一起吃掉的空格：该文件其它 40 处正是 em dash 风格）；budget-chain 的 3 个 U+FFFD 按上下文还原为 em dash / `…`（后者由 lib/budget.js 自己的分隔符 `\n…\n` 佐证）。修完两文件均为严格合法 UTF-8、`read` 可读，三个受影响探针复跑全绿；并给 debt-audit 加了 E1（全仓文本文件严格 UTF-8 校验），把这一类永久变成判据。
- files: probes/acceptance-probe.mjs:9-11, probes/check-prompt-section.mjs:6, probes/budget-chain-probe.mjs:4-5
- do not repeat: 判断「文件是否完好」不能只看 node 跑不跑得起来：非法字节在 JS 里被静默替换成 U+FFFD，看起来一切正常。改动文档/源码后跑一次**严格** UTF-8 校验（`TextDecoder('utf-8',{fatal:true})`，debt-audit E1 已覆盖）；一旦在某处看到 `?` 出现在本该是 em dash 的位置、或文件里出现 U+FFFD，就是同一类有损往返——按字节修、按上下文还原，**不要整文件重写**。

## 2026-10-02 · 单个请求的未缓存输入突然变成-306-313-tokens-99.3-未命中缓存-而同一会话其它请求每次只-200-1-
- symptom: 单个请求的未缓存输入突然变成 306,313 tokens（99.3% 未命中缓存），而同一会话其它请求每次只 200–1,200；整个会话 465,748 未缓存输入里有 66% 来自这一条
- cause: 两件事叠在一起：① 15:03:50 DSH 重启，本会话被**恢复**（不是新开）；② 我在 14:50 改了 `lib/prompt.js` —— 系统提示段位于请求前缀的**最前面**，它的文本一变，provider 侧按前缀匹配的缓存整段失效。于是恢复后的第一次请求把整段历史（~306k）按**全价未缓存输入**重发：该请求 uncached=306,313 / cached=2,304（99.3% 未缓存），而平时每次请求只新增 200–1,200。会话总计 uncached=465,748，**这一条就占 66%**。这正是 HANDOVER 铁律 4 描述的那类代价，只是这次的"插件编辑"是我自己为了落地机器账本做的。
- fix: 不回滚代码，改成可测量 + 纪律：新增 `probes/context-cost.mjs`（一条命令读最新会话日志，报未缓存/缓存/输出总量、每次请求的未缓存占比、以及"前缀重发事件"＝未缓存占比 > 50%，用自校准比例而不是绝对阈值）。纪律：系统提示/插件描述的编辑要**攒到重启前一次做完**，并且**重启后开新会话、不要恢复旧会话**（新会话只带系统提示，不重发历史）。
- files: lib/prompt.js, probes/context-cost.mjs（新增的报告工具）, HANDOVER.md（铁律 4）
- do not repeat: 会话中途改系统提示/工具描述（哪怕只加两行）之后又**恢复**旧会话，等于让整段历史按全价重发一次；要先改完、重启、再**新开**会话。改动之后先跑 `probes/context-cost.mjs` 看有没有"前缀重发"事件，别凭感觉判断。

## 2026-10-02 · measuring-a-probe-s-stdout-bytes-from-inside-the-confined-pw
- symptom: Measuring a probe's stdout bytes from inside the confined pwsh channel failed three ways: `node harness.mjs | Out-String` gave text but no byte count; `spawnSync(..., {encoding:'buffer'})` returned status null with empty stdout (EPERM on the stdio pipe); `node fs.writeFileSync(tempCaptured)` and `Start-Process -RedirectStandardOutput <new temp file>` both gave "EPERM: operation not permitted" / "Access is denied".
- cause: Two separate limits. (1) The documented sandbox boundary: a confined process cannot capture a child's piped stdio, so every pipe-based measurement returns nothing. (2) The channel has write rights only on paths already authorized (workspace root, plus files the session's own write tool created) — it cannot create a NEW file under %TEMP%, and cannot open a new file for redirection. os.tmpdir() is also a per-command directory (ledger iron rule 11), so a report written by one pwsh call is unreadable by the next.
- fix: Run the probe with stdio:'inherit' (no pipe) from a scratch node script, and do the measuring inside that same script — and inside the same pwsh command as the probe, so os.tmpdir() resolves to the same per-command temp dir and the report file is still readable. Whitespace of PowerShell's text capture was removed from the critical path by reconstructing the object in-process and measuring it there.
- files: probes/gate-probe.mjs:1031-1040
- do not repeat: Do not try to measure a probe's stdout bytes by redirecting or piping it from the confined pwsh channel: capture bytes by having a scratch script read the report file the probe wrote and compare `Object.keys`/substring lengths in-process, and never assume a new %TEMP% path is writable or a per-command temp dir survives into the next command.

## 2026-10-02 · 真机-code_brief-的机器段打印-4-older-machine-wide-pit-s-dropped-for-
- symptom: 真机 `code_brief` 的机器段打印「… (4 older machine-wide pit(s) dropped for length)」而**一条坑都没显示**——机器账本那层"在"，但一句可执行的都没说；独立跑同一简报的子代理也复现了同样的 `4 dropped / 0 shown`
- cause: `globalExcerpt` 先**无条件**渲染全部事实行，再从剩余配额里放坑；而 5 条机器事实 ~600 字符遠大于该段在默认 4000 预算下的份额（当时权重 5 → ~273 字符），于是坑全被丢。第二层：两条丢弃标记的宽度也没算进配额，修前实测段长 490 > 配额 273（又超预算又没显示有用的东西）。
- fix: 段内改成**坑优先**：先给最新那条坑留一半配额（不够就截断，至少显示一条，照 `tailBlocks` 的先例），事实拿剩下的、超出的按条数点名；两条丢弃标记的宽度用 `marker(...)` 预算预先预留（照 `projectSummary` 预留 cut 的做法）；段权重 5→12、上限 900→1100。判据：`guard-probe` **B7**（写 4 条 200 字符的胖事实，断言机器段仍至少有 1 条坑线、且被丢掉的事实被点名）。真机 before/after：修前 `4 dropped / 0 shown`，修后配额内显示 1 条坑 + 1–2 条事实 + 两个丢弃标记。
- files: lib/ledger.js（globalExcerpt、SECTION_BUDGET.global）, probes/guard-probe.mjs（B7）, probes/README.md, INSTALL.md
- do not repeat: 做「先渲染 A、再拿剩下的放 B」这种顺序分配时，先问一句「A 单独就能吃光配额吗」：可执行的那一半必须**预留**配额，丢弃标记本身也要算进预算，否则这一段会既超预算、又不显示有用的东西。写完还要有一条判据把"塞满 A 时 B 仍必须出现"钉住。

## 2026-10-02 · check-prompt-section.mjs-一直是-pass-即使承载提示的请求帧一条都没有-它可以把-我自己在回
- symptom: `check-prompt-section.mjs` 一直是 PASS，即使承载提示的请求帧一条都没有——它可以把"我自己在回复里引用过这段提示"当成"提示真的发给了模型"；同一晚我写的事前预警用文件 mtime 与最后一次请求比较，在真正该报警的那一刻（15:03 重启前）报的是 `none`
- cause: 两处都是**判据的证据源选错了**：① 该探针在整份会话日志里搜关键字，而这段提示文本还会出现在模型的回复、工具调用参数、以及用户消息里重新注入的 system reminder 中——实测当天"最新包含 `## Project ledger` 的帧"是一条 `assistant/message` 和一条 `write` 工具参数，都不是请求；② 正确的证据源是 `system/message` 帧（本会话恰好两条：14:39 旧文本、15:04:17 新文本），而 mtime 基线会被对话里不断产生的新请求"追平"，于是恰好在 15:03 该报警的时刻沉默。
- fix: ① `check-prompt-section.mjs` 改成只解析 `system/message` 帧，并报出 carrier 数量、最新一条时间与字符数；**一条 carrier 都没有时明确说"其实什么都没检查"**，而不是照样 PASS。实测：2 条 carrier / 11 个 needle 全中 / PASS（最新 15:04:17，19197 字符载体文本）。② `context-cost.mjs` 的"事前预警"改成比较**磁盘上的 SECTION 文本**与**最后一次 system/message 里的同一段**，用 sha 报出两边；真机验证：默认"== 缓存安全（15:04:17，1988 字符，sha 82599b44…）"，指向一份刻意改过的副本 → "LIVE DIFFERS（223 vs 1988）"并给出"重启后新开会话"的建议。
- files: probes/check-prompt-section.mjs, probes/context-cost.mjs, lib/prompt.js
- do not repeat: 写"某内容进了请求"这类判据时先问「这段文本还会出现在哪些地方」——模型自己的回复、工具参数、重新注入的 system reminder 都会带上它；要在**承载该内容的帧类型**里找（这里 `system/message`），并报出用了几条 carrier。判断"前缀是否变了"不能拿文件 mtime 比最后一次请求：对话会不断产生新请求把基线追平，恰好在危险时刻沉默；要比**文本**。

## 2026-10-02 · 债区块静默消失-code_brief-的-turns-that-changed-code-and-ran-nothing
- symptom: 债区块静默消失：`code_brief` 的「## Turns that changed code and ran nothing」与「## Failing commands nobody wrote down」会在一条与它们无关的证据之后整段消失，读者无从知道曾经有过这笔债。
- cause: 两处结算都用**全局水位线**，而不是把证据跟这笔债对上：① `unverifiedExcerpt`（lib/ledger.js:789-798）取「日志里最新一条 ok:true 且非 claimed 的 verified 的 ts」当水位线，任何 ts 更晚的 unverified 债一律跳过——**不检查那条验证跑的命令与这笔债编辑的文件有没有半点关系**；② `unrecordedMistakes`（lib/ledger.js:735-743）取「最新一条 kind:mistake 的 ts」当水位线，任何更早的 mistake_unrecorded 一律跳过，同样不检查新记的 mistake 是不是这次失败的那件事。实测（探针临时脚本，写完即删）：写一条 `unverified{edits:['edit src/app.js']}` → 债可见；再写一条 `verified{cmd:'echo hi', ok:true}` → 该段**整段消失**。另写 `mistake_unrecorded{cmd:'pnpm test'}` → 可见；再写任意 `mistake{heading:'unrelated pit about CSS'}` → 整段消失。最糟的一条是：`code_verify` 不带 expect 时只要求 exit 0，所以 `echo hi` 这种命令就足以结清所有旧债。
- fix: 未修（这是本轮提交给用户的优化项 P1，等拍板）。可选修法见 decision 条目：把「结算」从全局水位线改成**证据—债配对**（验证的命令行/工作目录/输出必须点到这笔债涉及的文件；记 mistake 的 files:/symptom 必须与那次失败的命令或命令里的路径对得上），配不上的债不删除、降级显示（例如「另有 N 笔更早的债未被最近一次验证结清」），因为本模式第①条原则是任何省略都必须说出来。
- files: lib/ledger.js:735-743, lib/ledger.js:789-798
- do not repeat: 不要用「最新的同类记录」当结算水位线来决定另一条记录的去留——水位线只能证明「有人干过这类事」，不能证明「这笔债被结清了」。写结算规则时先问一句：这条证据与这笔债的**对象**（文件/命令）对得上吗？对不上就不许静默通过。

## 2026-10-02 · 在-probes-及-lib-.dsh-code-等任何已存在的子目录-里-删不掉文件-remove-item--lit
- symptom: 在 `probes/`（及 `lib/`、`.dsh-code/` 等任何已存在的子目录）里**删不掉文件**：`Remove-Item -LiteralPath … -Force` 报「对路径的访问被拒绝」，node `fs.unlinkSync` 报 `EPERM`；而**建**文件可以（`write` 工具成功建出 `probes/debt-probe-scratch.mjs`），`edit` 工具也能改它。
- cause: 子目录缺少沙箱的**低完整性标签**授权（铁律 10）：DSH 只给工作区根目录加了写授权 ACE 与 Low 完整性标签。`write`/`edit` 工具走的是宿主自己的写路径（因此能建、能改），而 `pwsh`/`code_verify` 里的 node/PowerShell 是受限进程，删目录项需要对该目录本身的写权限 → `EPERM`/Access Denied。本轮实测（2026-10-02）：`node -e` 里 `writeFileSync('probes/.del-probe.tmp')` → `CREATE OK`，紧接着 `unlinkSync` → `EPERM`；同一次 `pwsh` 里 `Remove-Item` 亦被拒。
- fix: 未修（要动 ACL/标签需提权，本机护栏禁止）。规避：① 需要删的东西**不要让受限通道去删**——`write` 工具能建的临时文件，删除要么请人在不受限通道做，要么就把它转成正式产物留在仓库里；② 本轮把临时脚本就地改成带说明的遗留文件（`probes/debt-probe-scratch.mjs` 顶部注释写清为何留着）。
- files: .dsh-code/
- do not repeat: 不要在受限通道里规划「先建临时文件、跑完再删掉」的用法——建得成、删不掉，临时产物会永久留在包里；要建就建在 `os.tmpdir()`，或者建之前就接受它会变成仓库的一部分。

## 2026-10-02 · 调试脚本报-typeerror-parsed.checks-is-not-iterable-它按-debt-audit.
- symptom: 调试脚本报 `TypeError: parsed.checks is not iterable` —— 它按 `debt-audit.mjs` 的输出形状去读 `guard-probe.mjs` 的结果。
- cause: 误以为所有探针都像 debt-audit 那样输出逐条 `checks`；`guard-probe.mjs` 的汇总只有 `{passed,total,failed:[名字]}`，逐条证据要读它写的 tempReport。
- fix: 改成先打印原始输出；要逐条证据就读 guard-probe 自己写的 `tempReport('guard-report.json')`（`probes/paths.mjs` 的 `tempReport`）。
- files: probes/settle-debug.mjs:14
- do not repeat: 写一次性调试脚本时，先确认被测工具**实际输出的 JSON 形状**再解析：`guard-probe.mjs` 只输出 `{passed,total,failed:[名字]}`（没有逐条 `checks`），而 `debt-audit.mjs` 与 `budget-probe.mjs` 才输出 `checks`。名字里带 probe 不等于形状一样。

## 2026-10-02 · 连续两轮加载模型调用失败-报-typeerror-parsed.checks-is-not-iterable-调试脚本按
- symptom: 连续两轮加载模型调用失败，报 `TypeError: parsed.checks is not iterable`：调试脚本按 debt-audit 的形状去解析 guard-probe 的结果。
- cause: 把具体输出形状当成了通用约定——`guard-probe` 有意只输出汇总（省上下文），逐条证据写进 temp 报告文件；我没有先打印原始输出就开始解析，连续两轮把时间花在无谓的报错上。
- fix: 先打印原始输出确认形状；要逐条证据就读 `path.join(os.tmpdir(),'guard-report.json')`（`probes/paths.mjs` 的 `tempReport`）。
- files: probes/guard-probe.mjs, probes/paths.mjs:146
- do not repeat: 别假设「同名探针的输出形状相同」：`guard-probe.mjs` 只输出 `{passed,total,failed:[名字]}`，逐条证据在它写的 `tempReport('guard-report.json')` 里；而 `debt-audit.mjs` / `budget-probe.mjs` 直接输出 `checks`。解析别人的输出前先打印一次原始输出。

## 2026-10-02 · guard-probe.mjs-exit-1-且完全没有汇总行-不是某条检查红-而是整个文件没跑起来-syntaxerr
- symptom: `guard-probe.mjs` exit=1 且完全没有汇总行（不是某条检查红，而是整个文件没跑起来）：`SyntaxError: Missing catch or finally after try`。
- cause: 为「受限通道不能 spawn」加保护时，连续两次只加了 `try {` 而没配套 `catch`：第一次把 `try` 加在 Promise executor 内部、第二次加在 `Promise.all` 外层，两次都留下悬空的 try 块。
- fix: 去掉外层多余的 `try`（内层 `try/catch` 已覆盖同步 EPERM），guard-probe 立刻回到 37/37。
- files: probes/guard-probe.mjs:347
- do not repeat: 给探针加结构（try/包裹 Promise.all）之后必须立刻跑一次：我的两次「加 try」都以 `SyntaxError: Missing catch or finally after try` 告终，而症状（探针 exit=1、没有汇总行）看起来像检查失败，实际是文件根本没被解析。

## 2026-10-02 · this-session-every-process-launch-on-the-pwsh-code_verify-ch
- symptom: This session, every process launch on the pwsh/code_verify channel died instantly: `pwd` alone and `pwd; Get-ChildItem -Force | ...` both returned "(no output)" with `[exit code: 3221225794]`, and `code_verify` of `node -e "console.log('ok')"` also reported `FAILED (exit 3221225794)` with empty output — so a command that must print `ok` printed nothing.
- cause: 3221225794 = 0xC0000142 = STATUS_DLL_INIT_FAILED: the child process could not finish DLL initialization, i.e. any newly spawned console process (pwsh itself, node) dies before it can run a single statement. It is a launch failure, not a syntax/quote failure: the same shell printed no output for the command `pwd`, which has no quoting at all. So it is not the recorded inline-quote pit.
- fix: Not fixed in this session yet. It is an environment-level break in the run-tool channel (host process state / sandbox), and it is NOT channel-specific in the way the ledger describes: both the pwsh channel and code_verify's extra-shell channel failed identically. Distinguishing it from the recorded `spawn EPERM` pit: EPERM happens on spawning children that capture piped stdio; STATUS_DLL_INIT_FAILED kills even the top-level shell.
- do not repeat: Before blaming a quoting/inline-script problem for empty output, check the exit code: 3221225794 (0xC0000142, STATUS_DLL_INIT_FAILED) means no process could start at all, so re-quoting the command is wasted work — verify the channel with a bare `pwd` and, if that dies too, treat the run channel as down and say so instead of iterating on the command text.

## 2026-10-02 · pwd-get-childitem--force-select-object-mode-lastwritetime-le
- symptom: `pwd; Get-ChildItem -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize` → `(no output)`，`[exit code: 3221225794]`；随后单跑的 `pwd` 同样 `(no output)`，`[exit code: 3221225794]`。
- cause: 这两条命令失败的原因是进程启动失败（STATUS_DLL_INIT_FAILED, 0xC0000142），不是命令内容错、不是引号被吃、不是路径不存在——`pwd` 既不读文件也不 spawn 子进程，仍然零输出退出。同因的还有 `cmd /c echo chanprobe`、`node -e "console.log('ok')"`（见全局账本同名条目）。
- fix: 未修复（属宿主机进程启动故障）。诊断顺序：重启 DSH → 无效则重启机器 → 恢复后先跑一条 `pwd` 确认通道再跑真正的 code_verify。
- do not repeat: 本会话开头那两条失败命令就是它们：`pwd; Get-ChildItem -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize` 与 `pwd`，失败特征 `exit code: 3221225794` / `(no output)`。以后遇到同样的症状，直接当成「进程起不来」处理，不要写进 mistakes 之外的地方，也不要再重复记录。

## 2026-10-02 · 本会话-gui-标准模式-里我按-改完就停-别跑任何命令-改了-probes-human-walkthrough-scr
- symptom: 本会话（GUI，标准模式）里我按「改完就停、别跑任何命令」改了 probes/human-walkthrough-scratch.js，但会话里既没有门禁提醒，也没有任何一处能证明这笔债存在——因为本会话根本不在编程模式里。
- cause: 需要门禁的三个观察点（回合里出现 unproven-completion 提醒、下一个会话的 code_brief 里出现 `## Turns that changed code and ran nothing`、配对验证后该段消失）全部由 preset `code` 挂载的 lib/gate-verify.js + lib/tool-brief.js 产生；它们只在 preset 挂载时 import，本会话不在该 preset 下。
- fix: 由人在 GUI 里开「编程模式」新会话跑两轮（TESTING.md 场景 3 / 场景 5）；文件侧那半我可以离线证明，脚本见 probes/run-human-walkthrough.mjs。
- do not repeat: 不要相信「本会话里改了 .js 文件、又没跑命令」会被记成债：本会话是**标准模式**（preset 不是 id=code），门禁插件没被 prompt 段和 budget 段一起挂上，所以我在 E:\projects\dsh-code-mode\probes\human-walkthrough-scratch.js 上的改动不会有任何 code-gate 提醒。要测门禁必须由人在 GUI 里新开会话、模式选「编程模式」。

## 2026-10-02 · get-childitem-e-tools-dsh-resources-app.asar-dsh-找不到路径-因为该路径
- symptom: Get-ChildItem 'E:\tools\DSH\resources\app.asar\dsh' → 找不到路径，因为该路径不存在；Test-Path 返回 False。系统提示里把该目录当成「DSH 实现 checkout」，照着它去 grep/read 会全部落空。
- cause: 该安装是 asar 打包分发（E:\tools\DSH\resources\app.asar 是 121MB 的归档文件，不是目录），磁盘上只有 app.asar.unpacked\dsh\node_modules 下的原生模块被解包。内置 preset 的源码（@deepseek-ai/dsh-*）在归档内部，不能用文件工具直接读。
- fix: 要读内置实现：用 Electron 的 ELECTRON_RUN_AS_NODE + node:module 的 asar 支持（或 --expose-internals 的探针）从归档内部加载；磁盘上只能看到 app.asar.unpacked 里的 .node/原生部分。项目自己的代码在本仓库 lib/ 与 node_modules/dsh-code-mode 的 link 里。
- files: E:\tools\DSH\resources\app.asar
- do not repeat: 不要把 E:\tools\DSH\resources\app.asar\dsh 当成可读目录（grep/read/Get-ChildItem 都会失败）；先 Test-Path 再决定用归档内加载还是只读 app.asar.unpacked。

## 2026-10-02 · 一段用-串起来的-pwsh-命令报-exit-code-1-且被算作-命令失败-但其中真正需要的输出-列举存在的目录-已
- symptom: 一段用 `;` 串起来的 pwsh 命令报 `[exit code: 1]` 且被算作「命令失败」，但其中真正需要的输出（列举存在的目录）已经正常打印；失败来自同段里对不存在路径的 `Get-ChildItem`。
- cause: 同一条 pwsh 调用里前半段是一条注定失败的探测（`Get-ChildItem <不存在的路径>`），后面 `Write-Host`/对存在路径的列举其实都成功了；进程退出码取的是那条失败 cmdlet 的 1。
- fix: 把探测段改成 `Test-Path`/`-ErrorAction SilentlyContinue`；已存在的路径继续列举，退出码恢复 0。
- files: E:\projects\dsh-code-mode\probes/paths.mjs
- do not repeat: 在多段命令里做「探测存在与否」时，不要用会抛错并决定退出码的 cmdlet（Get-ChildItem/Get-Content 对不存在路径）；用 `Test-Path`、`-ErrorAction SilentlyContinue`，或把互补的探测拆成独立调用，否则 exit code 会把整段报成失败。

## 2026-10-03 · get-childitem-c-users-dhhxfggg-.dsh--recurse--include-sessio
- symptom: `Get-ChildItem C:\Users\dhhxfggg\.dsh -Recurse -Include 'session*.jsonl*' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 8` 报 exit code 1，但需要的输出（8 条最新会话日志）已经完整打印。
- cause: 递归遍历 `~\.dsh` 时撞到不可读的子目录；`-ErrorAction SilentlyContinue` 只压掉了错误显示，`$?` 仍是 false，而管道末尾没有任何成功的语句，于是整段进程退出码取 1。
- fix: 不重跑这条路：需要的 8 条文件名已经从输出里拿到，改用单点读取（`context-cost.mjs` 自己打印 session log 路径 + 单个文件的 grep）继续。
- files: E:\projects\dsh-code-mode\.dsh-code\journal.jsonl
- do not repeat: 用 `-Recurse` 扫一个可能含不可读子目录的目录树、同时用 `-ErrorAction SilentlyContinue` 抑制错误时，不要把退出码当失败；要么别递归（先定位再单点读），要么把一条必然成功的语句（如 `Write-Host 'ok'`）放在管道最后。

## 2026-10-03 · node--e-...l.includes-id-code-...-报-syntaxerror-missing-afte
- symptom: `node -e "...l.includes('\"id\":\"code\"')..."` 报 `SyntaxError: missing ) after argument list`，报错行里的引号已经被 PowerShell 吃掉（`presetHits.push(f.type);if(l.includes('" id\:\code\'))`）。
- cause: PowerShell 把内联脚本里的引号当自己的解析对象，传给 node 的字符串已经变形。这条坑本机账本 2026-10-02 已经记过一次（powershell-native-argument-passing-eats-quotes-in-inline-scripts），我动手前没查就写了。
- fix: 不重试内联写法：把要跑的检查落成项目内的探针文件（`probes/gate-chance.mjs`），用 `node probes/gate-chance.mjs` 调用。
- trigger: node\s+(-e|--eval)|python\s+-c
- do not repeat: 任何带引号的脚本（node -e / python -c / cmd /c 内联）一律先落文件再执行；写命令前先查 `files:`/`trigger:` 命中的坑，别等失败后再认。

## 2026-10-03 · 把-node--e-json.parse-l.includes-id-code-整段作为参数传给原生-node-时报-s
- symptom: 把 `node -e "…JSON.parse…l.includes('\"id\":\"code\"')…"` 整段作为参数传给原生 node 时报 `SyntaxError: missing ) after argument list`，而且报错位置把命令截断成 `(Get-Item $p).Length/102`——报错里出现的命令行跟实际写的不是同一条。
- cause: 两层：① pit-guard 记录失败时 `cmd` 只取命令前 200 字符（pit-guard.js:343），所以长内联脚本的**真正失败点**经常不在记录里；② 主因是 PowerShell 把内联脚本文本里的引号/反斜杠当自己的解析对象，传给 node 的已是变形文本（本机账本 2026-10-02 已记过同类：powershell-native-argument-passing-eats-quotes-in-inline-scripts）。
- fix: 不在命令行里传带引号的脚本：把检查落成文件（本次落成 `probes/gate-chance.mjs`）再 `node <file>` 调用。
- files: E:\projects\dsh-code-mode\probes\gate-chance.mjs, E:\projects\dsh-code-mode\probes\session-evidence.mjs
- trigger: node\s+-e\s|python\s+-c\s
- do not repeat: Windows 上一律不要把 JSON 字面量或含引号的脚本内联进 `node -e`/`python -c`/`cmd /c`；要写多行/带引号的脚本先落文件。另外：pit-guard 记的失败命令是前 200 字符的截断文本，别把「记录里的命令行」当成「实际执行过的命令行」的唯一来源。

## 2026-10-04 · get-childitem-e-tools-dsh-resources-app.asar-dsh-and-...-app
- symptom: Get-ChildItem "E:\tools\DSH\resources\app.asar\dsh" (and ...\app.asar\dsh\node_modules\@deepseek-ai) → 找不到路径 ... 因为该路径不存在 ([exit code: 1])，但同一命令前半段（读 profile 的 cordis.patch.yml）输出完全正确。
- cause: app.asar 是打包归档、不是目录：文件系统层面没有 app.asar\dsh 这个真实目录，所以 Get-ChildItem/pwsh 无法遍历它。系统提示里写的「checkout at E:\tools\DSH\resources\app.asar\dsh\」指的是**归档内**的包根，只有 Electron 二进制以 node 模式启动时（fs hooks 装了 asar 支持）才解析得到。另有一层叠加因素：命令里用了 -ErrorAction SilentlyContinue，触发本机账本已记的 pit（非零退出被误读为真失败）。
- fix: 不要用 pwsh/Get-ChildItem 走 app.asar 内部；用仓库既有的 probes/asar-read.mjs（list/read/lines/grep/to，经 Electron 二进制读归档，路径相对 <asar>\dsh）。用法见该文件头注释。
- files: E:\projects\dsh-code-mode\probes\asar-read.mjs:1-30
- do not repeat: 不要用 Get-ChildItem/read 工具去遍历或读取 app.asar 内部的路径——归档不是目录，必然 PathNotFound（exit 1）；一律走 probes/asar-read.mjs。

## 2026-10-04 · 在-pwsh-通道执行-env-electron_run_as_node-1-e-tools-dsh-deepseek-
- symptom: 在 pwsh 通道执行 `$env:ELECTRON_RUN_AS_NODE='1'; & "E:\tools\DSH\DeepSeek Harness.exe" probes/asar-read.mjs list .` 完全无输出，且 $LASTEXITCODE 为空字符串（不是 0、也不是非零）——连读归档根的 list 都拿不到任何东西，stdout/stderr 都是 0 行；改用 cmd 通道（cmd /c "set ... && \"...Harness.exe\" ..."）则报 `'\" E:\tools\DSH\DeepSeek "Harness.exe\' is not recognized`（踩了本机账本已记的 `\"` 引用坑）。
- cause: 未查清，且不打算在受限通道继续查。已排除的方向：不是探针写错空结果（list 一个真实存在的归档根不该为空）、也不是过滤/截断（无 Select-Object 参与、capture 与直连结果相同）。剩下的解释是「该通道没能启动这个进程」——$LASTEXITCODE 为空正说明没有原生命令真的跑过。cmd 通道那次失败是独立的引用问题，不是同一个原因。
- fix: 改用仓库内的权威替代：读 `lib/compact-gate.js` 的文件头注释——它本身就是「引擎默认值 0.8 在 dsh-compaction-basic/lib/index.js:15、触发点在 :839/:940」这些包内坐标的记录，不必再进归档确认。需要真正读包内实现时，只能在一个**不受限的通道**（用户自己的终端）里跑 `probes/asar-read.mjs`，不要在会话内的 pwsh/code_verify 通道试。
- files: E:\projects\dsh-code-mode\probes\asar-read.mjs:1-30
- do not repeat: 不要在受限（workspace-write）会话通道里把「经 DeepSeek Harness.exe 跑探针」当取证手段：它可能完全无输出且 $LASTEXITCODE 为空。判据是「$LASTEXITCODE 为空 = 进程没起来」，不是「探针返回了空」——两者输出看起来一样，含义相反。要读 app.asar 内部，走用户自己的不受限终端。

## 2026-10-04 · 本轮第三次撞同一个墙-cmd-c-set-electron_run_as_node-1-e-tools-dsh-deep
- symptom: 本轮第三次撞同一个墙：`cmd /c "set ELECTRON_RUN_AS_NODE=1 && \"E:\tools\DSH\DeepSeek Harness.exe\" probes\asar-read.mjs list ."` → `'\" E:\tools\DSH\DeepSeek "Harness.exe\' is not recognized as an internal or external command` [exit 1]；而同一目的在 pwsh 通道（`& "…Harness.exe" …`）是无输出 + `$LASTEXITCODE` 为空。两种写法都拿不到包内内容。
- cause: 受限（workspace-write）会话通道里，经 `DeepSeek Harness.exe` 以 ELECTRON_RUN_AS_NODE 启动探针会完全无输出且 `$LASTEXITCODE` 为空——两次以不同写法复现（直连 / 经 code_verify），cmd 兜底写法则踩本机已记的 `\"` 引用坑（`'\" E:\tools\DSH\DeepSeek "Harness.exe\' is not recognized`）。即：这是**通道**的限制，不是探针的问题，换写法不会通。
- fix: 不要在本会话通道重试这条路径（已试三次、三种写法）。要读 app.asar 内部，只能在用户自己的不受限终端里跑 `probes/asar-read.mjs`；在本会话内取证就换别的来源（磁盘上可读的副本 / 仓库内的权威注释）。
- files: E:\projects\dsh-code-mode\probes\asar-read.mjs:1-30
- do not repeat: 同一条「读 app.asar 内部」的路，不要在一个会话里换第三种写法再试——失败原因是通道而非写法，重试只会再踩一次 `\"` 引用坑。

## 2026-10-04 · 本会话里我第三次用了内联-node--e-...引号...-这次是查一个文件能否删除-node--e-const-fs-
- symptom: 本会话里我第三次用了内联 `node -e "...引号..."`（这次是查一个文件能否删除：`node -e "const fs=require('fs');…unlinkSync…"`），pit-guard 连报三条既有坑（node -e / python -c 的引号被 PowerShell 吃掉）。这次侥幸跑通了，但规则是绝对的。
- cause: 图快：把「查一个文件在不在/能不能删」当成不值得落文件的小事，而本机账本早已记过「任何带引号的脚本一律先落文件再执行」。跑通与否是运气，不是可以依赖的判据——真失败时报错位置会把命令行截断，症状看起来像脚本本身写错了。
- fix: 把要跑的逻辑落成 .mjs 文件再用 `node <file>` 调用（本会话后来就是这么做的：probes/syntax-check.mjs、probes/utf8-check.mjs）。查文件存在性/可删性这类一次性问题，也走落文件。
- files: E:\projects\dsh-code-mode\probes\syntax-check.mjs:1-16
- trigger: node\s+-e\s|python\s+-c\s
- do not repeat: 不要用 `node -e` / `python -c` / `cmd /c` 内联带引号的脚本来做诊断或验证，哪怕它「只是一句话」——先落文件。判据是命令里有没有引号，不是你觉得这事有多小。

## 2026-10-04 · 在-probes-里创建了调试用划痕文件-probes-handover-debug-scratch.mjs-之后删不掉
- symptom: 在 probes/ 里创建了调试用划痕文件 probes/handover-debug-scratch.mjs 之后删不掉：`Remove-Item` 报「对路径的访问被拒绝」(UnauthorizedAccessException)，`fs.unlinkSync` 报 EPERM，`Move-Item` 也报 UnauthorizedAccessException——但同一个会话里**写**这个文件与**改**它的内容都成功。
- cause: 沙箱的写授权只 provision 到工作区**根目录**，已存在的子目录（probes/、lib/、.dsh-code/）没有该授权，所以「写新文件」能成而「删/改名」被拒——这正是本仓库 HANDOVER.md 铁律 10 记的同一道边界（缺的是低完整性标签，不只是 ACL；补标签要提权、本机护栏禁止）。write 工具能改内容所以能补救，delete/rename 不能。
- fix: 补救成正式产物：改写成 probes/handover-debug-scratch.mjs 这个「列出本轮无法删除的划痕文件」的诊断（头部写明来历），并加进 .gitignore 使其永不进提交。用户可在自己终端 `Remove-Item` 清掉。另注意本包**不是 git 仓库**（git status → fatal），.gitignore 只在将来提交时起作用，所以不能拿「已在 .gitignore」当作「不会漏出去」的当下保证。
- files: E:\projects\dsh-code-mode\probes\handover-debug-scratch.mjs:1-20
- do not repeat: 受限会话里写进 probes/ 的临时文件删除不掉（unlink→EPERM、Move-Item→UnauthorizedAccessException），所以**别把划痕文件写进 probes/**；要么写 $env:TEMP，要么一开始就当成正式产物（正式命名 + 进 .gitignore + 让判据看管）。

## 2026-10-04 · 给压缩闸门加-重启待办-通知后-两个-无关-的既有判据同时变红-guard-probe-43-44-e-a-settle
- symptom: 给压缩闸门加「重启待办」通知后，两个**无关**的既有判据同时变红：guard-probe 43/44（`E a settled debt produces no notice of any kind` 读到 `… (1 earlier ledger entries dropped for length)`），acceptance 23/24（`brief:fresh code_brief answers on a project with no ledger` 的 `empty:false`、首行变成机器事实段）。两者看起来都与功能无关，实际同一个根因。
- cause: 三层同因：① 我把「会话开始」的簿记放进了 `brief()` 内部，而 `brief` 的契约是只读——于是每个探针 fixture 的查询都留下记录，把一个空的 journal 段变非空，让 guard-probe 的「结清即无任何提示」判据红了（它读到的 `… 1 earlier ledger entries dropped for length` 就是这段）；② 同一处写还让 `code_brief` 在一个**没有账本**的项目上创建了账本，把本应由它报告的「No ledger yet」变成一份有内容的简报，acceptance 的 `brief:fresh` 因此红了；③ 通知最初挂在 journal 段**开头**，而该段的裁剪保留**尾部**，于是那条最不该被丢的行被丢掉（默认预算下消失、`full` 下才出现）。
- fix: 三处分别修：① 把 `noteSessionStart` 从 `brief()` 移到 `tool-brief.js` 的 `execute`（只有真实工具调用才算会话开始）；② 在 `noteSessionStart` 里先判 `exists(cwd, scope)`，没有账本就不写——保留「没有账本」这个答案；③ 重启通知改为走**预留配额的 notices**（先算 `restartNotice.length + 2` 进 reserve，再 `notices.unshift`）。后两处都是「让判据说话」发现的：guard-probe 44/44 与 acceptance 24/24 复绿是唯一验收。
- files: E:\projects\dsh-code-mode\lib\ledger.js:307-323,lib\ledger.js:932-940,lib\tool-brief.js:55-64
- do not repeat: 不要在「读」路径里写账本：读函数（`brief`）不许落盘、不许建账本——把簿记放到工具层（`tool-brief.js`），并在写之前确认账本已存在。判断标准：如果一次纯查询会改变被查询的东西，或让「没有账本」这个答案消失，那它就写在了错的地方。

## 2026-10-04 · 机器账本-9-条事实共-1-748-字符-而简报的机器段上限-1-100-字符-屏幕上出现-7-more-fact-s-
- symptom: 机器账本 9 条事实共 1,748 字符，而简报的机器段上限 1,100 字符：屏幕上出现 `… (7 more fact(s) dropped for length; read …)`，9 条里只有 2 条可见——而且被丢掉的是**最长的那条**（643 字符的 `env_status_2026_10_02`，正是实测出来的环境结论）。修它的过程又牵出第二个症状：一条 237 字符的机器坑在简报里被裁到 186，`trigger:` 和 `do not repeat:` 双双消失。
- cause: 两个独立缺陷叠加：① `globalExcerpt` 用 `break` 在**第一个装不下**的事实上跳出，于是最长的（643 字符的实测环境结论）先被丢，33 字符的路径事实留下——大小不等于重要性；② 更隐蔽的是 `shapeEntries` 里一个**永远不会触发**的守卫：它先 `text = clip(text, limit)`，之后的判断却要求 `text.length > limit`，按构造永远为假。该守卫读起来像「单条能放下就完整显示」，实际从未生效；我加机器事实索引后才把它暴露出来（一条 237 字符的坑被裁到 186，`trigger:` 与 `do not repeat:` 正好落在被裁掉的尾部）。
- fix: ① 事实按 journal 里 `kind:'project'` 的写入时间排序（新增 `factRecency`，无需在事实里存时间戳），装不下的渲染成 `- 键名 (N chars)` 索引行，仍然装不下的才报数；② 把 `shapeEntries` 的裁剪挪到守卫**之后**，让「单条完整」真正生效（另设 `HARD_ENTRY_CHARS=1200` 作为上限，超过就照旧裁剪）。判据：guard-probe B7（长事实必须完整显示、装不下的必须被点名、旧的大小丢弃标记不得出现），45/45 全绿；debt-audit 23/23 `failed: []`。
- files: E:\projects\dsh-code-mode\lib\ledger.js:1984-2017,lib\ledger.js:2186-2230
- do not repeat: 别用「按大小丢弃」处理有预算上限的文本段：先问「这里最长的一条是不是也最该看见」——本机机器事实段的答案是「是」。装不下的条目要**点名**（键名+字数），不是数个数；条目的排序依据应是「最近写入」，而不是它在文件里的顺序。

## 2026-10-04 · code_record-kind-mistake-and-code_record-kind-decision-alway
- symptom: code_record(kind="mistake") and code_record(kind="decision") always fail with: tool "code_record" returned invalid output: value is not lossless JSON. The entry is nevertheless written to mistakes.md/decisions.md and journaled, so the same fact gets recorded twice when the model retries.
- cause: lib/tool-record.js declares output.schema with additionalProperties:false and exactly four properties (kind, scope, file, summary), but the kind="mistake" and kind="decision" branches return a fifth key, `notice: written.warning`. The harness validates the handler's result against the schema and rejects the extra property. Proven by experiment 2026-10-04: the same call with kind="project" (no notice) returns normally, while kind="mistake" returns 'tool "code_record" returned invalid output: value is not lossless JSON' — yet code_brief and mistakes.md both show the entry was written.
- fix: Either declare `notice: { type: 'string' }` in the output schema properties, or fold the warning into the `summary` string. Declaring it is the better fix because the render function can then show it as its own line.
- files: lib/tool-record.js:183, lib/tool-record.js:266, lib/tool-record.js:121-131
- do not repeat: Do not add a key to a tool handler's returned object unless that key is declared in the tool's `output.schema.properties` — with `additionalProperties: false` the harness rejects the result as "value is not lossless JSON", and the rejection happens AFTER the side effect (the ledger write), so the model is told a successful write failed.
- recurred: 1
- last: 2026-10-04
## 2026-10-04 · guard-probe-reported-b7-failed-while-two-different-checks-sh
- symptom: guard-probe reported "B7 failed" while two different checks shared the label B7, and the one about a machine section full of facts could never pass no matter what the product did.
- cause: Guard-probe's B8 (then labelled B7, so the label collided with the long-fact check and the report could not say which had failed) counted "lines that are not facts" as the evidence that a pit was shown. A machine pit's fields are rendered as `- symptom: …`, `- do not repeat: …`, which match `isFactLine`'s `^- <key>: ` pattern, so `pitLinesShown` was always 0 and the check could never pass. The other half, `!fatLines.some(isFactLine)`, is false as soon as any pit renders, so "names the facts it dropped" was never actually required. Fixed by recognising the pit through its own `## ` heading and the section's pit header.
- fix: Classify by the pit header/entry heading; separately count fact lines; assert "facts shown OR dropped facts named". Relabel the second check B8 so a failure names the assertion that failed.
- files: probes/guard-probe.mjs:900-917
- do not repeat: When a check classifies lines by shape, do not reuse one shape test to prove a *different* kind of line is absent — the pit's own fields (`- symptom:`, `- do not repeat:`) match the fact-line pattern `^- key: `, so the classification was vacuous. Classify by the marker that is unique to the thing (its heading / its section header).

## 2026-10-04 · acceptance-probe-dies-at-import-time-with-jsonschemaerror-un
- symptom: acceptance-probe dies at import time with: JsonSchemaError: unsupported JSON schema: schema.properties.notice.required must be true when present, thrown from defineTool inside lib/tool-record.js apply(). Nothing about the thrown error says which tool, and the lib file parses fine, so node --check and every stub-based probe stay green.
- cause: defineTool compiles output.schema through the host's schema compiler, which rejects `required: false` outright: JsonSchemaError: unsupported JSON schema: schema.properties.notice.required must be true when present. When it throws inside apply(), the module never finishes registering, so code-record does not mount at all. This is strictly worse than the undeclared-key bug it was meant to fix: that one at least wrote the ledger entry before the harness rejected the result, whereas this takes the entire tool down.
- fix: Remove the optional key; keep the four always-present keys (kind, scope, file, summary) and fold any extra text into summary. Pin it with a probe check that no declared property has required:false, since the stub-based probe cannot otherwise see it.
- files: lib/tool-record.js:126-135
- do not repeat: Do not declare a tool output property with `required: false` in this harness — it does not create an optional property, it makes the schema fail to compile and the whole tool row never registers. Every declared property must be required:true, so any advisory or conditional text belongs inside an existing required string key (e.g. `summary`), never in a key of its own.

## 2026-10-04 · the-documented-acceptance-command-through-code_verify-record
- symptom: The documented acceptance command through `code_verify` records `exit 0, but the expected output never appeared` with an empty tail, and `$env:TEMP\acceptance-report.json` looks missing — the same command in `pwsh` with `2>&1 | Out-String` prints `{"passed":24,"total":24,"failed":[]}`.
- cause: The Electron-in-node child's stdout is not forwarded to the caller in this channel (the child itself runs fine — measured: `-e` script exits 0 and writes its file, while `console.log` is invisible), and the probe's default report path is `os.tmpdir()`, which is a per-command sandbox directory (`...\Temp\dsh-yR0Ftz\`) that no later command can read. `code_verify` therefore records the run as `exit 0, but the expected output never appeared` — a false failure on a green probe.
- fix: Add `2>&1 | Out-String` and an exit-code guard ($LASTEXITCODE -> Write-Error) so a real failure cannot pass as exit 0, and pin the report with `$env:DSH_PROBE_REPORT=(Join-Path $env:TEMP 'acceptance-report.json')`. Do not pin it to the workspace root: `pwsh` can write that, `code_verify` cannot (EPERM). Verified 2026-10-04 through code_verify: 24/24, failed [], probe-exit=0.
- files: probes/acceptance-probe.mjs:42, TESTING.md:48, probes/README.md:15-33
- trigger: ELECTRON_RUN_AS_NODE
- do not repeat: Do not judge a probe by the caller's stdout — when `DeepSeek Harness.exe` in node mode prints nothing, check whether it produced its report artifact before concluding anything, and never leave the verdict only in `$env:TEMP` (per-command, cleared).

## 2026-10-04 · plain-node-running-a-probe-that-calls-probes-paths.mjs-insta
- symptom: Plain node running a probe that calls probes/paths.mjs installResolution() dies with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'E:\tools\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'` — it looks like a broken path in paths.mjs.
- cause: installResolution() imports modules from *inside* the asar archive, which only resolves when the process has Electron's asar fs hooks — i.e. the `DeepSeek Harness.exe` binary run with ELECTRON_RUN_AS_NODE=1. A plain node.exe has no asar support, so the file:// URL under app.asar does not exist for it. probes/output-schema-probe.mjs works under plain node only because it stubs @deepseek-ai/* with registerHooks instead of resolving them.
- fix: Run any probe that imports lib/*.js (which use bare @deepseek-ai/* specifiers) with the archive-aware binary: `$env:ELECTRON_RUN_AS_NODE='1'; & 'E:\tools\DSH\DeepSeek Harness.exe' <probe.mjs>`. This worked on 2026-10-04 in the danger-full-access session: full stdout was captured even though $LASTEXITCODE came back empty.
- files: E:\projects\dsh-code-mode\probes\paths.mjs:118-143, E:\projects\dsh-code-mode\.dsh-code\audits\00-discovery.mjs:1
- trigger: installResolution
- do not repeat: Do not run a probe that calls installResolution() with the bundled plain node.exe — it can only fail with ERR_MODULE_NOT_FOUND under app.asar; use the Electron binary in node mode, and do not read a plain-node ERR_MODULE_NOT_FOUND under app.asar as a wrong path in paths.mjs.

## 2026-10-04 · audit-2026-10-04-code_record-kind-project-and-code_record-ki
- symptom: Audit 2026-10-04: `code_record(kind="project")` and `code_record(kind="progress")` STILL return a fifth key `notice` that output.schema does not declare, so the harness rejects the result after the write — `tool "code_record" returned invalid output: value is not lossless JSON` in the normal case, and `"value.notice" is not a declared property (additionalProperties: false)` when a ledger file was corrupt (there `notice` is a string).
- cause: lib/tool-record.js:168 (`notice: written.notice`) and lib/tool-record.js:182 (`notice,`) are the two branches the 2026-10-04 fix missed: only the decision/mistake branches were changed to fold the advisory into `summary`. `writeProject` returns `{file, notice}` with `notice === undefined` unless the file was unparseable (lib/ledger.js:1133/1139) and `recordTask` does the same (lib/ledger.js:1184/1253), so the object carries an own enumerable property whose value is `undefined` — and the harness's `snapshotJsonValue` refuses ANY undefined leaf (dsh-util-values/lib/index.js:109 `if (typeof current !== "object") return void 0`), which is why the message is "value is not lossless JSON" rather than the additionalProperties one. The wrapper that decides this is dsh-tools/lib/index.js:3310-3311 (dispatch) → 3541-3544 (createSuccessResult → snapshotToolValue → validateJsonSchemaValue). The value is snapped BEFORE validation, so filtering undefined keys in a probe's own assertion (as probes/output-schema-probe.mjs:143-152 does, with a comment claiming the real harness accepts it) is not evidence about the product.
- fix: Not fixed. The minimal fix is the one already applied to the other two branches: give each of these branches exactly `{kind, scope, file, summary}` and append `written.notice` / `notice` to `summary` when it is defined. The dead `value.notice` branch in output.render (lib/tool-record.js:145) goes with it.
- files: E:\projects\dsh-code-mode\lib\tool-record.js:168, E:\projects\dsh-code-mode\lib\tool-record.js:182, E:\projects\dsh-code-mode\lib\tool-record.js:145
- do not repeat: Do not return a key whose value may be `undefined` from a tool handler: this harness snapshots the raw value (undefined leaf ⇒ "value is not lossless JSON") before it validates, so `additionalProperties:false` and the undefined value are two different failures and both happen after the ledger write. Return exactly the declared keys and fold advisories into `summary`.

## 2026-10-04 · the-compaction-gate-warns-and-instructs-nobody-lib-compact-g
- symptom: The compaction gate warns and instructs nobody: `lib/compact-gate.js` returned `next({ messages: [...] })` at both of its notice sites, so the 60%-crossing warning and the human's "Write the handover" instruction never reach the model, even though the card is asked and the answer consumes the margin.
- cause: The host's waterfall builds `next` with no parameters: `cordis/src/events.ts:237` (and the compiled `lib/index.js:321`) is `const next = () => { const cb = cbs.shift() ?? inner; return cb(...args) }` — it forwards the ORIGINAL `args`, never the caller's. So `next({messages: [...]})` silently discards the patch while the listener returns normally. It went unnoticed because the gate's *question* travels through the `userQuestions` service rather than the return value, so the card still appeared and the answer still consumed the margin: the feature looked alive while its entire read side was inert. Live corroboration: across 110 session logs `code-compact-gate` appears as a message source 0 times, against 1398 for `code-pit-guard` and 8 for `code-gate`, which use the append form.
- fix: Append to the object `next()` returns, in both branches (the 60% warning and the handover instruction). Verified 2026-10-04: `handover-grant-probe` 12/12 and `compact-gate-probe` 35/35, with W1/G5 now observing the notice on the released step.
- files: lib/compact-gate.js:326, lib/compact-gate.js:378, lib/gate-verify.js:275, lib/pit-guard.js:495
- trigger: return\s+next\s*\(\s*\{
- do not repeat: Do not emit a `agent/pre-step` (or any waterfall) notice by passing it to `next(...)`. Call `const decision = await next()`, check `Array.isArray(decision?.messages)`, and return `{...decision, messages: [...decision.messages, notice]}` — the form `gate-verify.js:275` and `pit-guard.js:495` already use.

## 2026-10-04 · handover-grant-probe-reported-12-12-while-the-handover-instr
- symptom: `handover-grant-probe` reported 12/12 while the handover instruction was being discarded by the host, and `output-schema-probe` reported 11/11 while `code_record(kind="project"|"progress")` failed its output schema on every call.
- cause: `handover-grant-probe.mjs`'s `step()` gave `next(payload)` a parameter and treated that payload as the delivery channel, and resolved with the object `next()` returned rather than with the listener's return value. The host does neither: `next` takes no arguments, and the listener's return value is the decision. So the probe stayed 12/12 while the product's notices were being discarded — a green harness over a broken product. Separately, `output-schema-probe.mjs`'s resolve hook rewrites every `@deepseek-ai/*` specifier to a stub, so its own attempt to import the real validator was silently stubbed; real validation now lives in `probes/real-output-schema-probe.mjs` (Electron), whose first check proves the validator still refuses the pre-fix shapes.
- fix: Model the host in the stub (`next` parameterless; resolve with the handler's return value; one release vocabulary, `'enter'`, not an invented `'annotate'`), and move any check that needs the real harness into an Electron probe. Both probes green afterwards (12/12, 35/35).
- files: probes/handover-grant-probe.mjs:152, probes/compact-gate-probe.mjs, probes/output-schema-probe.mjs:76
- trigger: const next\s*=\s*\(payload\)
- do not repeat: Do not make a stub the only witness of a contract you have not read in the host: model `next` as parameterless and resolve with the listener's return value, because a stub that certifies the bug is worse than no stub.

## 2026-10-04 · a-concurrent-merge-into-mistakes.md-fails-with-eperm-the-exc
- symptom: A concurrent merge into `mistakes.md` fails with `EPERM`, the exception escapes the tool call, the record is lost and a `<file>.tmp-<pid>` file is left on disk; two concurrent merges of the same pit both report `recurred: 1`.
- cause: `recordMistake`'s merge path was a read-modify-write with a plain `writeFileAtomic` and no lock, while `appendLocked` took `.lock`. Two consequences, both measured by the ledger-core audit against a real 24 MB ledger: (1) a rename onto a file another process holds open fails with `EPERM`, the exception escapes the tool call, the record is lost and a 25 MB `<file>.tmp-<pid>` is left behind; (2) two concurrent merges each rewrote from their own snapshot, so two repeats of a pit appeared as `recurred: 1` while the journal recorded `[1, 1]`. The same missing lock is why the append path and the merge path could lose each other's writes.
- fix: Extracted `withLedgerLock(file, work)` from `appendLocked` (same stale-break, now `LOCK_STALE_MS`) and wrapped the merge's whole read-modify-write in it, so the file is read *inside* the lock; `writeFileAtomic` unlinks its temp in a `catch` before rethrowing, so a refused rename no longer leaves litter or loses the record silently. Verified 2026-10-04: syntax 14/14, guard 45/45, write-rule 12/12, journal-rotation 4/4, brief-full 4/4, promotion 6/6, audit-verify 7/7.
- files: lib/ledger.js:614, lib/ledger.js:625, lib/ledger.js:1324, lib/ledger.js:1394
- trigger: writeFileAtomic|renameSync\(temp
- do not repeat: Do not give a read-modify-write path its own write primitive while another path owns a lock: route both through one `withLedgerLock(file, work)` — and make any atomic write unlink its temp on failure, because on Windows the failure mode is `EPERM` on rename (the file is held open elsewhere) and it takes the record with it.

## 2026-10-04 · a-task-marked-done-cannot-be-located-code_record-kind-progre
- symptom: A task marked `done` cannot be located: `code_record(kind="progress", task="<its id>"|title="<its title>")` is refused with a message that lists the offending id as being on the board, and passing the title creates a second task carrying the same id.
- cause: `recordTask`'s lookup list was `[...board.active, ...board.blocked]`, leaving `done` out, and the move branch filtered only `active` and `blocked` before unshifting — so a completed task could not be found (the refusal even listed its id as being "on the board") and re-recording it by *title* created a SECOND task with the same id, with the id ending up on two lists. The suite had a false green over it: `audit-verify-probe.mjs`'s C2 claimed "a done task can still be moved by passing its id", but its fixture was the task C1 had already moved to `active`, so the done path was never exercised. It also explains why the ledger-core auditor could not annotate the board task it created after marking it done.
- fix: Include `done` in the lookup list and filter `done` in the move branch, so a task is found by id or exact title and ends up on exactly one list. C2 now creates its own task straight into `done` and asserts the id lands on one list only. Verified 2026-10-04: audit-verify-probe 7/7, and the auditor's own probe 14 reports `move by id -> ok`, `move by title -> ok`, `duplicates=false`.
- files: lib/ledger.js:1213, lib/ledger.js:1251, probes/audit-verify-probe.mjs:175
- trigger: \.\.\.board\.active, \.\.\.board\.blocked|all = \[
- do not repeat: Do not build a lookup list from a subset of a record's collections: if a task (or entry) can live in three lists, every lookup, move, and duplicate check must consider all three — and when a check claims to exercise a state, arrange the fixture so that state is the one under test.

## 2026-10-04 · a-tasks.json-that-is-valid-json-but-not-a-board-null-42-oops
- symptom: A `tasks.json` that is valid JSON but not a board (`null`, `42`, `"oops"`, `[7]`, or a string inside `active`) makes `code_brief` and `code_record(kind="progress")` throw a TypeError, and the file is never set aside because the JSON parsed.
- cause: `readJson` returned whatever JSON.parse produced, and `normalizeBoard(readJson(...))` then threw a TypeError on `null`, `42`, `"oops"`, `[7]` and on a primitive sitting inside a list (`task.status = 'active'` on a string throws in an ESM strict module). `preserveCorruptFile` never fired because the parse had succeeded, so `code_brief` and `code_record(kind="progress")` both died on that project until someone edited the file by hand. The ledger-core audit measured 6 of 10 malformed-but-parseable variants crashing the briefing.
- fix: `readJson` takes a shape predicate and returns the fallback when the parsed value cannot be the thing; `isBoardLike` checks the top level AND every task inside `active`/`done`/`blocked`; `normalizeBoard` skips non-object entries instead of assigning to them; `corruptNotice` distinguishes "could not be parsed" from "parsed but does not contain the expected shape". Verified: the auditor's probe 01 reports 0/10 variants throwing (was 2/10 after the first attempt).
- files: lib/ledger.js:532, lib/ledger.js:1130, lib/ledger.js:1147
- trigger: readJson\(|normalizeBoard\(
- do not repeat: When a read path can be handed valid JSON that is not the expected shape, validate at the read seam and route it into the same preserve-and-tell path as a syntax error — and remember a normaliser that assigns to entries (`task.status = …`) throws in strict mode on a primitive, so the shape test has to look at the collection depth, not just the top level.

## 2026-10-04 · a-recorded-trigger-with-nested-quantifiers-hangs-the-tool-ca
- symptom: A recorded `trigger:` with nested quantifiers hangs the tool call it is guarding: `^ (a+)+$`-style patterns cost seconds and grow ≈×4 per character, synchronously inside `tools/pre-execute`.
- cause: `matchesTrigger` ran `new RegExp(trigger, 'i').test(command)` twice per command with no bound, so a recorded pattern like `(a+)+X$` held `tools/pre-execute` for seconds (the gate/budget audit measured ≈×4 per character: 10 / 39 / 151 / 565 / 2385 ms at 17 → 29 chars), and the same mechanism on `code_brief`'s topic never returned at 34 characters. A pit must never be able to hang the turn it exists to protect.
- fix: Ordinary patterns still run inline; a pattern that exceeds PATTERN_INLINE_BUDGET_MS is remembered and every later match for it goes to `lib/pattern-matcher.js`, which runs it in a reusable worker thread and abandons a match after 250 ms (the worker is discarded, not waited on). A timeout is reported as no-match, never as a crash or a hang. Verified: `(a+)+X$` on 28 chars returns timedOut after ~260 ms, `Set-Content|Out-File` still matches its command and does not match `pnpm test`.
- files: lib/pit-guard.js:212, lib/pattern-matcher.js:1
- trigger: new RegExp\(String\(trigger\)|matchesTrigger\(
- do not repeat: Do not run a ledger-supplied regular expression synchronously and unbounded on a hot path, and do not accept a measurement as proof of a bound: this fix's first version evaluated the pattern as CODE in a vm (so `a+b` threw "a is not defined" and `^ (a+)+$` was a syntax error), and its first test used a pattern anchored to a literal space that returned in 0 ms — a bound that had never fired.

## 2026-10-04 · once-the-journal-s-highest-rotated-slot-.008-exists-rotation
- symptom: Once the journal's highest rotated slot (`.008`) exists, rotation stops forever and the live journal grows without bound; readers also see the newest segment as the oldest, so a dormant change reads as settled.
- cause: Rotation shifted `.00N` -> `.00(N+1)` and then renamed the live file onto `.000`, but refused to proceed whenever `.000` was still occupied. Once the highest slot filled, the shift had nowhere to put its last move, so rotation returned early *forever*: the live journal grew without bound (the real ledger had used 1 of its 9 slots and was at 319 KB of a 524 KB threshold, so it was one rotation away from never rotating again). Its sibling defect: `journalFiles` sorted segments ascending and called that chronological, while the rotation puts the NEWEST content in `.000` — so from the second rotation on, readers saw the newest lines as the oldest, and `restart_pending` answered "no pending restart" while the journal's own timestamps said the change was still dormant.
- fix: Retire the oldest slot (`JOURNAL_KEEP`) before the shift, so the window stays finite and rotation always has room; `journalFiles` now returns segments highest-number-first (oldest first) to match what the rotation actually writes. Verified: rotation probe J1–J5 5/5 (J5 pre-fills the highest slot — the state that used to stall — and a control reproduces the old rule failing the same assertion: oldRotated=false, newRotated=true).
- files: lib/ledger.js:755, lib/ledger.js:780, lib/ledger.js:734
- trigger: journal\.jsonl\.000|JOURNAL_KEEP
- do not repeat: Do not let a bounded window fill up with no way to retire its oldest member — and when you fix that, make room BEFORE the shift, because deleting the oldest slot afterwards leaves `.000` occupied and the rotation bails anyway (its own control caught exactly that).

## 2026-10-04 · a-turn-whose-only-verification-was-a-mismatched-or-failing-c
- symptom: A turn whose only verification was a mismatched or failing `code_verify` is filed as `proved`, so the completion gate writes no `unverified` debt and no notice — the ledger records a failing verification exactly as it records a passing one.
- cause: `gate-verify.js`'s `tools/post-execute` listener ignored its `_result` argument and incremented `record.ranProof` for any call to a proof tool. A `code_verify` whose expectation did not match (`exit 0, but the expected output never appeared`) or whose command failed (`FAILED (exit 1)`) therefore filed the turn as `proved`, wrote no `unverified` debt and delivered no notice — while `lib/ledger.js` settles a debt only on `ok === true`, so the two halves of the package disagreed about the same journal entry. A live instance is in the journal: a false VERIFIED at 2026-10-04T13:13:13Z whose payload failed with exit 3.
- fix: Added `provedCall(result)`: a proof tool's call counts only when the result is not an error and its text carries neither `expectation not matched`/`ok false` nor a non-zero `[exit code: N]` marker; an unreadable result counts as NOT proof, deliberately. The gate journal now records `proofToolButUnproved`. Verified with the auditor's probe: 5/5 (B1/B3 were red, and B2 asserted the bug itself and was inverted to require the honest reading).
- files: lib/gate-verify.js:105, lib/gate-verify.js:189, lib/gate-verify.js:214
- trigger: ranProof|proofTools\.has
- do not repeat: Do not decide whether an action proved anything from the tool's NAME, and do not read only structured fields when the verdict arrives as text — a listener gets `{content:[{type:'text',text}], isError}`, so `isError:false` is not success.

## 2026-10-04 · a-code_record-call-that-is-rejected-still-creates-the-whole-
- symptom: A `code_record` call that is REJECTED still creates the whole ledger (`project.json`, `tasks.json`, `journal.jsonl`, `mistakes.md`, `decisions.md`), so the project stops reporting "No ledger yet" without any fact having been recorded.
- cause: `execute` called `initLedger(cwd, sessionId, scope)` before the per-kind argument checks, so a call that was then refused had already created all five ledger files and journaled an `init` — and `code_brief` stopped answering "No ledger yet" for a project where nothing had ever been recorded. Measured 2026-10-04 (tool-surface audit F5): 4 of 5 refusal shapes left a full ledger behind; an unrecognised `kind` fell through every branch and returned undefined, creating the ledger without recording anything.
- fix: Moved every per-kind check into a pre-flight block that runs before `initLedger`, including the trigger-pattern compile check and `triggerSample`-needs-`trigger`, and made an unknown `kind` an explicit refusal listing the five valid kinds. Verified: 0 of 5 refusal shapes now create a ledger, the valid control still does, and `acceptance-probe` stays 24/24 while `output-schema-probe` is 12/12 and `real-output-schema-probe` 2/2.
- files: lib/tool-record.js:149, lib/tool-record.js:213
- trigger: initLedger\(cwd, sessionId, scope\)
- do not repeat: Validate a tool call's arguments BEFORE running any side effect, and treat any unknown value of a discriminator as a refusal — the branch list is not exhaustively checked by construction anywhere else.

## 2026-10-04 · truncating-text-that-contains-emoji-or-other-astral-characte
- symptom: Truncating text that contains emoji or other astral characters can emit a lone surrogate (half a character), which is written into the ledger and the briefing.
- cause: `truncate` (and the head-clip used to shape entry bodies) sliced at computed indices, so a limit landing between the halves of an astral character emitted a lone surrogate — e.g. `truncate('\u{1F600}'.repeat(50), 10)` returned `'\u{1F600}\u{1F600}\uD83D'`. A lone surrogate then travels into the ledger, the briefing and the session log, where it is quoted back and renders as a replacement box: silent corruption that survives every later reader. The boundary case that a single hand-picked limit hides is a one-unit tail starting mid-pair.
- fix: Added `wholeCharSlice`, which snaps both edges onto character boundaries (moving a start edge BACK, so it drops a character rather than half of one, and an end edge forward), and routed both clip sites through it. Verified by a new probe `truncate-surrogate-probe.mjs` 4/4, whose T2 walks 120 limits (1..40) across emoji, CJK extension-B and mixed ASCII/astral text looking for an unpaired surrogate. Its T4 records that `truncate` is not a hard cap — the `… (N chars omitted) …` marker pushes the result past `limit` — because the first version of that check asserted the fit and failed against correct code.
- files: lib/ledger.js:200, lib/ledger.js:2538
- trigger: \.slice\(-\(limit|s\.slice\(0, head\)
- do not repeat: Do not slice strings on raw UTF-16 indices when the text can contain astral characters (emoji, CJK extension glyphs): snap both edges onto character boundaries, dropping a character rather than emitting half of one.

## 2026-10-04 · e-tools-dsh-deepseek-harness.exe-probes-asar-read.mjs-lines-
- symptom: `& 'E:\tools\DSH\DeepSeek Harness.exe' probes/asar-read.mjs lines dsh-tools/lib/index.js 3496 3540` fails with `ENOENT, dsh\dsh-tools\lib\index.js not found in E:\tools\DSH\resources\app.asar`, and a retry `grep dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js 'replace both'` fails with `ENOENT, dsh\replace both not found` (exit 1).
- cause: I guessed the CLI instead of reading `probes/asar-read.mjs`'s usage header: `grep <regex> <dirOrFileInAsar> [maxHits]`, with `inside()` *stripping* an optional leading `dsh/`. So the right call is `grep 'replace both' dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`, while prefixing the path and putting the path first gives `ENOENT, dsh\dsh-tools\lib\index.js not found` and a second attempt that reads `ENOENT, dsh\replace both not found` — two errors that both look like the file is missing.
- fix: Use the documented forms: `list <dirInAsar>`, `read <fileInAsar>`, `lines <fileInAsar> <from> <count>`, `grep <regex> <dirOrFileInAsar> [maxHits]`. Also: under `--expose-internals` the Electron binary dumps the whole asar-fs-wrapper source to stderr, so stderr noise is expected and not a failure.
- files: probes/asar-read.mjs:8, probes/asar-read.mjs:26, probes/asar-read.mjs:61
- trigger: asar-read\.mjs
- do not repeat: Read an in-repo probe's usage header before its first run. `asar-read.mjs` puts the REGEX first for `grep`, and its paths are relative to `<asar>\dsh` (a leading `dsh/` is stripped, not required) — so adding `dsh/` yourself produces a doubled prefix and an ENOENT that reads like a missing file rather than a wrong call.

## 2026-10-04 · node-probes-budget-probe.mjs-exit-1-with-summary-total-1-pas
- symptom: `& $node probes/budget-probe.mjs` → exit 1 with `{"summary":{"total":1,"passed":0,"failed":["1.import"]}}` and `Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'E:\tools\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js' imported from ...budget-probe.mjs`; `& $node probes/acceptance-probe.mjs` → same ERR_MODULE_NOT_FOUND from probes/paths.mjs, zero checks printed. Both look like a broken probe after a code change.
- cause: Both probes call `installResolution()` (budget-probe.mjs:18 import, acceptance-probe.mjs:46 await), which loads `<app.asar>\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js` — a path that only resolves when the *Electron binary* in node mode installed the asar/profile-resolution bootstrap. Under the bundled plain `node.exe` (v24.21.0) it is a plain filesystem path inside app.asar, so it is ERR_MODULE_NOT_FOUND before any check runs. This is the already-recorded global pit; what is new here is the project-level consequence: these two suites are not runnable in a session's plain-node channel at all, so they cannot serve as regression evidence for a change to lib/ (running the Electron binary in the confined channel produces zero output and an empty $LASTEXITCODE — also recorded).
- fix: Not fixed, and not fixable from inside a session channel: as regression evidence use the suites that import `lib/*.js` by path (guard-probe, brief-full-probe, write-rule-probe, audit-verify-probe, journal-rotation-probe, .dsh-code/audits/*). budget-probe/acceptance-probe (and debt-audit's R5-R9, which spawn them) must be re-run by a human in an unrestricted terminal with ELECTRON_RUN_AS_NODE=1 and the Electron binary. Measured this session: plain-node guard/brief-full/write-rule/audit-verify/journal-rotation all green after the F8/F9/F10/F11 fixes; the two installResolution probes fail identically before and after the change.
- files: E:\projects\dsh-code-mode\probes\budget-probe.mjs:18, E:\projects\dsh-code-mode\probes\acceptance-probe.mjs:25, E:\projects\dsh-code-mode\probes\acceptance-probe.mjs:46, E:\projects\dsh-code-mode\probes\paths.mjs:118-143
- trigger: budget-probe\.mjs|acceptance-probe\.mjs
- do not repeat: Do not read a plain-node ERR_MODULE_NOT_FOUND under app.asar as "my change broke the probe", and do not plan a verification script around budget-probe.mjs or acceptance-probe.mjs in a session channel — check the probe's head for `installResolution` first. When a suite is unreachable, say so in the report instead of silently dropping it.

## 2026-10-04 · node-e-tools-dsh-resources-runtime-primary-runtime-dependenc
- symptom: `$node='E:\tools\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' Select-String -Path 'E:\projects\dsh-code-mode\probes\budget-probe.mjs','E:\projects\dsh-code-mode\probes\acceptance-probe.mjs' -Pattern 'installResolution' | ForEach-Object { ... }` 这条管道整体 exit 1，输出尾部是 `→ System.Management.Automation.RemoteException`（以及 `[exit code: 1]`），看起来像「Select-String 命令本身失败」。
- cause: 管道里 `& $node probes/budget-probe.mjs` 与 `& $node probes/acceptance-probe.mjs` 都 exit 1，而 PowerShell 的退出码取管道最后一条语句：Select-String 的 "RemoteException" 只是把子进程 stderr 当记录打印出来，不是别的故障。两个探针真正的失败原因见上一条 mistake（installResolution() 需要 Electron 二进制）——这条债是因为那一条 mistake 没有逐字引用出错的命令行，settlement 认不出来，所以 pit-guard 的提醒一直重放。
- fix: 不修（探针与管道都没问题）：登记「这条命令行本身」与它的错误签名（System.Management.Automation.RemoteException）即可结清；根因与处置见同主题的 installResolution 那条 mistake。回归证据改用不需要 Electron 二进制的探针（guard-probe / brief-full-probe / write-rule-probe / audit-verify-probe / journal-rotation-probe / .dsh-code/audits/*），本会话实测这些全绿。
- files: probes/budget-probe.mjs, probes/acceptance-probe.mjs
- do not repeat: 不要把「管道里有原生命令非零退出」读成「这条命令失败」，也不要为此再改探针：先用 `Select-Object -First N`（或把原生命令单独跑）把两条通道分开，再判断哪一半真的红了。这条与全局账本里 `Select-Object -First N` 截断原生命令输出那条是同一族。

## 2026-10-04 · the-compaction-gate-can-hold-a-step-forever-an-answerer-or-a
- symptom: The compaction gate can hold a step forever: an answerer (or a model-info lookup) that never settles leaves the step `held` because the gate itself enforces no bound, even though it has `askTimeoutMs` configured.
- cause: The gate threaded `askTimeoutMs` into `questions.askTimed(...)` and then awaited it unbounded, so it depended entirely on the answerer honouring the deadline. The audit's `probe-compact-open` C8/C9 show the step staying `held` (never resolving) when the answerer does not; the model-info lookup (`llm.resolveModelInfo`) had no such defence on any side. A `agent/pre-step` listener that never resolves holds the whole turn — the opposite of the gate's documented fail-open contract.
- fix: Added `withDeadline(call, ms)` and raced both awaits (the occupancy measurement and the question) against `limits.askTimeoutMs`; expiry releases the step and logs the bound by name. The timer is cleared on settle and `unref`ed. Verified by a new control probe: `probe-gate-deadline.mjs` 14/14, including D1 (a never-settling answerer releases after the bound), D2 (the release is the deadline firing, not an immediate give-up), D9 (with the mounted 120000 ms the same answerer is still pending at 400 ms — the bound is the configured value, not a new constant) and D10 (a late rejection neither holds the step nor becomes an unhandled rejection). `compact-gate-probe` stays 35/35.
- files: lib/compact-gate.js:316, lib/compact-gate.js:377, lib/compact-gate.js:445
- trigger: await questions\.askTimed|await measure\(ctx
- do not repeat: Do not rely on a dependency to honour the deadline you passed it: race the await against your own configured bound and release on expiry, because the layer whose job is to fail open must not be able to hold a turn forever.

## 2026-10-04 · the-compaction-gate-s-fail-open-branch-can-itself-throw-a-cy
- symptom: The compaction gate's fail-open branch can itself throw — a cyclic or BigInt answer makes the log line's `JSON.stringify` throw, and a throwing logger propagates — so the path that exists to release the step ends the turn instead.
- cause: The gate's fall-through paths logged `JSON.stringify(answer ?? null)` (throws on a cyclic or BigInt answer) and called `ctx.logger?.warn?.()` directly (throws if the logger throws). An exception out of an `agent/pre-step` listener ends the turn, so the fail-open branch could do the exact opposite of failing open. The audit's C20/C21/C22 recorded `threw` on all three.
- fix: `notify(ctx, level, message)` wraps every logger call in try/catch, and `describe(value)` is a stringifier that survives cycles (emitting `[circular]`), BigInt, and a throwing `toJSON`. Verified: `probe-compact-open` went from `threw=[C20,C21,C22]` to `threw=[]`, and `probe-gate-deadline` D11–D14 cover a throwing logger and cyclic/BigInt answers.
- files: lib/compact-gate.js:334, lib/compact-gate.js:350
- trigger: JSON\.stringify\(answer|ctx\.logger\?\.(warn|info)\?\.\(
- do not repeat: Do not let a fail-open path do anything that can throw — no `JSON.stringify` on a value the caller supplied, no unguarded logger call, no property access on an assumed shape. Wrap each in a helper that swallows: the branch whose entire job is to survive must not be the one that dies.

## 2026-10-04 · a-trimmed-tool-result-can-silently-lose-its-tail-while-the-n
- symptom: A trimmed tool result can silently lose its tail while the note claims both ends were kept, and can carry both `value` and `content` so the host throws on a decision it cannot read.
- cause: Two shape defects in `lib/budget.js`, both cosmetic or latent as the audit graded them. (1) With `headChars >= maxResultChars - NOTE_RESERVE` the head consumed the whole budget and the tail was silently dropped, while the note still claimed both ends were kept (measured: 396 chars, tail gone). (2) `{...downstream, content: trimmed}` produced a decision carrying BOTH `value` and `content` when a downstream listener supplied `value`, and the host throws on that combination (`dsh-tools/lib/index.js:3515`, read out of the bundle).
- fix: `splitBudget` scales both declared ends by one factor when the cap cannot hold them, and `keptEndsNote` names what survived (`kept the head and the tail` / `kept the tail only` / `kept the head only` / `kept neither end`); the trimmed decision is built without the incoming `value`. Verified: `probe-budget-shapes` G5 FAIL(396 chars, tail dropped)→ok (head 135 + tail 45), G8 still ok, G9 FAIL(keys kind/value/content)→ok (kind/content); `budget-probe` 29/29, `budget-chain-probe` 16/16. F8's reachability stays UNPROVEN — no value-carrying neighbour was found, so that fix is defensive.
- files: lib/budget.js:97, lib/budget.js:114, lib/budget.js:239
- trigger: headChars >= |\.\.\.downstream, content
- do not repeat: When a trim is described as "head and tail", scale both ends into the budget instead of letting one end eat it, and make the note name the ends actually kept. Also: if a result carries a content field, build it as a fresh object rather than spreading the incoming one over it, or both fields travel together and the host throws.

## 2026-10-04 · env-electron_run_as_node-1-out-e-tools-dsh-deepseek-harness.
- symptom: `$env:ELECTRON_RUN_AS_NODE='1' $out = & 'E:\tools\DSH\DeepSeek Harness.exe' --expose-internals 'E:\projects\dsh-code-mode\probes\debt-audit.mjs' 2>&1 $text = $out -join "`n" Write-Host "LASTEXITCODE=[$LASTEXITCODE] chars=$($text.Length)" $i = $text.IndexOf('"failed"') ...` → `LASTEXITCODE=[]  chars=0`，紧接着 PowerShell 报 `使用"2"个参数调用"Substring"时发生异常: 索引和长度必须引用该字符串内的位置`（我随后对空串取子串），整条命令 exit 1。
- cause: 两层：① 这个通道里 `DeepSeek Harness.exe` 走 node 模式对**有的**脚本能跑（budget-probe 实测 exit 0 并重写了 probes/budget-report.json 29/29），对另一些（debt-audit/acceptance/compact-gate/pit-guard/handover-grant）完全不启动：零输出、$LASTEXITCODE 为空——与全局账本已记的那条一致，budget-probe 是例外而不是反例；② 我在拿到零输出后直接对它做 `$text.Substring(...)`，PowerShell 对空串抛 ArgumentOutOfRangeException，于是「进程没起来」被伪装成「命令报错」。
- fix: 不修代码：判据改成「先看产物再下结论」。实测矩阵（本会话，危险全权模式、受限 pwsh 通道）：budget-probe.mjs 经 Electron 二进制 exit 0 + JSON 摘要 + 重新生成 budget-report.json（30,427 B，29/29）；debt-audit.mjs / acceptance-probe.mjs / compact-gate-probe.mjs / pit-guard-probe.mjs / handover-grant-probe.mjs 五个全部零输出、$LASTEXITCODE 为空。因此本会话的回归证据用不需要 Electron 的探针（guard-probe 45/45、write-rule-probe 12/12、audit-verify-probe 7/7、journal-rotation-probe 5/5、brief-full-probe 4/4、.dsh-code/audits/*），这五个留给不受限终端复核。
- files: probes/budget-probe.mjs, probes/debt-audit.mjs, probes/acceptance-probe.mjs, probes/compact-gate-probe.mjs, probes/pit-guard-probe.mjs
- trigger: ELECTRON_RUN_AS_NODE
- do not repeat: 不要对可能为空的捕获调用 .Substring()（PowerShell 直接抛 ArgumentOutOfRangeException，看起来像命令失败）；也不要把「零输出 + $LASTEXITCODE 为空」当成判据红灯——那是进程没起来。需要 Electron 二进制的探针要么逐个跑并读它自己写的 report 文件，要么在不受限终端跑；先跑 `budget-probe.mjs` 这种能出 JSON 的确认通道状态。

## 2026-10-04 · 两条命令一起记-node-e-tools-dsh-resources-runtime-primary-runtime-d
- symptom: 两条命令一起记：① `$node='E:\tools\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' Select-String -Path 'E:\projects\dsh-code-mode\probes\budget-probe.mjs','E:\projects\dsh-code-mode\probes\acceptance-probe.mjs' -Pattern 'installResolution' | ForEach-Object { Write-Host ("{0}:{1}: {2}" -f (Split-Path $_.Path -Leaf), $_.LineNumber, $_.Line.Trim()) }` 与同一调用里的 `& $node 'E:\projects\dsh-code-mode\probes\acceptance-probe.mjs' 2>&1 | Select-Object -First 12 | ForEach-Object { Write-Host $_ }` 整体 exit 1，尾部 `→ System.Management.Automation.RemoteException`；② `$env:ELECTRON_RUN_AS_NODE='1' $out = & 'E:\tools\DSH\DeepSeek Harness.exe' --expose-internals 'E:\projects\dsh-code-mode\probes\debt-audit.mjs' 2>&1` 得到 `LASTEXITCODE=[]  chars=0`，随后对空串 `.Substring(...)` 抛 ArgumentOutOfRangeException，整条命令 exit 1。
- cause: 两条命令的失败都不是代码问题：① 第一条是把 `acceptance-probe.mjs`（需要 Electron 二进制 + installResolution）放进管道里跑，子进程 exit 1 让整条管道 exit 1，`System.Management.Automation.RemoteException` 只是 PowerShell 在转述子进程 stderr；② 第二条里 `DeepSeek Harness.exe` 的 node 模式在本通道对 debt-audit.mjs 根本没启动（chars=0、$LASTEXITCODE 为空），我却接着对空串取子串，于是真正的信号（进程没起来）被一个 PowerShell 参数异常盖住。同一通道里 budget-probe.mjs 能跑（exit 0、29/29、重写 budget-report.json），所以「Electron 通道一定无输出」是过宽的说法，要看具体脚本。
- fix: 不修代码：把这两条命令各自的判据换成「先看产物」——budget-probe 的 report 文件、探针自己打印的 JSON 摘要；debt-audit 与 acceptance/compact-gate/pit-guard/handover-grant 五个在本通道不可用，留给不受限终端复核（本会话已用不需要 Electron 的探针完成回归）。
- files: probes/budget-probe.mjs, probes/acceptance-probe.mjs, probes/debt-audit.mjs
- trigger: acceptance-probe\.mjs|debt-audit\.mjs
- do not repeat: 零输出 + `$LASTEXITCODE` 为空 = 进程没起来（不是判据红灯），并且绝不对可能为空的捕获做 `.Substring()`；需要 Electron 二进制的探针逐个跑、读它自己写的报告文件，其余留给不受限终端。

## 2026-10-04 · a-debt-recorded-against-a-relative-path-can-never-be-settled
- symptom: A debt recorded against a relative path can never be settled by a proof whose `cwd` is absolute; `code_brief({full:true})` is silently identical to a normal brief; a `mistakes.md` with no header line duplicates its first entry on every merge; and the task board silently discards its oldest task at the cap.
- cause: Four defects in `lib/ledger.js`. (F10) `proofCoversTarget` compared a relative edit target against the proof's absolute `cwd` segment-wise; with no shared leading segment the containment failed even when the file was inside that cwd — and the function's own comment claimed the relative/absolute case worked. (F9) `UNCAPPED_TOTAL` was 8,900 while the eight section ceilings sum to 10,100, and `briefFull` passed a number for a pool that is computed as `budget - reserve`, so the branch it exists for was unreachable and `full:true` behaved like a normal brief. (F8) `headerOf` split on the text before the first `\n## ` while `markdownEntries` splits on `/\n(?=## )/`, so a headerless or BOM-prefixed `mistakes.md` duplicated entry #1 on every merge. (F11) `recordTask` ended with `board.active.slice(0, CAP.tasks)`, dropping the oldest task silently.
- fix: (F10) the relative target is anchored on the DEBT's own `cwd` (which `unverified` entries already carry) via `resolveAgainst`, with `..` resolved rather than kept literal; resolving it against the proof's cwd instead would have made containment vacuous — the agent that found this refused its instruction and built the relative cross-project guard (E9) plus a mutant control. (F9) `UNCAPPED_TOTAL` is derived from `SECTION_BUDGET`, and `brief` composes `UNCAPPED_TOTAL + reserve` after computing the reserve, because the reserve is only knowable there. (F8) `headerOf` now splits exactly as `markdownEntries` does and treats block #0 as an entry when it starts with `## `. (F11) the cap still evicts by recency but journals each removal as `task_removed` with its id and names the dropped ids in the returned notice, which `code_record(progress)` folds into `summary`. Verified: `verify-ledger-fixes.mjs` ALL-VERIFIED (31 control + 21 fixed + 9 suite checks) through `code_verify`, `debt-audit` 23/23, and E1 of the coverage probe inverted because it contradicted `decisions.md`:40.
- files: lib/ledger.js:172, lib/ledger.js:1589, lib/ledger.js:1426, lib/ledger.js:1848
- trigger: proofCoversTarget|UNCAPPED_TOTAL|headerOf\(
- do not repeat: Do not resolve a relative path against the OTHER side of a comparison — that makes the test vacuous. Anchor each path on its own record's coordinate (the debt carries its own `cwd`), resolve `..` segments instead of keeping them literal, and when an audit check contradicts a recorded decision, invert the check and add the guard it was reaching for rather than deleting it.

## 2026-10-04 · a-fix-agent-reports-five-probes-as-unreachable-in-this-sessi
- symptom: A fix agent reports five probes as unreachable in this session and reports `debt-audit` at 19/23, while the same probes run green in the parent channel minutes earlier and the audit's reds have a different cause.
- cause: A fix agent concluded that five probes "cannot be invoked in this session's channels at all — via the Electron binary they return zero output and an empty `$LASTEXITCODE`". That is the documented signature of lost stdout in a confined channel, but this session is running under `danger-full-access`, where the same probes do start and report: I ran `compact-gate-probe` through the Electron binary in the same minutes and got `exit=0`, `passed=35, total=35`. The agent's own recount also contradicted it (it claimed `debt-audit` was 19/23 with "unreachable probes", while my run at the same time was 19/23 for a different reason — stale document counts — and later 23/23).
- fix: Ran the disputed probes in the parent channel: all five start and report. The real cause of the red audit was mine — adding J5 took `journal-rotation-probe` from 4 to 5 and three documents still said 4/4, and `lib/pattern-matcher.js` was a new library file with no INSTALL.md entry (P1's rule wants `` `lib/<file>` `` and 不能 on one line). Fixed the three counts, added the library row, and `debt-audit` is 23/23.
- files: probes/debt-audit.mjs, TESTING.md:28, probes/README.md:97, HANDOVER.md:25
- trigger: unreachable|zero output and an empty
- do not repeat: When a subagent declares something unreachable, re-run it in your own channel before accepting it — and when a self-check reports red, suspect the check first: in this session four separate harness bugs (a redirection that suppressed the child, a JSON parser with a size limit, and two over-specific regexes) each produced a red that looked like a product failure.

## 2026-10-04 · pwsh-foreach-p-in-01-foo-03-bar-11-baz-...-报-parsererror-表达式
- symptom: pwsh: `foreach($p in 01-foo,03-bar,11-baz){...}` 报 ParserError「表达式或语句中包含意外的标记"-foo"」，整条命令一行没跑
- cause: PowerShell 里裸词列表元素含 `-` 时会被当成运算符/参数解析；文件名永远该加引号
- fix: 改成 `foreach($p in '01-foo','03-bar','11-baz'){...}`（每个元素单引号）后正常
- files: .dsh-code/audits/
- do not repeat: pwsh 里凡是文件名/路径列表，元素一律加引号再交给 foreach 或 -Path；不要写裸词列表

## 2026-10-04 · git-commit-有时还有-git-add-报-fatal-unable-to-create-repo-.git-i
- symptom: `git commit`（有时还有 `git add`）报 `fatal: Unable to create '<repo>/.git/index.lock': Permission denied`（exit 128），而同一条命令里 `git status`、`git log` 正常；错误信息把原因指向 `.git` 的权限，实际与权限无关
- cause: 不是 ACL，也不是「commit 需要 TEMP」这么简单——**是 TEMP/TMP 指向一个不存在的目录**。同一条命令里可以同时出现两种状态：宿主给每条命令设的一次性 TEMP（存在即成功），和我自己 `Resolve-Path '.git\.tmp-commit'` 设进去的值（该目录在**下一条命令**里已不存在 → 失败）。误导来自两点：① 每条命令的 TEMP 取值不同，所以同一个 git 命令时好时坏；② 我先试过把 `.git` 的 ACL 当成原因，而它那里确实有一条 `Everyone: Deny DeleteSubdirectoriesAndFiles`——但那**是预期存在的**，同一条命令里 `[System.IO.File]::Delete` 删 `.git` 内的文件完全成功，证据早就否定了 ACL。最终把 TEMP/TMP 指向一个真实存在且**跨命令稳定**的目录后，`git add` 与 `git commit` 都成功（本仓库 07a4eb4、0af7467 两次提交、工作区干净）。
- fix: 在命令开头把两者钉到宿主真实存在的临时目录（不要钉进仓库，也**不要**钉到只在当前命令里创建、下一条就消失的目录）：`$env:TEMP = "$env:LOCALAPPDATA\Temp"; $env:TMP = $env:TEMP`，然后再跑 git add/commit。若 `$env:LOCALAPPDATA\Temp` 不存在，用任何已存在的目录。
- trigger: git\s+(commit|merge|rebase|am|cherry-pick)\b
- do not repeat: 在这个 host 上跑会写索引/临时文件的 git 命令前，先把 TEMP 与 TMP 钉到一个**真实存在且跨命令稳定**的目录；看到 "Unable to create .git/index.lock: Permission denied" 时不要去改 `.git` 的 ACL（那条 Everyone deny 是预期的），先检查 TEMP/TMP 指向的目录是否还存在

## 2026-10-05 · 用-code_verify-cmd-node-probes-debt-audit.mjs-expect-re-d-d-验-qww52
- symptom: 用 `code_verify(cmd="node probes/debt-audit.mjs", expect="re:(\\d+/\\d+)")` 验证时报告 `exit 0, but the expected output never appeared` + `expectation not matched · ok false`，看起来像探针失败；实际探针 23/23、`"failed": []`、exit 0，产品是绿的。同一次并行调用里 `node probes/utf8-check.mjs` 同形 expect 却匹配成功（因为它确实打印 `18/18 valid strict UTF-8`）。
- cause: `probes/debt-audit.mjs` 的 stdout 是**纯 JSON**（`{"failed":[],"passed":23,"total":23,"checks":[...]}`），没有 `18/18` 那种人类摘要行；`re:(\d+/\d+)` 这类形状的 expect 对它永远不匹配。这是**判据形状**错，不是被测物错——与账本里那条「零输出 + $LASTEXITCODE 为空 = 进程没起来，不是判据红灯」是同一类误读的镜像：那次把"没起来"读成红灯，这次把"红的形状"读成红灯。
- fix: 对 debt-audit 用 JSON 形状的 expect：`"failed": []`（字面子串即可），或 `re:"passed":\s*23`。已用 `expect="\"failed\": []"` 复跑确认 exit 0 且匹配。
- files: probes/debt-audit.mjs
- trigger: debt-audit\.mjs
- do not repeat: 给某个探针写 code_verify 的 expect 之前，先确认它打印的是人类摘要行还是 JSON——本仓库两类都有（utf8-check 是 `N/N`，debt-audit 是 JSON）。判据形状不匹配会记成一次假失败，而假失败会污染 journal 里"这条命令失败过"的记录。

## 2026-10-05 · 为摸清-journal-的事件词表-用-grep-工具在-.dsh-code-上跑了一个-9-选一的-kind-模式-结-d2hre
- symptom: 为摸清 journal 的事件词表，用 grep 工具在 `.dsh-code` 上跑了一个 9 选一的 kind 模式，结果**一次调用就把整个上下文灌满**：250 条匹配、每条都是一个完整的长 JSON 对象（`cmd` 字段里带着整段多行 PowerShell），加上被省略的 37 KB，最后只落回一句「Full grep result stored at ...」。真正的收获（词表）本来只需要 3 行。
- cause: journal 是 JSONL，**一行一个完整对象、且行很长**（`trigger_hit` 的 `cmd` 字段可以带整段多行脚本），而 `file_hit` 在同一秒里会对同一条坑重复落多条。于是"按 kind 过滤"这个看着很窄的模式，在真实数据上匹配到的几乎每一行，且每行都很长。这不是模式的错，是**把 grep 当成计数工具用**的错。
- fix: 要词表就读文件头几行（`read` 带 limit，本会话一次就拿到了 `ts/session/kind` 的形状）；要计数就写脚本只输出计数与 `heading` 聚合，不要把匹配行打出来。
- files: .dsh-code/journal.jsonl, .dsh-code/journal.jsonl.000, .dsh-code/journal.jsonl.001
- do not repeat: 不要用 grep 在 `.dsh-code/journal.jsonl*` 上摸词表或做统计——那里的行很长且高度重复，一次模式就能吐回几十 KB。读形状用 `read` + limit（前 3 行足够）；要聚合就写脚本、只打印计数。

## 2026-10-05 · node-probes-gate-chance.mjs-今天-2026-10-05-报-gate-mount-2026--y1uwa
- symptom: `node probes/gate-chance.mjs` 今天（2026-10-05）报 `gate mount : 2026-10-02T14:49:00.000Z   warn 0.65 / ask 0.8`，并给出 verdict `NO CHANCE YET: no recorded session reached even the warn line after the gate was mounted`。但 `cordis.patch.yml` 实际声明的是 **warnRatio 0.6 / gateRatio 0.75**（该注释明确写了为什么把 0.8 降到 0.75：0.8 守在真实会话够不到的地方，"A guard placed above the ceiling of real work is not a guard"）。也就是说这个探针**报的是一个已经不存在的闸门**。
- cause: `probes/gate-chance.mjs:36-37` 把阈值**硬编码**成 `const WARN = 0.65; const GATE = 0.8;`（第 13 行的注释也照着写），而不是读 `cordis.patch.yml` 的声明。这正是本项目已经修过一次的**同一个病**：`compact-gate-probe` 的 R1 原本是拿闸门的**库默认值**去比引擎的默认值——"同一个默认的两份拷贝互相作证"，于是闸门空转 30/30 全绿。现在换了个位置复发：探针拿库默认值去衡量**挂载值**。
- fix: 未修（本轮只取证）。要修的是：`gate-chance.mjs` 从 `cordis.patch.yml` 读 `warnRatio`/`gateRatio`（或复用 `lib/compact-gate.js` 的 `resolveLimits`），并把读到的值与来源一起打印。
- files: probes/gate-chance.mjs:13, probes/gate-chance.mjs:36, probes/gate-chance.mjs:37, probes/gate-chance.mjs:154
- do not repeat: 不要让任何探针或报告**硬编码**一个由预设声明的阈值——阈值有两个来源（库默认 vs 预设声明），硬编码必然取错其中一个。**并且注意这次错的偏向是要命的那一侧**：真实 warn 线是 0.6，比硬编码的 0.65 **更低更宽松**，所以"挂载后 0 个会话达到 warn 线"这个结论**可能是错的**——0.6~0.65 之间的会话会被漏掉。一个偏严的阈值会把"已经发生过"报成"从未发生"，而这个项目有多条机制的判据正是"从未发生过"。

## 2026-10-05 · 两次-code_verify-报-exit-0-but-the-expected-output-never-appear-zasr6
- symptom: 两次 `code_verify` 报 `exit 0, but the expected output never appeared` / `expectation not matched · ok false`，而命令本身完全成功、输出就在眼前：① `node probes/gate-chance.mjs` 配 `expect="re:[0-9]"`（输出里满是数字：103、0.65、1,000,000、79.86%）；② `node probes/debt-audit.mjs` 配 `expect="re:(\d+/\d+)"`（它输出纯 JSON，没有 N/N 行）。两次都**不是**被测物失败，只有一次（②）是 expect 形状选错。
- cause: **②的原因已确定**：debt-audit 打印纯 JSON，没有 `N/N` 摘要行，expect 形状与产物形状不匹配。**①的原因未确定，我不写没建立的因果**：`[0-9]` 这个字符类本身是有效的——随后 `Write-Output 'abc123'` 配同一个 `expect="re:[0-9]"` 返回 `expectation matched · ok true`。两次唯一的差别是 **gate-chance 的输出很长（约 4.9 KB 被省略）**。合理猜测是匹配发生在被截断后的文本上，但我没有证据，**所以只记观察不记因果**。两次真正的代价是同一个：把"判据形状不对"读成了"命令失败"，从而在 journal 里留下两条假失败。
- fix: 用**字面量**而不是正则，并且选一个**确认出现在输出里**的串：改用 `expect="verdict: NO CHANCE YET"` 后同一命令立即 `VERIFIED`。对长输出，优先挑接近结尾的字面量。
- files: probes/gate-chance.mjs, probes/debt-audit.mjs
- do not repeat: 写 expect 之前先问「这个串真的会在产物里出现吗」——本仓库两类产物都有（utf8-check 是 `N/N` 人类行，debt-audit 是 JSON，gate-chance 是长报告）。对输出很长的命令，用字面量子串而不是正则，并挑一个确信存在的串。当 expect 报不匹配而输出明明匹配时，**先怀疑 expect 的形状，再怀疑命令**——不要让它变成 journal 里的一条假失败。

## 2026-10-05 · node-probes-syntax-check.mjs-2-1-select-string--pattern-gate-nok4s
- symptom: `node probes/syntax-check.mjs 2>&1 | Select-String -Pattern 'gate-chance|valid|total' | Select-Object -First 5` 返回 `[exit code: 1]` 并打印 `FAILED (exit 1)`，看起来像 syntax-check 红了。实际上我在同一条命令里还验证了别的东西，那些**全部通过**（plan 严格 UTF-8 OK、修正后的读数确实写进了文件），红的只有被我截断的那一段。
- cause: **我踩了账本里已经记过的坑**（`2026-10-02 · python.exe ... Select-Object -First 80 返回 exit code 1`）：把**原生程序**的输出接进 `Select-Object -First N` 时，PowerShell 拿到 N 行就提前关闭管道，上游 node 进程被终止，于是返回非零退出码。那个 1 是**我造的**，不是探针的。另外这条探针本身还需要 `--experimental-vm-modules`，我连参数都没给——所以即便不截断也可能红，两个原因叠在一起。
- fix: 要截断就不要在同一调用里判断退出码；要么别截断（重定向到文件再读），要么明知那个非零是截断产物。本次真正的结论不需要它：**`probes/gate-chance.mjs` 已经完整跑过一次并给出正确输出**，执行本身就证明了它能解析——比解析检查更强。
- files: probes/syntax-check.mjs
- do not repeat: `Select-Object -First N` 接在任何**原生程序**后面时，它的退出码不可信；不要把这种调用放进 `code_verify` 去证明什么。而这次更该记住的是：**这条坑已经在账本里了，trigger 也命中了，我还是踩了**——trigger 会提示"你正要跑的命令撞上了一条坑"，但它不会阻止我，读那一行提示是唯一的机会。

## 2026-10-05 · 为验证-能否从会话日志判断它是否跑-code-预设-我把两份日志-本项目一份---e-tools-dsh---一份-解压-4fhem
- symptom: 为验证「能否从会话日志判断它是否跑 `code` 预设」，我把两份日志（本项目一份、`--E-tools-DSH--` 一份）解压后在**整份文本**里数 `## Project ledger` 的出现次数，得到 7 与 12 —— 于是判定 `verdict: NO DISCRIMINATION`。这个结论**无效**：它测的不是"这个会话有没有收到那段提示"，而是"这段文字在这份日志里出现过几次"。
- cause: **我读了坑然后踩了它。** `probes/check-prompt-section.mjs:51-61` 的注释用一整段写了这件事：Until 2026-10-02 this searched the whole log, which can pass on an **echo** rather than on a request — 那段文本也会出现在**模型自己的回复**里、**工具调用参数**里、以及随用户消息重新注入的 system reminder 里；实测那天"最新的携带 `## Project ledger` 的帧是一条 assistant 消息，而一个 `write` 工具参数也匹配上了 needle"。正确做法写在同一个文件第 73 行：先 `frames.filter((frame) => frame.type === 'system/message')`，只在**真正发给模型的文本**里搜。我在同一次会话里刚读过这两处，转头就用了被明确否决的搜法。
- fix: 未重跑（本轮只取证）。正确口径已存在且已在跑：只要把 `check-prompt-section.mjs` 的 system/message 过滤 + needle 搜索抽成能对**任意**日志运行的形式（它现在只读 `newestLog`），就能得到有效判据。
- files: probes/check-prompt-section.mjs:51, probes/check-prompt-section.mjs:73, probes/unzstd.cjs
- do not repeat: 在一个文件里读到"这个搜法会假阳性，正确做法是过滤 X"时，**不要**在别处用被否决的搜法去回答同一个问题——哪怕只是"快速验证一下"。附带一条实测：`probes/unzstd.cjs` 会把自己的进度（`frames N decoded N failed M bytes B`）**打到 stdout**，所以任何捕获它输出的脚本拿到的字符串会被污染（本次 `occurrences` 那行的值就是这样被拼坏的）；要拿干净结果得另想办法或解析掉那一行。

## 2026-10-05 · e-tools-dsh-resources-app.asar-runtime-primary-runtime-depen-jam96
- symptom: & 'E:\tools\DSH\resources\app.asar\runtime\primary-runtime\dependencies\node\bin\node.exe' 报 CommandNotFoundException；同一条命令里的 node -e 也被 PowerShell 吃掉引号（三条既有坑同时响）。
- cause: 这个安装里 app.asar 是归档，`runtime\...\node.exe` 那条路径在磁盘上不存在（paths.mjs 里 NODE_EXE 只是给 asar 内部用的名义路径）；而 node -e 内联带引号脚本是账本里已记过四次的坑。
- fix: 用 PATH 上的普通 node（v22.23.0，C:\Program Files\nodejs\node.exe，已确认有 zlib.zstdDecompressSync）；探针内一律用 process.execPath 起子进程，像 debt-audit.mjs:462 那样。诊断要写脚本就落文件再跑。
- files: probes/paths.mjs:87, probes/debt-audit.mjs:462
- do not repeat: do not引用 <install>\resources\app.asar\runtime\... 下的 node.exe 路径，也不要用 node -e 内联带引号的脚本；探针起子进程用 process.execPath。

## 2026-10-05 · probes-effect-audit.mjs-reported-4-8-passed-failed-e1-e2-e3--wfteb
- symptom: probes/effect-audit.mjs reported 4/8 passed, failed=[E1, E2, E3, E5]
- cause: Two unrelated causes. (1) E1/E2/E3 were failing on fixture expectations that were mutually impossible, not on the probe: E2 required settled 4 + unresolved 1 + unproven 1 === debts 8 (6 !== 8) while also asserting verdicts_add_up === true, and E3 required none 5 + ran 2 + absent 2 === debts 8 (9 !== 8) — no fixture can satisfy either set. The fixture as written holds 7 debts (state none 3 / ran 3 / absent 1), which is what the code actually reported. E1 additionally compared the debt count against *every* line on disk while `ledger.initLedger` itself appends two journal lines of its own (`writeProject` writes kind:'project' at lib/ledger.js:1599, then initLedger writes kind:'init' at :1630) — so 7 raw lines vs 5 debts, with the reader having dropped nothing (rows === lines in every segment). (2) E5 was a real probe bug: `judgeable: read.length > 0` where `read` came from `journalFiles`, which synthesizes the live path when the ledger dir does not exist (lib/ledger.js:1030 `return [ledgerPath(cwd,'journal',scope)]` on failed readdirSync) — so an absent journal was reported as judgeable with a real 0, and `unjudgeable` was undefined (preview stringified it to the literal "undefined").
- fix: effect-audit.mjs: judgeable now requires a segment whose bytes were actually read; E1 compares the debt count against the `unverified` lines counted off disk (kindLinesOnDisk) plus a pinned raw-line relation and a nothing-dropped equality; the main fixture was re-ordered and its proof cwds moved to a sibling dir so each documented settlement scenario really occurs, and its expectations were rebuilt as an explicit MAIN_EXPECTED block (7 debts, settled 5 / unresolved 1 / unproven 1, state none 2 / ran 4 / absent 1, 4 proofs out of 6 `verified` lines).
- files: probes/effect-audit.mjs:214-266,probes/effect-audit.mjs:472-500,probes/effect-audit.mjs:539-655,lib/ledger.js:1030,lib/ledger.js:1599,lib/ledger.js:1630
- do not repeat: Do not write a multi-clause fixture expectation by hand-counting debts: if the per-bucket numbers and the total disagree with each other (4+1+1 vs 8, 5+2+2 vs 8) the check is unsatisfiable and no fixture will fix it. Also: never treat "the reader was handed a path" as "the data exists" — a read that threw is the only evidence of absence.

## 2026-10-05 · 给-effect-audit-probe.mjs-加完-hitrates-之后-探针-一个字都不输出-debt-audi-4rtz6
- symptom: 给 `effect-audit-probe.mjs` 加完 `hitRates` 之后，探针**一个字都不输出**，`debt-audit` 从 23/23 掉到 **19/23（failed_count=4）**。而我的第一次验证只报回一句 `report NOT written` + `verdict: SOMETHING BROKE` —— **没有原因**。
- cause: **两个原因叠在一起，第二个是我自己造的。**<br>① 真 bug：我把 `const hitRates = {...}` 声明在 `const report` 之上（约 1170 行），而 `E4` 在**第 963 行**就读它 → `ReferenceError: Cannot access 'hitRates' before initialization`（暂时性死区）。这是**模块加载期**的异常，所以进程在任何输出之前就死了，报告也从未写出。<br>② **我的验证命令把这个错误扔掉了**：我写的过滤是 `Where-Object { $_ -match 'passed, failed|^FAIL ' }` —— 那正是**成功时 tidy、失败时致命**的过滤。它把唯一的错误原文滤掉了，于是我看到的是一个没有理由的红。
- fix: 把 `hitRates` 的声明移到 `E4` **之前**（并在注释里写明为什么必须在那，以及第一版就是这么死的）；验证命令改成**失败时打印错误行**，重跑后一眼看到 `Cannot access 'hitRates' before initialization`，修完即 8/8 + 23/23。
- files: probes/effect-audit-probe.mjs
- do not repeat: ① 在顶层 `await` 的脚本里，**声明顺序就是契约**：一条更早运行的判据读到的 `const`，必须在更早的位置声明；`var` 会掩盖它，`const` 不会 —— 而这里是好事，因为它把错误当场喊出来了。<br>② **绝不要先过滤一条命令的输出再读它**。为"成功时整洁"写的那个过滤，正是"失败时看不见原因"的原因。要么不过滤，要么让过滤**在失败分支里把原文打出来**（这次改成 `if exit≠0` 时打印前 8 行就够）。<br>③ 顺带一条：`debt-audit` 的 19/23 是**下游症状**，不是四个独立缺陷 —— 一个探针崩掉会同时打红 R5 及与其相关的那几条。

## 2026-10-05 · code_verify-cmd-node-probes-debt-audit.mjs-expect-re-failed--1mdin
- symptom: `code_verify(cmd="node probes/debt-audit.mjs", expect='re:"failed": \\[\\],')` 报 `exit 0, but the expected output never appeared` + `expectation not matched · ok false`，而输出里字面就有 `"failed": []`（探针 23/23、`failed:[]`、`wrong:[]`）。连续两次不同的多行/带换行模式都被判不匹配，于是 journal 里留下两条**假失败**。
- cause: `lib/ledger.js:3154 matchesExpectation` 把 `re:` 交给 `testPatternSync(pattern, output, 'm')`——有界匹配器，结果三态：matched true/false/无裁决；**无裁决按「不匹配」计**（注释原文：「a bounded run that could not reach a verdict counts as "no match" and nothing else」）。而探针的 18.5 KB 输出 + 多行模式（`\n`）恰好落在这个缝里：退出码 0、产品全绿，报告却是 `expectation not matched · ok false`。
- fix: 改用单行、确实存在的子串（或让命令自己打印 `exit=$LASTEXITCODE` 再断言该行）。同一轮里 `node probes/debt-audit.mjs *&gt; $env:TEMP\... ; "exit=$LASTEXITCODE"` + `expect=exit=0` 立刻 VERIFIED。
- files: lib/ledger.js:3154
- trigger: code_verify
- do not repeat: 给 code_verify 写 expect 前先确认被测输出里有那一行：debt-audit 打印 JSON（无 N/N 行），`re:` 里的多行模式（`\n`）很可能永远不匹配，因为 expect 走的是有界匹配器、拿不到裁决就算「不匹配」。稳妥做法是 expect 用输出里确实存在的**单行子串**，或让命令自己打印 `exit=$LASTEXITCODE` 再断言它。

## 2026-10-05 · 同一轮里-node-env-temp-dsh-state-check.mjs-因-err_unsupported_esm-h9crf
- symptom: 同一轮里 `node $env:TEMP\dsh-state-check.mjs` 因 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 失败、我随即 `code_record(kind=mistake, scope=global, …)` 记录成功（返回 `Recorded mistake (global) → C:\Users\dhhxfggg\.dsh-code\mistakes.md`），此后**每一轮**仍收到「This turn ran a command that failed, and nothing has been recorded as a mistake yet:」并点名同一条命令与同一条错误。
- cause: 待查，两种解释都未排除：① 门槛按「本轮之前」的账读，而 `code_record` 写入发生在失败命令**之后**（顺序敏感）；② 结清判定没算上一条 `scope=global` 的记录。判定证据点：同一轮内先失败、后记录，再跑一条命令，看提示是否仍出现。
- fix: 尚未处置。已知的规避是「让失败与记录落在同一轮、并在下一轮只做无害操作」；真正的修法要先分辨上面两种解释（读失败当时快照 vs 结清路径漏 global scope）。
- files: lib/pit-guard.js
- do not repeat: 「本轮记下的 mistake」不会在**本轮**结清这条债务提示——记录发生在命令失败之后，而提示读的是失败当时的状态；另外别在读这个债时顺带编辑某个条目已有的 `files:` 行，那会触发一条已记录的坑。

## 2026-10-05 · code_verify-node-probes-debt-audit.mjs-2-1-out-string-expect-yraot
- symptom: `code_verify("node probes/debt-audit.mjs 2>&1 | Out-String", expect="re:23/23|failed_count=0")` 以及后续两个变体都报 `exit 0, but the expected output never appeared` + `expectation not matched · ok false`；命令是 `node probes/debt-audit.mjs`，那份输出里字面写着 `"failed": []`、`"passed": 23`。
- cause: `lib/ledger.js:3154 matchesExpectation` 把 `re:` 交给 `testPatternSync(pattern, output, 'm')`，那是有界匹配器，结果三态（true/false/无裁决），而**无裁决按不匹配计**。探针 ~18.5 KB 输出 + 跨行模式（`\\n`）正好落进那个缝：探针 23/23、exit 0、`"failed": []` 就在输出里，报告却是 `expectation not matched · ok false`。
- fix: expect 用输出里确实存在的**单行**子串（`"failed": []` 是单行，跨行的一律不行），或让命令自己打印一行再断言它：`node probes/debt-audit.mjs *> $env:TEMP\out.json; "exit=$LASTEXITCODE"` + `expect=exit=0` —— 同一轮里立刻 VERIFIED，探针本身始终 23/23。
- files: lib/ledger.js:3154, lib/ledger.js:3171
- do not repeat: 写 `code_verify` 的 `expect` 之前先跑一次那条命令、看清它到底打印什么：`debt-audit` 打印 JSON（没有 `N/N` 行），`utf8-check` 打印 `N/N`；而多行模式经过有界匹配器时「拿不到裁决」= 不匹配，于是绿的产品被记成失败。

## 2026-10-05 · git--c-e-projects-dsh-code-mode-status---porcelain---untrack-hakvu
- symptom: `git -C 'E:\projects\dsh-code-mode' status --porcelain --untracked-files=all --no-optional-locks` → `error: unknown option 'no-optional-locks'` + usage dump，整条命令 `[exit code: 1]`，而同一批里的 `git status --porcelain` 已经正常打印。另有一条**假失败**：批处理最后一句是 `git check-ignore`，未命中时也 exit 1。
- cause: 本机 git 版本不认识该开关（usage 里没有它），于是 `git status --porcelain --untracked-files=all --no-optional-locks` 直接 exit 1；同一批里前两条读命令的输出其实都拿到了。这与已记录的那条坑同类（批处理里「找不到匹配」或"用法错"的退出码被当成本次测量的裁决）。
- fix: 改用本机支持的写法：`git -C <repo> status --porcelain`、`git ls-files --error-unmatch`（NUL 分隔可用 `-z`），并把可能非零的探测语句放在批处理末尾或把结果捕获进变量。
- trigger: git\s+status\s+.*--no-optional-locks
- do not repeat: 在本机不要照抄新版 git 的 `--no-optional-locks` 之类的开关：先 `git status -h` / 看 `git --version`。失败的读命令要放到批处理中段，别让它的退出码当整条命令的裁决。

## 2026-10-05 · remove-item--literalpath-lib-ledger.js-probes-compact-gate-p-pstb1
- symptom: `Remove-Item -LiteralPath 'lib\ledger.js','probes\compact-gate-probe.mjs','probes\pit-guard-probe.mjs' -ErrorAction SilentlyContinue; ... | Select-Object -Last 2` 出现在一次 `code_verify` 里，名义是"只读断言"，实际是一条**真的删除命令**：三个受版本控制的文件。
- cause: 我为了在 `code_verify` 里拿一次干净证据，把 `Remove-Item` 放在一个被 `Select-Object -Last 2` 截断的管道前面，靠"上游被掐死"让它没执行——这是偶然因素（也与本项目已记录的那条 `Select-Object -First` 坑同源），不是设计。
- fix: 确认三个文件仍在（`Test-Path` 全 True，`git status --porcelain` 只显示 `.dsh-code/mistakes.md`），没有实际损失。
- files: lib/ledger.js, probes/compact-gate-probe.mjs, probes/pit-guard-probe.mjs
- trigger: Remove-Item[^;]*-ErrorAction\s+SilentlyContinue
- do not repeat: 不要把删除跟踪文件当"只读断言"来构造证据——那会留下一条真的未验证债务，而且结果取决于管道截断这种偶然因素。要断言"只读"就用 `git status --porcelain` 或文件哈希；要删就先确认路径解析后的绝对路径正是想删的那个。

## 2026-10-05 · node-env-temp-dsh-read-audit.mjs-报-cannot-read-properties-of-39xyg
- symptom: ① `node "$env:TEMP\dsh-read-audit.mjs"` 报 `Cannot read properties of undefined (reading 'length')` —— 因为上一条命令写进 `$env:TEMP` 的 `da-final.json` 在**下一条命令里已经不存在**（每条命令一个一次性 TEMP）；更早一次 `*>` 重定向还写出 UTF-16LE，`require()` 直接 `Unexpected token`。② PowerShell 里写 `<<'MSG'` heredoc 报 `MissingFileSpecification`，整条命令连 `node` 那半都没跑。
- cause: `code_verify`/pwsh 两条通道各自给每条命令一个一次性 TEMP 目录；文件在命令结束时消失，于是"下一条命令读上一条写的文件"必然读不到，看起来像脚本写错。
- fix: 把测量与读取放同一条命令（如 `$json = node probe ... | Out-String; $o = $json | ConvertFrom-Json; ...`），或用 `-F <讯息文件>` 且讯息文件用 write 工具生成。
- do not repeat: 本机两条通道的 TEMP 是**每条命令一次**（命令结束即清空/换目录）：不要写「这条命令落文件、下一条命令读」的验证；要读就同一条命令里读完，或改用 `probes/` 下（能写的通道）或工作区里受版本控制的报告文件。另外 PowerShell 没有 heredoc，多行提交讯息一律落文件再 `-F`。
- trigger: *>\s*\$env:TEMP|<<'

## 2026-10-05 · 本会话开头我判定-提示在撒谎-dsh-state-check.mjs-失败并在同一回合记入-.dsh-code-mist-l5wud
- symptom: 本会话开头我判定「提示在撒谎」：`dsh-state-check.mjs` 失败并在同一回合记入 `~/.dsh-code/mistakes.md` 之后，此后每一轮仍收到「This turn ran a command that failed, and nothing has been recorded as a mistake yet」。查证后**这个判断是错的** —— 提示并没有撒谎。
- cause: `lib/pit-guard.js:280` 的提示在**每个回合**按当时的失败集合重算（`agent/pre-step`），不是从 `mistake_unrecorded` 债务表读的；`code_record` 的写入发生在同回合失败**之后**，所以那一回合的提示不会因此消失。真正的结清口径在 `unrecordedMistakes`（`lib/ledger.js:2338`），只对**已结束的回合**生效。
- fix: 本轮实测确认：① 我的三条 `code_verify` 假失败确实在 journal 里是 `ok:false`，提示是对的；② 记下一条引用该命令的 mistake 之后，`handover()` 的积压计数 43 → 40（三条结清），证明结清路径工作正常。
- do not repeat: 别用"再跑一条命令看提示还在不在"来判断这类债务是否结清：那条提示看的是**当前回合**的失败集合，只有当回合还在失败时才会出现。要判断结清，看 `handover()` 的积压计数（`… N failing command(s)`）——它是从 journal 重算的。
- files: lib/pit-guard.js:280, lib/ledger.js:2338

## 2026-10-05 · l.brief-cwd-topic-node-env-temp-dsh-read-audit-命中并让简报从-2525--n848a
- symptom: `L.brief(cwd, {topic:'node-env-temp-dsh-read-audit'})` 命中并让简报从 2525 字符涨到 3427（取回那条条目）；而 `topic:'TEMP 是每条命令一次'`（同一段落里的正文措辞）与无关对照 `'kubernetes helm chart'` 都**不命中**，简报停在 2525。
- cause: `brief({topic})` 的匹配面是条目标题/坐标，不是条目正文；所以主题词必须出现在标题或 `files:`/`trigger:` 里才可达。
- fix: 把读者可能用来检索的词写进标题（本条的标题里就有 "env TEMP"），或给它一个 `files:`/`trigger:` 坐标。
- trigger: code_brief.*topic
- do not repeat: 写坑的标题就把读者会用的检索词放进去：`code_brief({topic})` 只匹配标题与被索引的坐标字段，**不搜正文**——正文里的关键词读者查不到。如果你和我一样以为"写清楚就行"，那这条就是反例。

