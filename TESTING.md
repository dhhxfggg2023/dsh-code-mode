# 怎么测这个模式

两类测试：**自动判据**（不用你动手，跑命令看结果）和**人工走查**（需要你在 GUI 里开新会话）。

---

## 一、自动判据（一条命令一类，全绿才算正常）

`<install>` = DSH 安装目录，`<node>` = 安装目录里自带的 node（`resources\runtime\primary-runtime\dependencies\node\bin\node.exe`）。
路径不用手填：`probes/paths.mjs` 会自己发现安装目录（也可以用 `DSH_ASAR` / `DSH_EXE` 覆盖）。

```powershell
$P = '<pkg>\probes'     # 本机是 E:\projects\dsh-code-mode\probes

# 只需要普通 node 的
& '<node>' "$P\build-preset.mjs" --check     # 组合没漂移（严格超集）     期望 PASS
& '<node>' "$P\guard-probe.mjs"              # 账本守卫                 期望 passed 45/45（见下）
& '<node>' "$P\debt-audit.mjs"               # 文档断言 vs 代码事实       期望 passed 23/23
& '<node>' "$P\check-yaml.mjs"               # 打印 preset 行与子行
& '<node>' "$P\check-prompt-section.mjs"     # 提示段真的进了请求         期望 PASS
& '<node>' "$P\gate-chance.mjs"              # 闸门到底有没有机会响（读真实会话日志，报告）
& '<node>' "$P\session-evidence.mjs"         # 会话取证：帧类型/token/窗口/压缩/闸门痕迹（报告）
& '<node>' "$P\brief-shape.mjs"              # 真实账本下简报花了多少：完整条目 / 索引行 / 发现提示（报告）
& '<node>' "$P\index-diag.mjs"               # 不同 maxChars 下索引行数（报告）
& '<node>' "$P\ledger-census.mjs"            # 两个账本的条数/字符/索引成本（报告）
& '<node>' "$P\pit-liveness.mjs"             # 坑的存活：trigger 能否编译+自证命中、files: 是否还在（判红）
& '<node>' "$P\handover-grant-probe.mjs"     # 转接文档的 margin 与提醒再武装      期望 12/12
& '<node>' "$P\journal-rotation-probe.mjs"   # journal 轮转：不丢行、最高槽被占也要继续转  期望 5/5
& '<node>' "$P\write-rule-probe.mjs"         # 写入侧告警 + 命中记账 + 重启追踪        期望 12/12
& '<node>' "$P\brief-full-probe.mjs"         # code_brief({full:true}) 让更多条目可达 期望 4/4
& '<node>' "$P\promotion-probe.mjs"          # 跨项目晋升：两项目才算候选          期望 6/6
& '<node>' "$P\pattern-budget-probe.mjs"     # 坑的正则必须有界（判据必须让边界真的响）  期望 17/17
& '<node>' "$P\repeat-identity-probe.mjs"    # 坑的身份：真重复仍合并、不同坑不再合并      期望 17/17
& '<node>' "$P\syntax-check.mjs"             # lib/ 与探针的 ESM 解析（补 node --check 的假证据）期望 14/14
& '<node>' "$P\utf8-check.mjs"               # 本轮改动文件的严格 UTF-8              期望 18/18
& '<node>' "$P\handover-derive-probe.mjs"    # 转接派生：只从账本派生、有界、只读        期望 19/19
& '<node>' "$P\effect-audit-probe.mjs"      # 效果审计：机制到底有没有产生过价值          期望 8/8

# 需要 Electron 二进制（从 asar 加载宿主解析）
$env:ELECTRON_RUN_AS_NODE='1'
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\acceptance-probe.mjs"     # 期望 24/24
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\compact-gate-probe.mjs"    # 期望 35/35
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\budget-probe.mjs"         # 期望 29/29
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\budget-chain-probe.mjs"   # 期望 16/16
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\gate-probe.mjs"           # 期望 39/39
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\gate-journal-probe.mjs"   # 期望 7/7
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\pit-guard-probe.mjs"      # 期望 34/34
# pit-report 不需要 Electron：node probes/pit-report.mjs --selftest   # 期望 12/12
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\aegis-activation-probe.mjs" # 期望 5/5
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

两个跑法坑（都踩过）：捕获输出要用 `2>&1 | Out-String`（`*>` 会静默丢输出）；`$env:X='1'` 会留在 `pwsh` 工具进程里影响后续调用，跨步骤跑时同一行里 `Remove-Item Env:X` 清掉。

**机器捕获（`code_verify` / 不看屏幕的地方）用 `DSH_PROBE_REPORT` 指定报告落点**，别去 match stdout：探针本来就把判定写文件，而 stdout 在有些通道里根本收不到（2026-10-04 实测：同一条 `acceptance-probe.mjs`，`code_verify` 收到空输出、记成 `exit 0, but the expected output never appeared` 的假失败；`pwsh` 里加 `2>&1 | Out-String` 则拿到完整的 `{"passed":24,"total":24,"failed":[]}`）。报告路径要**写成绝对路径**，因为 `$env:TEMP` 是每条命令一次性的随机子目录（命令结束即清空），探针默认写在那里就等于没人能读：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$env:DSH_PROBE_REPORT='<工作区>\.acceptance-report.json'     # 绝对路径；工作区根目录受限通道可写
& '<install>\DeepSeek Harness.exe' --expose-internals "$P\acceptance-probe.mjs"
Get-Content -LiteralPath $env:DSH_PROBE_REPORT -Raw | ConvertFrom-Json   # 再读 passed/total/failed
Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:DSH_PROBE_REPORT
```

**别把「没输出」读成「二进制起不动」**：受限通道里这个 exe 是**能**启动的（2026-10-04 实测 `-e` 一行脚本：exit 0、写文件成功、`console.log` 不可见），它只是不把子进程 stdout 转给调用方。判据落在**产物**（报告文件）上，不要落在输出或退出码上。

**第三类结果：`skipped`（不是红也不是绿）**。`guard-probe` 的 H1/H2 要**起子进程**，有些通道连这一步都不允许（`EPERM: spawn`）——那时它报 `passed 43/45` + `skipped: [H1, H2]` 并把原因写到 stderr，**退出码仍是 0**。文档里的 `45/45` 指的是这类检查**跑得起来**的通道（`pwsh` 工具那条就够）。**2026-10-03 起 H1/H2 不再依赖管道**：子进程把结果写成 `writer.json`（`stdio: 'ignore'`），父进程读文件——照 `debt-audit` 读 `guard-report.json` 的既有模式，所以连 `code_verify` 那条更严的通道也能真正跑这个竞态。判据侧同样按这个规矩：`debt-audit` 的 R5–R8 认 `passed + skipped == 文档里的数字`。**别把 skipped 当通过**：它明确说明这次没测并发写。

**改了 `lib/*.js` 之后**：自动判据仍然是可信的（它们从磁盘读代码），但**GUI 里的会话要重启 DSH 才会用上新代码**——子插件模块只在 preset 挂载时 import 一次。

---

## 二、人工走查（三个场景）

### 场景 1：冷启动（1 分钟，最重要）

1. GUI 里**新开一个会话**，模式选「编程模式」，工作区选一个**真的代码项目**（不要选 DSH 安装目录）。
2. 只发一句：「看一下这个项目现在什么状态」。

**期望**：它**第一件事就调 `code_brief`**，而不是先 `ls`/`glob` 到处翻。新项目没账本时，它应回：

```
# Ledger brief — <工作区>
No ledger yet at .dsh-code\project.json.
Record the basics before exploring: code_record(kind="project", ...)
```

**失败**：它开始自己探索目录、或直接问你项目结构 → 说明提示段没进请求，把那一轮的原文给维护者。

### 场景 2：记忆与隔离（10 分钟）

在**同一个新会话**里接着：

1. 「这个项目怎么跑起来？」
2. 等它查完，说：「**记下来**：测试命令是 X，技术栈是 Y」→ 期望它调 `code_record`，回显 `Recorded project → <工作区>\.dsh-code\project.json`
3. 关掉会话，**再开一个新会话**（同一工作区），问：「这个项目上次我们决定过什么？」

**期望**：新会话能说出第 2 步记下的内容 —— 这就是"换了会话还记得"。

**判据**：账本在**那个工作区**的 `.dsh-code\` 里；`E:\tools\DSH\.dsh-code\` 不该出现；简报里不该出现别的工作区的内容。
**失败**：账本写到了 DSH 安装目录，或简报串了别的工作区 → 工作目录解析出错，属严重问题，立刻反馈。

### 场景 3：门禁真的会记账（两个会话，约 5 分钟）

1. **会话 A**（编程模式，任一代码项目）：「把 `<某个 .js/.mjs 文件>` 加一行注释，只用 edit 改，**不要运行任何命令**，改完就停。」
2. 它改完停下 → 期望会话里出现一句门禁提醒（大意：改了文件但没跑命令）。
3. 关掉 A，**开新会话 B**（同工作区）问：「看一下这个项目什么状态」。

**期望**：B 的简报里出现：

```
## Turns that changed code and ran nothing
Earlier sessions edited them and never ran a command, so nothing here is proven yet:
- <日期> ...: edit <那个文件>
```

**结清**：在 B 里让它**用 `code_verify`**（不是普通 `pwsh`）跑一次验证那个文件相关的命令，再要一次简报 —— 那段债应消失。**注意**：跑一条普通命令**不会**结清（那正是 2026-10-02 修掉的毛病），它会让债多一句「ran with no recorded evidence」；跑一条**跟那个文件无关**的 `code_verify` 也不会结清，债会缩成一句「另有 1 笔更早的未验证回合，最近一次验证没点到它们」。

**两个坑**：必须改**代码后缀**的文件（`.md`/`.rst` 默认豁免、不记账）；不要用 `.txt`（它**算代码**，会记账）。

---

### 场景 5：看门禁在真实会话里到底做了什么决定（调试用，约 3 分钟）

`DSH_CODE_GATE_JOURNAL` 是**启动前**读的环境变量，会话里再设对当前进程无效。

1. 正常关掉正在跑的 DSH（GUI 与下面的命令只能活一个）。
2. 在一个 `pwsh` 窗口里：

```powershell
$env:DSH_CODE_GATE_JOURNAL = "$env:TEMP\gate-journal.jsonl"
Remove-Item $env:DSH_CODE_GATE_JOURNAL -ErrorAction SilentlyContinue
& 'E:\tools\DSH\DeepSeek Harness.exe'
```

3. 在 GUI 里开一个「编程模式」新会话，做**两轮**就够看全：
   - 第 1 轮：改一个代码后缀文件，**一个命令都不跑**，结束这一轮 → 期望出现 `edit` → `notice`(`unproven-completion`) → `notice-delivered` → `turn-stopping`(`state: none`, `debt: true`)。
   - 第 2 轮：再改一次，用 `code_verify` 跑一条并把 `expect` 填对 → 期望 `run` 里 `proof: true`、`turn-stopping` 是 `state: proved` 且 `debt: false`。
4. 读它（另开一个窗口也行）：

```powershell
Get-Content "$env:TEMP\gate-journal.jsonl" | ForEach-Object { $e = $_ | ConvertFrom-Json; "{0} {1} {2}" -f $e.event, $e.kind, $e.state }
```

**边界**：这个文件是**追加**的、跨项目混在一起，所以只适合临时开着排查；用完把它删掉、并把那个窗口关掉（否则以后从那个窗口启动会一直记）。开关关掉时一个字都不写，路径写不进去也只是静默吞掉，不会弄坏回合。

**判据**：`probes/gate-journal-probe.mjs`（Electron 通道，7/7）。

---

### 场景 4：机器事实与命令侧坑门禁（两个会话 + 一条命令，约 5 分钟）

前置：**重启过 DSH**（`lib/*.js` 的改动只在挂载时加载）。

1. **会话 A**（编程模式，任意项目）：「把这条记成机器级事实：Windows PowerShell 5.1 会把管道里的 `byte[]` 写成十进制数字串；写文件一律走 Node 或 edit/write 工具，绝不用 PowerShell 回写内容；触发词 `Set-Content|Out-File|Add-Content`。」
   期望：它调 `code_record({kind:'mistake', scope:'global', trigger:'Set-Content|Out-File|Add-Content', …})`，回显 `Recorded mistake (global) → C:\Users\<你>\.dsh-code\mistakes.md`。
2. 同会话里让它**跑一条含 `Set-Content` 的命令**（例如 `'x' | Set-Content $env:TEMP\a.txt`）。
   期望：命令跑之前收到一条 notice，里面有那条 `do not repeat` 的原文，并注明出处是 `~/.dsh-code/mistakes.md`（不是项目里的 `.dsh-code/mistakes.md`）。
3. 关掉 A，**换一个完全不同的项目**开新会话 B，只问：「这个项目现在什么状态」。
   期望：B 的简报里有 `## Machine-wide facts (true of this host, every project)` 段，含 `Ledger: C:\Users\<你>\.dsh-code`、上面那条坑的标题与其 trigger。**这就是这一层存在的理由**：换项目不重付。

**边界（别误判成坏）**：机器账本只在这台机器上共享，换机器就没了（设计如此）；`trigger:` 写错 = 那条不响而且不报错，靠一次真实命中来确认；项目连 `.dsh-code/` 都没有时，简报同样带这一段（此时 `empty: true`）。

---

## 三、出问题时给维护者这三样

1. 你发的**原话**（哪一句触发）；
2. 它的**工具调用**那一行（工具名 + 参数，例如 `code_brief({topic:"..."})`）；
3. 它给你的**原文回复**。

有这三样就能判断是提示段没生效、工具返回值不对、还是工作目录解析错了。

---

## 四、已知的"看起来像坏、其实是正常"

- 新工作区第一次 `code_brief` 回 `No ledger yet` —— 正常，新项目还没账本。
- 简报里出现 `… (N earlier ledger entries dropped for length)` —— 正常，是它**主动说明**省略了什么。
- 改了 `lib/*.js` 后 GUI 行为没变 —— 需要重启 DSH（模块只在挂载时 import 一次）。
- `code_verify` 写工作区被拒、写 `$env:TEMP` 成功 —— 宿主两条通道权限不同，不是模式坏了（会写文件的探针因此都写临时目录）。
