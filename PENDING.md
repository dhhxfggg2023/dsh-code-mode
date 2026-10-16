# 待做的收尾（2026-10-06 会话留下）

> **本文件标题原为"待重启"，已改：不需要重启。** 两件都只卡在"同一个会话里第二次编辑
> `lib/ledger.js`"，而硬拦计数是**按会话**算的（`lib/pit-guard.js` 的 `account(agent)`），
> 新开会话即归零。上一轮把它写成"必须重启"是错的。

## 当前判据状态（2026-10-06 实测，`node probes/debt-audit.mjs`）

> **状态（2026-10-16）：本文四件已全部落地。** `debt-audit` 现在 **23/23**、`"failed": []`。
> 第一件（会话分桶的真 bug）已按下面的修法修好——但**修法与本文写的不完全一样**：本文建议用
> `[...new Set(...)].sort()` 取最近会话，那是**字典序**，`sess-oldest`/`sess-middle`/`sess-newest`
> 这种 fixture 名字下会选错；实际实现改成按**债务自己的 `ts`** 排序取最新（自包含，不依赖
> journal 顺序也不依赖当前会话 id）。第二件（`guard-probe` 的 `E2`）与第三件（`K10`）见下：
> `E2` 在本会话跑时**已经是绿的**，第三件的 `K10` **从来不是红的**——红的是 `J6`，根因与第一件相同。
> 第四件（`dedupeRoots` 挪进库）仍未做，见文末。本文按原样保留为历史。

`debt-audit` **19/23**，四个子探针各差 1–2 条：

| 探针 | 结果 | 原因 | 性质 |
| --- | --- | --- | --- |
| `journal-rotation-probe.mjs` | 4/5（`J3` 红） | 见下"第一件"的**真 bug** | **真回归** |
| `handover-derive-probe.mjs` | 19/21（`N8`/`N8b` 红） | 同上（这两个是我新加的检查，就是为抓它） | **真回归** |
| `guard-probe.mjs` | 43/45（`E2` ×2 红） | `E2` 断言的是**旧文案** `does not name those commands`，而这轮**故意**把它换成了 `unsettleable, not unpaid` 的说法 | 断言陈旧 |
| `pit-guard-probe.mjs` | 36/36 | **2026-10-16 已定位并修好**：`K10` 从来不是红的那条——红的是 `J6`，而它红的根因在 `lib/ledger.js` 的 `unrecordedMistakes()`（会话分桶用 `sessionOrderBefore()` 推断，当前会话不在 journal 里时把债务在结算之前就判成旧的）。修法见本文 §第一件的修法（同一根因）。`K10` 与 `pit-fire-probe` 的 `B4` 都一直是绿的 |

**所以顺序是：先修下面第一件（真 bug），再更新 `E2`，最后查 `K10`。**

## 第一件（真 bug，必须修）：`unrecordedMistakes` 的会话分桶用错了依据

`lib/ledger.js` 的 `unrecordedMistakes()` **已改了一半**（循环与计数行文案都在），
但"哪个会话算最近"是用 **journal 的会话顺序**推断的，而那是错的：

```js
const beforeThisSession = sessionOrderBefore(cwd, sessionId, scope);
const olderSessions = new Set(beforeThisSession.slice(0, -1));   // ← 错
```

失败方式有两种，都实测过：
① **当前会话不在 journal 里**时（每个探针 fixture 都这样），`sessionOrderBefore` 返回全部
会话、`slice(0,-1)` 切掉的是**另一个**会话，于是没有任何债务被判成"旧" —— 表现是
"两行 + 没有计数行"：`rows.length >= 2` 的截断照旧生效，而**被截掉多少一个字都不说**，
比改动前的行为更糟。
② 即使当前会话在，`writeDebt` 写的 `unverified` 条目也带自己的 session，排序面不是人所想。

**修法（自包含，不依赖 journal 顺序、也不依赖当前会话 id）**：从**债务自身**推导 ——

```js
const debtSessions = [
  ...new Set(
    debts
      .map((debt) => (typeof debt.session === 'string' ? debt.session : undefined))
      .filter((session) => session !== undefined && session !== sessionId),
  ),
].sort();
const recentDebtSession = debtSessions.at(-1);
```

循环里的判据换成：

```js
if (recentDebtSession !== undefined && debt.session !== recentDebtSession) {
  older += (Array.isArray(debt.failures) ? debt.failures : []).length;
  olderSeen.add(typeof debt.session === 'string' ? debt.session : '(unknown session)');
  continue;
}
```

**判据**：`handover-derive-probe` → **21/21**（`N2c` 是"不许把还能行动的那一半也折掉"的控制，
`N8b` 是第二次控制：前一行命令必须在场、旧版那句"去读 journal 逐条补记"的散文必须消失）；
`journal-rotation-probe` → **5/5**（`J3` 走真实 `brief`，修好后债务行回来）。
**`sessionOrderOf` / `sessionOrderBefore` 改完就没人调用了**——删掉，别留着让人以为在被用。

## 第二件（断言陈旧，随第一件一起改）：`guard-probe` 的 `E2` ×2

`E2` 的两条断言要求正文里出现 `does not name those commands`，即**改动前的文案**。
改动后这句被替换成 `unsettleable, not unpaid`（理由是：这些失败**永远结不清**，而旧文案
把它们说成"欠着"）。所以断言要跟着改成新契约，**但这不是放宽判据**——
`E2` 要钉的那件事（无关的 mistake 不得结清这笔债）一字未变，改的只是它期望的句子。
改之前先确认第一件已修好：否则你会把"因为分桶错所以行不见了"错当成"新文案对了"。

## 第三件（待查）：`pit-guard-probe` 的 `K10`

`K10` 在 Electron 通道报 `35/36`，而**这个通道在本会话读不到任何输出**
（`DeepSeek Harness.exe` → stdout/stderr 均 0 字节、`$LASTEXITCODE` 为空，是本仓库记过的坑），
所以 `failed` 名单拿不到，`K10` 到底哪一条断言红了**目前不知道**。

**已知的相反证据**（不要据此宣布 K10 是环境问题）：`pit-fire-probe` 的
`B1`–`B4`（普通 node）覆盖了同一份契约的四种拼写，**全绿**：
`B1` ASCII、`B2` 全角括号、`B3` 中文标签 `安全情形`、`B4` 走 `ledger.recordMistake(safeCase)`
（正是 `K10` 的路径）。所以"读得到 safe case"这件事本身是**实测**成立的；
`K10` 红的原因在这四条之外。

**查法**：在一个能读到 Electron 输出的通道跑
`& '<install>\DeepSeek Harness.exe' --expose-internals probes\pit-guard-probe.mjs`，
看它 stderr 的 `PIT-PROBE-DETAIL` 行；或直接把 `K10` 的 fixture 抄进 `pit-fire-probe`。
**`debt-audit` 现在会在 stderr 打 `DEBT-AUDIT-RED`**（本轮加的），列出红的探针与计数——
但**子探针自己的 stderr 被 `stdio:'ignore'` 丢掉了**，所以 `K10` 的失败原因仍然只能从
`pit-guard-probe` 自己的 `report.json`（`tempReport('pit-guard-report.json')`，落在
`os.tmpdir()`）读，而 `$env:TEMP` 是**每条命令一次**，必须在同一条命令里读。

## 第四件（不阻塞，但别忘）：把 `dedupeRoots` 挪进 `crossProjectTriggers`

见下一节。库侧没搬之前，任何调用那个导出函数的读者都会看到幽灵。

## 为什么本会话做不了（以及为什么新会话就够）

`lib/ledger.js` 在本会话**第二次编辑时被硬拦拒绝**：

```
Error: A recorded pit refused this in E:\projects\dsh-code-mode\lib\ledger.js,
the file you are about to change — the entry declares `hard block: 2`,
and this is hit 3 of this session.
```

拦人的是条目 `2026-10-05 · remove-item--literalpath-lib-ledger.js-probes-compact-gate-p-pstb1`，
它声明了 `hard block: 2` **并且**写了
`files: lib/ledger.js, probes/compact-gate-probe.mjs, probes/pit-guard-probe.mjs`。

**两条边共用一份声明，于是 edit 侧继承了它**：那条规则的正文是关于「把删除跟踪文件当只读断言」
（`trigger: Remove-Item[^;]*-ErrorAction\s+SilentlyContinue`），与编辑无关；但 guard 的 edit 分支
是按 `files:` 过滤的（`lib/pit-guard.js:571`），于是第二次编辑那个文件就被拒。
这不是误报（`files:` 确实写了 `lib/ledger.js`），是**声明形状的后果**：
一条 `hard block` 条目一旦点名 `files:`，那个文件在**当次会话**里就再也不能编辑。
详情见本会话记的 mistake（`edit-on-e-projects-dsh-code-mode-lib-ledger.js-refused-with--mz6o1`）。

**关键更正**：命中计数是**按会话**的（`lib/pit-guard.js` 的 `account(agent)`，键为 `source#heading`），
所以**新开一个会话计数就归零**——不需要重启 DSH，更不需要 kill switch。
上一轮把这件事写成"必须重启"是错的，而那正是本轮两件事被推掉的原因。
（顺带：HANDOVER.md 的铁律 3「改 `lib/` 必须重启」这一轮也被实测推翻了——见该条。）

**目前的处境**：本会话已用掉两次 `lib/ledger.js` 编辑额度（第一次落盘、第二次本身就是修 bug），
第三次起一律被拒。所以剩下的收尾要在**新会话开头**做，或者退一步用
`$env:DSH_CODE_PIT_HARD='0'` + 重启（那条路仍然有效，只是不再必要）。

---

## 一、`handover ## Next` 的取数口径（任务第 2 项，**做了一半，剩一行**）

> **2026-10-06 更新：本条不再需要重启。** 硬拦的命中计数是**按会话**算的（`account(agent)`），
> 新开一个会话计数就归零，所以只要在**新会话开头**改 `lib/ledger.js` 就不会被拒——
> 上一轮把它写成"必须重启"是错的（那条"改 lib 必须重启"的铁律本身也已在 HANDOVER.md 里更正）。
> 但**在同一会话里改两次那个文件**仍会被拒（第二次即 hit 2）。

**设计在** `PLAN-effect-audit.md` 第十三节，处置方向四条，前两条明确否掉（不删 journal 行、
不放宽 `mistakeSettlesFailures`），要做的是第三、四条。第三条即本项。

**现状（2026-10-06 实测）**：`lib/ledger.js` 的 `unrecordedMistakes()` **已改了一半**——
按"本会话之前最近的那个会话"分桶的循环与计数行文案都写进去了，`handover-derive-probe` 的
`N2c`（控制）仍绿；但 `olderSessions` 的**推导方式是错的**，实测 19/21：
`N8`/`N8b` 红，且真实行为是**两行 + 没有计数行**（不是旧行为，是更糟的一种：
`rows.length >= 2` 的截断照旧生效，而"被截掉多少"没有任何一句话说明）。

**根因（已定位，不必再查）**：现在用的是

```js
const beforeThisSession = sessionOrderBefore(cwd, sessionId, scope);
const olderSessions = new Set(beforeThisSession.slice(0, -1));
```

它把"当前会话"当成 `sessionOrderBefore` 里的最后一个会话来推断，于是
① 当**当前会话 id 不在 journal 里**时（每个探针 fixture 都是这样），`sessionOrderBefore`
返回全部会话、`slice(0,-1)` 切掉的是**另一个**会话，没有任何债务被判成"旧"；
② 即使当前会话在 journal 里，`writeDebt` 写的 `unverified` 条目也带 `session: EARLIER`，
排序面不是人所想的那样。

**正确的做法（自包含，不依赖 journal 的会话顺序、也不依赖当前会话 id）**：
从**债务自身**推导顺序 ——

```js
const debtSessions = [
  ...new Set(
    debts
      .map((debt) => (typeof debt.session === 'string' ? debt.session : undefined))
      .filter((session) => session !== undefined && session !== sessionId),
  ),
].sort();
const recentDebtSession = debtSessions.at(-1);
```

然后把循环里那条判据换成

```js
if (recentDebtSession !== undefined && debt.session !== recentDebtSession) {
  older += (Array.isArray(debt.failures) ? debt.failures : []).length;
  olderSeen.add(typeof debt.session === 'string' ? debt.session : '(unknown session)');
  continue;
}
```

即"未结清债务里最新的那个会话保留整行，其余只计数"。这样：一个先前会话的 fixture
（`N2c`）行为不变；三个会话的 fixture（`N8`）里最新那个出整行、另两个折成一行计数。

**判据**：`node probes/handover-derive-probe.mjs` 必须 **21/21**。
`N2c` 是"不许把还能行动的那一半也折掉"的控制，`N8b` 是同方向第二道控制
（前一行的命令必须在场、旧版那句"去读 journal 逐条补记"的散文必须消失）。

**顺带**：`sessionOrderOf` / `sessionOrderBefore` 这两个辅助函数现在**没有调用者**了
（改成从债务推导之后）——要么删掉，要么留给别的读者；**不要留着让下一个人以为它在被使用**。


---

## 二、把 `dedupeRoots` 挪进 `crossProjectTriggers`（任务第 3 项的库侧）

**本会话新发现**（`pit-liveness` 真机实测，见 TODO）：审计说 `crossProjectTriggers` 的晋升条件
"本机按构造不可达"，**这个结论是错的**。同一次运行里它既打印 `UNREACHABLE, not empty`，
又列出 **4 条**"跨项目"候选，而每一条的两个"项目"是
`E:\projects\dsh-code-mode` 与 `E:/projects\dsh-code-mode` ——**同一个目录的两种拼写**。

**根因**：`lib/ledger.js:1242` 的 `byRule.get(key).roots.add(String(entry.root ?? root))`
拿**原始字符串**去 `Set` 里去重；`entry.root` 是写 `trigger_hit` 的那一方逐字记下的，
本项目 journal 里两种拼写都有（pwsh 通道写反斜杠、账本层写正斜杠）。
所以条件**不是不可满足，而是被虚假满足**——比"歧义"更糟：幽灵会变成建议
（"consider recording it with scope=global"）。

**要做的事**：把 `probes/pit-liveness.mjs` 里的 `dedupeRoots()`（本会话已写，折叠分隔符与大小写）
移进 `lib/ledger.js`，在 `crossProjectTriggers` 里**在计数之前**折叠：

```js
byRule.get(key).roots.add(normalised(entry.root ?? root));   // 折叠后再 add
```

**判据**：`node probes/cross-project-reach-probe.mjs` 现在 **5/5**，其中 `R3`/`R4` 钉的是
"原始扫描确实会报幽灵、折叠后一条不剩"。**折叠挪进库之后 `R3` 会变红**（`phantomPromotions` 变 0）——
那时**不是**删掉 `R3`/`R4`，而是按探针末尾那句话重新推导它们：
改成断言"库侧折叠生效，且 `crossProjectReach` 不再出现 `phantomPromotions`"。
探针自己的输出里已经写着这条要求。

**顺带**：本会话给 `pit-liveness` 加了两个开关，都已在真实运行里用过——
`--report <file>`（自己写报告文件，绕开"捕获子进程 stdout"在这台机器上必然失败的路子）
与 `--roots <dir>[,<dir>…]`（把额外目录纳入晋升扫描，好让 R5 那条分支真的跑一次）。

---

## 三、重启后顺手要看的三件事（前一轮交接清单的其余项）

1. `code_brief` 的机器段是否还在、`Set-Content` 类命令是否仍收到坑原文。
2. **safe case 是否真的出现在通知里**。本会话修好了读数侧
   （`lib/pit-guard.js:221` 的 `field('safe case/安全情形')`，接受全角冒号/括号与中文标签），
   并用 `probes/safe-case-live.mjs` 证明账本里 **4/4** 条 safe case 现在读得出来。
   但**运行中的宿主还是旧代码**，所以"通知里出现那一行"仍未在真机看到——
   重启后触发一条带 safe case 的坑（例如 `Select-Object -First`）确认。
3. `probes/pit-guard-probe.mjs`（Electron 通道，36 项）与其余全量判据跑一遍——
   本会话改了 `lib/pit-guard.js`（字段解析 + 拒绝正文归因）与 `lib/ledger.js`（新增两个函数）。
   `handover-derive-probe` 19/19 与 `safe-case-live` 已跑，`pit-guard-probe` **没跑**（需要 Electron 通道）。
