# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 怎麼跟這個專案的擁有者溝通

**一則訊息一個目的。** 開頭就講清楚這是什麼：報告做完的事、提議下一步、還是回答問題。
不要把三種混在同一則裡——讀的人得自己拆解「所以你要我做什麼」，等於把整理工作丟回去。

- 先講結論或要求，不要鋪陳。
- 問是非題就先答是或否，要補充再一兩句。
- 不要主動附上沒被問到的背景、選項比較、風險清單。要的時候會問。
- 表格與分點是為了好略讀，不是為了多塞內容。
- **技術細節寫進 commit message 與這份文件，不要灌進對話。** 為什麼這樣改、踩過什麼坑、
  哪些路徑試過不行——那些是給未來的人看的，寫在這裡才留得住，講在對話裡只是噪音。

## Project Overview

Iris is a personal asset management LINE bot built on Google Apps Script (GAS). The architecture is:

**LINE / Telegram Bot API → GAS Web App (doPost) → ChatBot (ReAct loop) → AIServiceFactory → Gemini or NVIDIA NIM API**

Outbound messages go the other way through `MessagingServiceFactory`, which dispatches to `Line.gs` or `Telegram.gs`.

There is a second, read-only face on the same script: a web dashboard served by `doGet()`.
See [Web Dashboard](#web-dashboard).

**Everything lives in one spreadsheet, named by one value.** The Script Property `SHEET_ID` is the
single source — asset tabs (標的/交易/持倉/…) *and* system tabs (chat, memory, knowledge, alert_log,
env). `AssetSchema.SHEET_ID` is a getter that returns `Config.SHEET_ID`, not a second constant, so
repointing the property moves the whole bot. `AssetSchema.open()` throws a named error if the
property is unset rather than letting `openById(null)` produce GAS's unreadable message.

The old 股票 sheet is frozen; nothing reads or writes it except `AssetMigrate.gs`, which is now
only a test fixture (see [Legacy sheet](#legacy-sheet)). Its id stays hardcoded as
`AssetSchema.LEGACY_SHEET_ID` — it will never change, and it doesn't deserve a property.

Two ways in, both landing on the same property:

- **Asset layer** — `AssetSchema.open()` / `Snapshot._open()`. Guarded, and the one to use for new code.
- **System layer** — `GoogleSheet`, `AlertLog`, `AdvisorCheck._loadDecisions`, `dailyCleanUp`, and
  `Config`'s own `env!B2`/`B3` reads call `SpreadsheetApp.openById(Config.SHEET_ID)` directly. No
  guard, but each already wraps its own try/catch and degrades to an empty result.

⚠️ Never write a spreadsheet id as a literal. That is precisely how the asset layer and the memory
layer ended up with two independent ideas of which sheet they were on — silently, because both
values happened to be correct at the time.

## Development Workflow

This project uses **clasp** to sync local `.gs` files to GAS.

```bash
# Push code to GAS (without deploying)
clasp push

# Push and update the versioned deployment (keeps the LINE webhook URL fixed)
clasp push && clasp deploy -i AKfycbxN-6Yx2GEiLvyBIeZ9z0CyZPbUuBXMyoD6xtN3j_XOc38_S2OBrOonVPaxXM4NVRcI

# View GAS logs
clasp logs

# Open GAS editor in browser
clasp open
```

The **pre-push git hook** (`.git/hooks/pre-push`) automatically runs `clasp push` + `clasp deploy` whenever you push to `main`. Manual clasp commands are only needed outside of git pushes.

### Manual entry points live in `DevTools.gs`

The GAS editor's function dropdown is flat — it does not show which file a function came from.
So **every function whose only purpose is to be run by hand from that dropdown goes in
`DevTools.gs`**: setup, migration, reconciliation, dry runs, diagnostics. They stay thin and
call the modules (`AssetSchema.build()`, `Position.rebuild()`, …); the logic stays where it
belongs.

⚠️ **Two kinds of top-level function must NOT move there**, because they are bound by name and
renaming or relocating them fails silently:

- Trigger handlers — `setData`, `dailyReport`, `weeklyReport`, `monthlyReport`, `marketAlert`,
  `dailyCleanUp`, `advisorCheckEvening`
- Web / `google.script.run` entry points — `doPost`, `doGet`, `dashboardData`, `miniAppData`,
  `miniAppAsk`

## Architecture

### Request Flow
1. `Main.gs` — `doPost()` receives the LINE **or** Telegram webhook, normalizes it into a single LINE-shaped event object, deduplicates via `CacheService` (6h TTL), silently drops non-master events, calls `ChatBot.reply()`
2. `ChatBot.gs` — ReAct loop (max `Config.TOOL_MAX_ITERATIONS` = 5 turns; the cap is not the time guard — each turn checks `Utils.execElapsedMs()` and stops opening new ones past 200s). Injects short-term memory, standing knowledge, the `Facts` block and recent `AdviceLog` entries into the system context. Caches tool results within a turn, strips Markdown before returning, and blocks a 「已記錄」 claim that the ledger does not corroborate.
3. `AIServiceFactory.gs` — Routes to `GeminiService` or `NvidiaService` based on `env!B3`. NVIDIA path goes through `AIAdapter` (Gemini ↔ OpenAI format conversion) so the rest of the codebase always speaks Gemini format.
4. `Tools.gs` — Defines and executes **22** tools via a `definitions` array plus a `switch` in `execute()`; **both must be edited together**. `execute()` returns an envelope, `{ok, status, text}` — `status` is `ok` / `invalid_args` / `error`, and `ChatBot` sends it to the model alongside the text so a failure cannot be read as data (see [工具回傳要分得出成功與失敗](#工具回傳要分得出成功與失敗)). Grouped by which layer they touch:
   - **Computed-layer reads** (`getHoldings`, `getDashboard`, `getHistory`, `getDividendHistory`, `getPrice`) — formatters over `Snapshot`, answering "what do I have now".
   - **Input-layer reads** (`listTrades`, `listAccounts`, `listInstruments`) — the 交易/帳戶/標的 tabs themselves, answering "how did this get recorded, which row do I change". They live in `AssetTools.gs`, not `Snapshot`, because each one is the precondition for a write: `listTrades` hands out the row number `voidTrade` needs, `listAccounts` is the only surface exposing **原幣** balances (`Snapshot._cash` gives TWD-converted only), `listInstruments` names the instruments whose 區域/類型 are still blank.
   - **Ledger writes** (`recordTrade`, `recordDividend`, `setCashBalance`, `voidTrade`) — all four land in the 交易 tab via `AssetTools.gs`; a dividend, a balance correction and a void are each just one row with a different 動作 or 狀態.
   - **Master writes** (`addAccount`, `updateAccount`, `updateInstrument`) — the only code that writes 帳戶 and 標的.
   - **Memory** (`rememberShortTerm`, `saveKnowledge`, `searchKnowledge`, `listMemories`, `deleteMemory`), **feedback** (`logAdvice`, see [回饋閉環](#回饋閉環)), **external** (`searchWeb`).
5. `GoogleSheet.gs` — System tabs (chat / memory / knowledge / log) plus the formatting layer for asset queries, which read through `Snapshot`. Single spreadsheet instance cached per execution.

### AI Provider Switching
Switch provider by setting `env!B3` in the Google Sheet to `GEMINI` or `NVIDIA`. Model tiers (`LITE`/`FAST`/`SMART`) are defined in `Config.gs` for both providers. Current NVIDIA model: `deepseek-ai/deepseek-v4-flash-0731` for all tiers (284B MoE, 1M context, native function calling, `temperature 1.0` / `top_p 0.95` per NVIDIA's reference). ⚠️ The undated `deepseek-ai/deepseek-v4-flash` **reached EOL on 2026-08-07 and returns 410** — see [下架的症狀是「講話變笨」](#下架的症狀是講話變笨).

**Thinking is controllable on this model, and the tiers use it as the fast/quality dial:**

| Tier | Used by | `enableThinking` |
|---|---|---|
| `FAST` | `ChatBot` ReAct loop — user is waiting | `false` |
| `SMART` | daily/weekly/monthly reports, `AdvisorCheck` — scheduled background | `true` |
| `LITE` | (no caller yet) | `false` |

Control goes out as `chat_template_kwargs: {thinking, reasoning_effort}` from the `deepseek-ai/deepseek-v4` branch in `NvidiaService.gs`. ⚠️ **That field must always be sent for V4 models — omitting it makes NIM hang rather than error.** Reasoning text comes back in `reasoning_content` (separated by `AIAdapter.fromOpenAIResponse`) and consumes the `max_tokens` budget, which is why `SMART` gets a much larger budget than `FAST`.

⚠️ **Every model family shapes that switch differently — NIM has no common flag.** `NvidiaService.gs`
branches per family: deepseek uses `chat_template_kwargs.thinking`, glm uses
`chat_template_kwargs.{enable_thinking, clear_thinking}`, gpt-oss uses a **top-level**
`reasoning_effort` (nothing else works for it). Adding a model means adding a branch; miss it and
thinking silently stays on, which mostly shows up as latency rather than an error.

**Resilience.** deepseek-v4-flash-0731 is popular on NIM and overloads often (503 `ResourceExhausted`, 504, 529, and dropped connections). Two layers cover this: `NvidiaService.callAPI` retries 3× with 2s→4s backoff, counting **both** bad status codes and thrown connection exceptions as retryable; if it still returns null, `AIServiceFactory` falls back once to `Config.NVIDIA_FALLBACK_MODEL` (`openai/gpt-oss-20b`, 21B MoE, native function calling, thinking dialled down to `low`).

⚠️ **The fallback never announces its own death.** A delisted fallback is invisible until the
primary also fails, and then both layers are gone at once. Verify it whenever you change the
primary, and whenever a report fails. The `find-nim-model` skill drives that; entry points are
`testNimCandidateModels()` / `testNimModelCapability()` in `DevTools.gs`.

⚠️ **Retrying is gated on remaining time, not remaining attempts.** NIM's gateway gives up near
**300s** and GAS kills the execution at **360s**, so one slow failure can spend the whole budget —
the retry ladder (3 attempts × 2 models) only fits when failures are cheap. The GAS kill is
**uncatchable**: no `catch`, no `finally`, no final log line, just a log that stops mid-way with
none of the failure records you would expect.

So `NvidiaService.callAPI` requires `backoff + as-slow-as-last-time + 45s cleanup` to fit in
`Utils.execTimeLeftMs()` before spending another attempt, and `AIServiceFactory` requires 90s
before starting the fallback. `UrlFetchApp` has no timeout parameter, so the only place to hold
the line is the decision to spend another call.

`Utils.execElapsedMs()` / `execTimeLeftMs()` measure from **file load** — in GAS that is the start
of the execution, since every run reloads all `.gs`. Deliberately not a `startTime` threaded down
from the entry point: the code that needs the clock sits three layers below it.

A scheduled report that returns `null` must not fail silently — "didn't arrive" looks exactly like
"wasn't due" (weekend, holiday). `_handleReportFailure()` in `DailyReport.gs` is the single exit
for all three reports: one retry 15 minutes out, plus a notice saying which situation you are in.

Buying more time means **starting a second execution**; 6 minutes is a hard per-execution cap.
Three things keep that from going wrong:

- **Only one retry.** `dailyReportRetry` raises the `_isReportRetry` global before delegating and
  that path schedules no further retry. A sustained outage would otherwise mint a trigger every 15
  minutes against a **20-trigger-per-user quota**, and once full the real schedule cannot be rebuilt.
- **The flag cannot be a parameter.** GAS passes an event object as the first argument to every
  trigger handler, so `function dailyReport(isRetry)` is always truthy — the 09:00 run would
  classify itself as a retry. A global is safe because GAS reloads every `.gs` per execution.
- **Each retry deletes its own trigger before doing any work.** One-shot triggers do not disappear
  after firing, and deleting at the end would not run in the case being defended against.

Retry entry points live in `Cron.ONESHOT`, not `SCHEDULE` — they have no fixed time. That
registration exists so `Cron.list()` prints a pending retry as `⏳` rather than as a rogue
hand-made trigger. One that never goes away means `_deleteTriggersFor` did not run; delete it by hand.

### Slash Commands

`Commands.gs` intercepts `/`-prefixed messages in `doPost` **before** `ChatBot.reply()`. Telegram's
command menu is only a UI hint — tapping an entry still sends a plain text message — so commands whose
answer is fixed skip the whole ReAct loop and one LLM call.

`Commands.tryHandle(event)` returns `null` for anything that isn't a command, which is what tells
`doPost` to fall through to ChatBot. ⚠️ **Returning an empty string instead of `null` would make
`doPost` treat it as handled and the message would vanish.**

| Command | Behaviour |
|---|---|
| `/dashboard` | On Telegram, sends a message with an inline `web_app` button that opens the Mini App; elsewhere returns `Config.DASHBOARD_URL` (Script Property — the browser dashboard is on the HEAD deployment's `/dev`, whose deployment id differs from the webhook's `/exec`, so it cannot be derived). The handler sends its own message and returns `''` — "handled, nothing left to push" — which is distinct from `null`. |
| `/report` | Runs `buildDailyReport()` — the same generator the 09:00 trigger uses, minus the weekend guard, replying only to the caller |
| `/refresh` | Runs `Position.rebuild()` on demand. 持倉 and 面板 prices are live formulas, but 指標 and 配置 hold values frozen at rebuild time — and the total-assets figure everything downstream reads comes from 指標. The 13:00 job does the same thing on a schedule; this is for when you don't want to wait. |

The command list is shared between dispatch and `Telegram.setupCommands()` (`setMyCommands`) so the
menu cannot drift from what is implemented. **After adding or renaming a command, run
`setupTelegramCommands()` once in the GAS editor.**

Any handler that calls an LLM must send a real interim message first — `/report` runs SMART with
thinking plus a `searchWeb`, far longer than the 5-second typing indicator.

### Web Dashboard

Read-only asset dashboard on the **same** script project, served by `doGet()` in `Main.gs`.

| File | Role |
|---|---|
| `Dashboard.gs` | Payload assembly, 15-min `CacheService` cache, auth gate, `dashboardData()` entry point for `google.script.run` |
| `DashboardPage.html` | Single page — Chart.js 4 via CDN, RWD, light/dark, red-up/green-down (TW convention) |

Data is **reused from `Snapshot.gs`**, not re-read: `_holdings` / `_cash` / `_totals` / `_dividends`
already return structured JSON for `AdvisorCheck`. The dashboard added `Snapshot.totalSeries()`
(charts) and `Snapshot._metrics()` (the 指標 key-value table). ⚠️ **Keep the series readers out of
`Snapshot.collectAll()`** — that payload is serialized into the LLM prompt, and a year of daily points
would just burn context. `_metrics` is small enough not to be a context problem, but it stays out too:
changing `collectAll`'s shape means re-reading `AdvisorCheck` and all three reports at the same time.

`Snapshot.dividendSeries()` is no longer wired to any page — the browser dashboard's two dividend
charts were replaced by 累計股利 + 今年 YoY in the performance row, which `_dividends` already
provides. The function stays (covered by `test_asset.cjs`) for whoever wants those charts back.

**The dashboard is not a page of pretty numbers — three of its blocks exist to be acted on:**

| Block | Source | Why it's there |
|---|---|---|
| 警示條 | `metrics.warnings` + live `priceMissing` + latest `series[].status` | `Position.replay`'s warnings had **no reader on this page**. A dangling 賣出 or a missing quote used to be drawn as a perfectly clean chart. |
| 投資績效 | `metrics` (指標) | 未實現／已實現／累計股利／淨損益／XIRR were computed at every rebuild and displayed nowhere. The page could say how much you have, never how much you made. |
| 目標配置偏離 | `allocation` (配置) | The only block that answers "where does the next dollar go". |

Three things that must stay true there:

- **The 偏離 bars do not use `--up` / `--down`.** Red-up/green-down is the *P&L* convention; over-
  weighting a good holding is not a loss. Deviation gets its own neutral `--over` / `--under` pair.
- **"No target set" is not "target is 0".** `配置` writes an empty string for a group with no target
  (see 目標配置%), so `renderDeviation` filters on **whether the `偏離%` key exists**, not on its value —
  `_allocation` drops empty cells, which is exactly what makes that distinction survive.
- **The deviation chart's denominator is 股票市值; the donut right above it is 總資產.** Two ratios,
  same visual form, different meaning (see 目標配置%). That is why `devHint` has to spell the basis
  out — the numbers alone cannot.

The allocation **donut** is still derived from `holdings` + `cash`, **not** from the `配置` sheet,
because that sheet's columns are read dynamically by header name and have changed before. The
deviation chart does read `配置` — it has to, since targets exist nowhere else.

`totalSeries()` points carry `status` **only when the day was not a normal 交易日**. A year of
`"交易日"` strings would eat the 90KB single-key cache limit for nothing, and the only days that change
how you read a flat line are the abnormal ones.

**Access control.** The webhook deployment is `ANYONE_ANONYMOUS`, so `doGet` is publicly reachable and
must gate itself: `Dashboard.isAuthorized()` compares `Session.getActiveUser()` against
`getEffectiveUser()` — anonymous visitors get an empty string and are rejected. This needs the
`userinfo.email` scope in `appsscript.json`; without it the gate silently fails.
Run `checkDashboardAuth()` in the GAS editor to see what the gate actually sees.

**Open the dashboard at the `/dev` URL**, which forces Google login and always serves HEAD:

```
https://script.google.com/macros/s/AKfycbwIzgwVKM9nhhlE6kVInaIdu4JUjS7pGczmJaF-kHs/dev
```

The `/exec` URL is the anonymous webhook deployment and deliberately returns `Not Found` for GET.

**Two GAS constraints that already cost one failed push each:**
- File names ignore extensions — `Dashboard.gs` and `Dashboard.html` collide. Hence `DashboardPage.html`.
- `addMetaTag()` accepts only `viewport`, `apple-mobile-web-app-capable`, `mobile-web-app-capable`,
  and `google-site-verification`. Anything else (e.g. `theme-color`) throws. Meta tags written inside
  the HTML file are ignored entirely, so `addMetaTag` is the only route.

### Telegram Mini App

A third face: the dashboard rendered inside Telegram's webview, opened by an inline `web_app` button
from `/dashboard`. Served by `doGet(?view=tg)` → `MiniAppPage.html`, backed by `MiniApp.gs`.

It exists on the **`/exec` (anonymous) deployment**, because Google's OAuth does not work inside
Telegram's embedded webview — so the `/dev` login gate is unusable here. Authentication is Telegram's
own `initData` instead:

```
data_check_string = all fields except hash, sorted by key, "k=v" joined by \n
secret_key        = HMAC_SHA256(message = bot_token, key = "WebAppData")
expected_hash     = hex(HMAC_SHA256(message = data_check_string, key = secret_key))
```

⚠️ **The page served by `doGet(?view=tg)` deliberately contains no data.** It is public. Data is only
released by `miniAppData()` / `miniAppAsk()` after `MiniApp.verifyInitData()` passes — which checks
the signature, rejects `auth_date` older than 24h (replay), and then still runs the user id through
`Utils.checkMaster`. A valid signature proves *who* opened it, not that they are allowed in.

`MiniAppPage.html` is intentionally **not** a copy of `DashboardPage.html` — it is phone-first and
narrower (total, 投資績效, trend, tappable holdings, 累計貢獻, cash, preset questions). Colours come
from Telegram's `--tg-theme-*` variables so the panel matches the user's theme; red-up/green-down
stays fixed because it is semantics, not decoration.

Both faces eat the **same** `Dashboard.getPayload()`, so a block that needs no new field costs only
front-end work — that is how 投資績效 (`metrics`) and 累計貢獻 (`holdings`) landed on both. The three
blocks the panel deliberately does **not** carry are the warning banner, 目標配置偏離 and 持倉明細:
the first two are wide diverging charts that stop being readable at 375px, and the table is what the
tappable holdings list replaces. The browser dashboard stays the place to go when something looks wrong.

Tapping a holding calls `miniAppAsk()`, which builds a `doPost`-shaped synthetic event and runs it
through `ChatBot.reply()` — so tools, memory and chat history all follow the normal path. The answer
is pushed to the chat, not shown in the panel; the front-end closes the panel without awaiting the
callback because the ReAct loop takes far longer than anyone will hold a sheet open.

> `Telegram.WebApp.sendData()` is **not** usable here — it only works for Mini Apps opened from a
> reply-keyboard button, not from inline buttons or the menu button. Hence the `google.script.run`
> round trip.

### Shared seams — don't re-copy these

Four things used to exist as near-identical copies scattered across modules. Each copy drifted
slightly from the others, and in every case the drift was unintentional. If you need one of these,
call it — do not paste a local variant.

| Use this | Instead of | Why it matters |
|---|---|---|
| `Prompt.systemContext({scope, period, knowledge, stm})` | hand-rolling `[System Info]` + the date/year rules | The date rules existed in 4 places (`ChatBot` + 3 reports). Miss one and that loop quotes last year's news as today's. |
| `_generateReport(spec)` in `DailyReport.gs` | copying the gather → prompt → SMART → push skeleton | Daily/weekly/monthly differ *only* in what they feed and what they ask. A fourth report is one more spec, not one more function. |
| `AssetSchema.num()` / `.str()` | a local `_num` / `_str` | Seven modules each carried one, differing by a character or two — some caught `Loading...`, some didn't. An uncaught error value becomes `NaN` and `NaN` propagates through every total without raising anything. |
| `MessagingServiceFactory.pushToMasters(msg)` | splitting `ADMIN_STRING` yourself | Five copies of the same three lines. Who gets a notification shouldn't depend on which scheduled job sent it. |

The `AssetSchema.num` / `.str` aliases inside each module are written as
`var _num = (v) => AssetSchema.num(v);`, **not** `var _num = AssetSchema.num;` — GAS gives no
guarantee about file load order, and a direct assignment runs at IIFE time, when `AssetSchema`
may not exist yet.

### Memory System
- **Short-term** (`short_term_memory` sheet): keyed entries with expiry timestamps, injected into every prompt, cleaned by daily trigger
- **Long-term** (`knowledge` sheet): keyword-search only (no vectors), searched against current user message before each prompt

### Google Sheet Tabs

System tabs (this file's other sections cover the asset tabs, which are defined by
`AssetSchema.TABS` — that array is the spec, do not copy it here):

| Tab | Purpose |
|-----|---------|
| `env` | B2: DEBUG_MODE, B3: AI_PROVIDER |
| `consolelog` | Runtime logs written by `Logger.gs`, purged after 10 days |
| `chat` | Conversation history per userId, purged after 30 days |
| `short_term_memory` | Temporary context entries with expiry |
| `knowledge` | Persistent user preferences/facts |
| `alert_log` | Proactive-notification history, used by `AdvisorCheck` for dedup (60 days) |
| `advice_log` | What Iris advised, for follow-up (180 days). Self-creating. |
| `metrics` | Daily rollup of `consolelog`, written by `Metrics`. Self-creating. |
| `eval_set` | Evaluation questions and their latest verdict. Self-creating. |

### Legacy sheet

The legacy 股票 sheet is **entirely frozen** — no code reads or
writes it in production. The 資產管理 sheet's own tabs are defined in `AssetSchema.TABS`; that
array is the spec, not a copy of it kept here.

The one thing still pointing at it is `AssetMigrate.gs`, and only from `test_asset.cjs`:
`AssetMigrate.run()` seeds the whole new sheet from the legacy sheet's real numbers so the suite
can assert *weighted-average replay reproduces what the old sheet already said*. That check can't
be rebuilt from synthetic data, because real figures must never enter a committed test file
(see [No real figures in git](#no-real-figures-in-git)).

⚠️ `AssetMigrate` deliberately has **no `DevTools.gs` entry point**. Running it today would rewrite
the live 期初 rows from a frozen spreadsheet; keeping it out of the GAS function dropdown is what
stops that from happening by accident.

### 持倉的市價

`Position._priceFormula()` builds column H. GOOGLEFINANCE first; when it returns an error
(quota, a freshly listed ETF Google has no data for), TPE rows fall back to parsing TWSE's
`STOCK_DAY_AVG` endpoint. Non-TPE markets get no fallback — that endpoint only knows 上市 codes.

Two things that must stay true when touching this:

- **`stockNo` is `&$A{r}`, a reference to that row's own 代號** — never a literal. A hardcoded
  ticker makes every row fetch the same stock's price and reports no error at all.
- **Both layers end in `,"")`.** Column I decides "did we get a quote?" with `$H=""`. If the
  fallback can surface `#N/A` / `#VALUE!` instead of an empty string, I breaks, then
  `SUM($I$2:$I)`, then 指標's 總資產, then everything downstream of it.

The regex opens with a greedy `.*` to reach the **last** date row: STOCK_DAY_AVG returns the
whole month oldest-first, and RE2 has no lookbehind, so pushing the cursor to the end is the
only way to get the newest close rather than the 1st-of-month one.

**A third layer exists because the first two die together.** On 2026-08-07 five of six holdings
had a blank H, and `=GOOGLEFINANCE("TPE:00878","price")` pasted into an empty cell was `#N/A`
on its own — GOOGLEFINANCE itself was down, and `IMPORTDATA` went with it. Both are
**spreadsheet-side** external functions under one document-level quota, so stacking the fallback
in the same formula is not a fallback at all. `Position._fillMissingPrices()` therefore runs
after the write-and-flush, finds rows with 股數 > 0 and no price, and fetches them through
`StockPrice.getRawPrices` → `UrlFetchApp` → TWSE's MIS endpoint, which is a server-side request
and immune to that quota.

- **What it writes is a dead value, not a formula.** It will not self-correct the way column H
  normally does. That is acceptable only because `rebuild()` rewrites every formula first, so
  the next rebuild gives GOOGLEFINANCE another chance and this layer runs again only if it
  fails again. Blank is worse: `$I` goes to 0 and takes 總資產, every percentage and that day's
  snapshot with it.
- **A successful fallback still raises a warning**, pushed into `replayed.warnings` **before**
  `_writePanelAndAllocation` — that is what puts it in 指標's `⚠️ 待修正` row and on the
  dashboard banner. Push it afterwards and only the chat reply knows.
- **If MIS has no price either, the cell stays blank.** Never invent one; the existing
  "抓不到市價" warning is the correct outcome.
- MIS is `tse_` only, same limit `StockPrice` already had, so non-TPE rows are not sent.

### 目標配置%

只有一個地方填：**`標的` 的 `目標配置%`**。寫得進去的只有兩條路 —— 人手改，或
`AssetTools.updateInstrument()`；遷移與自動登記新標的一律留空。`持倉` 同名那一欄是
`=IFERROR(VLOOKUP($A{r},標的!$A:$H,8,FALSE),0)` —— 指回去，不是重算當下抄過來的
死值，所以改完目標不必等下一次 `Position.rebuild()`，`偏離` 當場就跟著動。

那個欄索引是 `AssetSchema.headerMap(instSheet)` 讀**活的標題列**算出來的，不是寫死的
數字，也不是 `TABS` —— 公式住在試算表裡，就得對得上試算表實際的欄序。寫死的話，在
`目標配置%` 左邊插一欄就會靜默抓到隔壁欄（現在那裡是 `類型`，文字讀成 0），每一檔的
目標都變 0 而且不報錯。同一個坑在 [`AssetSchema.gs`](AssetSchema.gs) 的
`TRADE_FORMULAS` 還在（`名稱` 寫死 `標的!$A:$B,2`），只是第 2 欄幾乎不會被推走。

⚠️ **基準是股票市值，不是總資產。** 目標只填在 `標的`，而那張表裡全部都是股票 ——
現金與實體資產沒有 `目標配置%` 這一欄，也不可能有。所以那些目標加起來的 100% 講的是
**股票這一塊**的 100%。因此 `持倉!偏離` = `佔股票%`（N 欄）− `目標配置%`，`配置` 的
`區域` / `類型` 兩維也用股票市值當分母；只有 `大類`（股票／現金／實體）那三列在講
總資產怎麼切，分母才是總資產。`Position._writePanelAndAllocation` 的 `pushGroup` 收
`base` 參數就是為了這件事，不是漏改。

拿總資產去減目標的話，每一組都會固定低配 `目標×(1−股票佔比)`，全部加起來剛好是
−(現金＋實體佔比) —— 憑空長出來的低配。而這個錯誤**沒有難看的症狀**：每一組偏的方向
都一樣，圖上只是整排藍的「都買太少」，沒有任何一根 bar 會站出來說分母錯了。2026-08-12
發現它的方式不是哪個數字看起來不對，是主人講出「我填的加起來就是以股票為 100%」。
`T5` 現在釘住三個維度各自的分母（各維實際% 相加 = 1），`T20`／`T35` 釘住 `持倉!偏離`
減的是哪一欄。

⚠️ **填比例不是百分比。** `佔股票%`、`佔總資產%`、`配置` 的 `實際%` 都是 0..1 的比例。
填 12.5 而不是 0.125，偏離會差一百倍。`updateInstrument` 因此**擋下所有 > 1 的值而不是
自己 ÷100** —— 12.5 到底是 12.5% 還是有人手滑多打一位，程式分不出來，猜錯不會報錯。

⚠️ 留空讀到 0，而 `配置` 用 `target > 0` 判斷「有沒有設目標」—— 所以某個
區域／類型分組全部留空時，`目標%` / `偏離%` / `偏離金額` 三欄寫成空字串，
「沒設目標」和「目標是 0」在畫面上長得一樣。

### 現金餘額只有兩個入口

`現金` is generated — `Position.rebuild()` overwrites all eight columns, and `餘額` is
`帳戶!期初餘額` + `SUMIF(交易!帳戶, 交易!現金流)`. So a balance can only be moved by
editing `帳戶!期初餘額` (which rewrites the starting point, contradicts `期初日期`, and
leaves no trace) or by adding a row to `交易`. Hand-editing the `現金` cell survives until
the next rebuild — minutes, since every recordTrade / `setData` / daily report / `/refresh`
rebuilds.

That is why "the balance is now X" is not a write but a **translation**:
`AssetTools.setCashBalance()` re-reads the current balance and appends one `動作=調整`,
`分類=校正` row for the difference. `調整` is the only action where `金額` may be negative.

⚠️ **The subtraction must stay inside `AssetTools`.** `Snapshot._cash` hands the model
`台幣值` (TWD-converted), while the delta is computed against `現金!餘額` (原幣) — let the
LLM do the arithmetic and every foreign-currency account is off by one exchange rate,
silently. That is also why `recordTrade` rejects `調整` outright, the same way it rejects
`期初`.

The accounts themselves come from `AssetTools.addAccount()` and `AssetTools.updateAccount()` —
the only code that writes the `帳戶` master. `addAccount` exists because of what the gap did
rather than what it blocked: with no tool for "I opened a new account", the model answered
**"已建立完成"** and called nothing (2026-08-05). A missing write surface doesn't make it
refuse, it makes it lie. Hence the matching rule in `Prompt.gs`: no "已記錄 / 已建立 / 已完成"
before an actual tool result.

### 「已記錄」是自由文字，只有工具名字算數

That prompt rule is not enough on its own, and 2026-08-07 is the proof: asked to correct one
account to an absolute balance, the model asked one confirming question, got 「是的」, and replied
**「好的，已校正。」** with `toolCallCount: 0`. Nothing was written; the owner stopped chasing it
because they had been told it was done. **A false success is worse than a refusal** — a refusal
gets retried.

The claim itself carries no evidence. **The only evidence is the write.** Every place that
actually touches the spreadsheet calls `Utils.noteLedgerWrite()`; `ChatBot.reply` takes
`Utils.ledgerWriteCount()` as a baseline before the loop and compares afterwards.
`Utils.claimsWriteDone()` recognises the claim, and a claim with no write gets **pushed back into
the loop once** with the tools still attached — that turn is where the write finally happens. If
it survives that (or the claim lands on the last turn, which has no tools), the reply goes out
with a banner saying it was not written. Both paths land in `consolelog`.

⚠️ **Do not go back to "did the model call a write tool?"** That is what this used to check, via
a `WRITE_TOOLS` list, and the flag was raised *before* `Tools.execute` ran. So a tool that refused
— an over-sell blocked by `recordTrade`, missing parameters, a thrown exception — left the ledger
untouched while the guard counted it as a write and stood down. Those refusals are exactly the
moments a false 「已記錄」 is most likely and most costly.

⚠️ **`noteLedgerWrite` must never become a blanket hook on spreadsheet writes.** `Logger` appends
to `consolelog` constantly and `ChatBot` writes two `chat` rows per reply, so a global counter is
always true — the guard would be off, and would look fixed. The call sites are deliberately the
handful of real action boundaries (`AssetSchema.appendTrade`, the 標的/帳戶 master writes,
`voidTrade`'s 狀態, and the three memory writers).

Forgetting a call site makes the guard *over*-fire: a successful write gets the banner anyway.
That direction is chosen on purpose — a false banner is visible and gets complained about, a
missing one is invisible.

Three things that make this work rather than merely fire:

- **The push-back is not a rewrite.** Editing the sentence would hide the claim and still leave
  the ledger untouched; the point is to get the tool called.
- **It happens once per reply** (`claimCorrected`). A model that disagrees would otherwise burn
  all three turns arguing.
- **`第 N 列` lines are stripped before matching.** `listTrades` prints 「…（已作廢）」 as data;
  transcribing a query result is not claiming to have done something.

The confirming question is itself the trigger — the gap between "I'll do it" and the next turn is
where the action gets dropped. So `Prompt.gs` also says: parameters complete → call the tool, do
not ask; the tool's return **is** the confirmation, and `voidTrade` undoes a mistake.

Adding a write tool needs **two** edits, not three: `definitions` and the `execute()` switch.
There used to be a third — registering it in `WRITE_TOOLS` — and forgetting it silently disabled
the guard for that tool. Keying off the write itself removed that footgun: a tool that writes is
counted whether or not anyone remembered to declare it.

### 記錯了怎麼撤：作廢，不是刪、也不是反手記一筆

`交易` is append-only, but append-only needs a way to **undo**, not a rule that nothing may
move. `AssetTools.voidTrade(row, reason)` writes a tombstone: the row and its original numbers
stay, `狀態` becomes `作廢`, and every consumer skips it.

> `狀態` is the 17th column of `交易` and was added after the sheet already existed.
> **Run `setupAssetSheet()` once after deploying** — `build()` appends the header (tail-only,
> so no existing column moves) and `applyTradeFormulas()` refills every row's 現金流 with the
> guarded version. `voidTrade` refuses to run while the column is missing rather than writing
> a mark nothing reads.

⚠️ **Do not "just record the opposite trade" instead.** On the cash side that works (現金流 is
one long SUMIF, a negative row cancels out). **On the stock side it is wrong**: a mirror 賣出 is
replayed as a real disposal and books a realised P&L that never happened. The mistake doesn't
disappear, it gains a fake sibling.

Three things that must stay true:

- **The 現金流 cell has to die with the row.** `現金!交易淨流` is
  `SUMIF(交易!$L:$L, 帳戶, 交易!$J:$J)` — a whole-column sum that knows nothing about what JS
  filtered out. So the guard lives **in the formula** (`IF(OR($B="",$Q="作廢"),"",…)`), and
  `voidTrade` rewrites that row's formulas via `AssetSchema.writeRowFormulas` — rows written
  before the 狀態 column existed still carry the unguarded version, and skipping that rewrite
  gives you "row ignored, money still there".
- **`期初` cannot be voided.** It is the migration's cost basis and the XIRR start date; remove
  it and every later 賣出 replays as "當下無持股" and is skipped wholesale.
- **Import dedup still counts it.** Voided rows keep their content key (`imp:` / `stm:`) in the
  dedup set so re-sending the same broker file does not resurrect them, but they no longer count
  toward the *quantity already recorded*. Voiding is deliberate; silent resurrection would not be.

⚠️ **Voiding one leg of a transfer is the one case nothing can catch for you.** 轉出/轉入 are two
rows with no field binding them (deliberately — see `TRADE_FORMULAS`), and unlike a dangling 賣出,
a transfer never touches 持倉, so `Position.replay` has nothing to warn about. Total assets simply
moves. `voidTrade` therefore prints an explicit warning naming the amount whenever the voided row
is 轉出/轉入; the pairing itself is still the human's job.

### 賣不掉你沒有的股票

`recordTrade` refuses a 賣出 outright when the ledger doesn't hold that many shares **on that
date** — nothing is written. The problem it prevents is two ledgers disagreeing about one row:
`Position.replay` knows you hold nothing and skips the sale (shares untouched, no realised P&L),
but 現金流 is that row's **own spreadsheet formula** — it reads only the shares and price written
on the line and cannot see 持倉. Let the row in and the stock never moves while the money lands.

The check replays the trades up to that date and asks `Position.replay` itself rather than
counting shares locally: weighted average is path-dependent, and a second implementation of that
rule would eventually drift from the real one. Date matters because a back-dated sale must be
judged against what was held **that day**, not today.

⚠️ **The gate is on `recordTrade` only.** Broker imports are not blocked — a statement saying you
sold means you sold; what's missing there is the buy (see AssetImport's "only the sell side"
note), and refusing would keep real fills out of the book. So a dangling 賣出 can still arrive by
import, by hand-editing the sheet, or by voiding a 買進 that has a later sale. Those are caught
after the fact, not before: `replay` skips the sale and pushes a warning that surfaces in the
`voidTrade` / `rebuild` reply and as a `⚠️ 待修正` row in 指標 — but the sale's 現金流 still lands.
The money stays wrong until that sale is voided too; the difference is that you are told.
`T9` in `test_asset.cjs` covers exactly this path, which is why it appends via
`AssetSchema.appendTrade` instead of `recordTrade`.

**Every reader of 交易 must go through `AssetSchema.readTrades(ss)`**, which filters voids by
default and attaches `__row` (the real sheet row — `readObjects` skips blanks, so index+2 is not
a row number). Miss one reader and that void comes back to life in exactly one number:
`Position` (持倉/現金/XIRR), `Snapshot._dividends` / `dividendSeries`,
`GoogleSheet.getDividendHistory`, both `AssetImport` dedup loops (those pass
`{includeVoid: true}` on purpose), `AssetMigrate`.

### 主檔改得動，帳本改不動

`標的` / `帳戶` are **reference data referenced by string from immutable data**, so the rule
inverts: the ledger forbids updates and offers voiding; the masters have no "record another one"
escape, which makes **update the only correction path** — and delete the dangerous one.

- `交易!名稱` and `持倉!目標配置%` are VLOOKUPs into the masters. Adding a corrected row does
  not retire the wrong one.
- **Renaming an account is a two-table transaction.** `現金!交易淨流` matches by account *name*;
  change the master cell alone and that account's balance silently falls back to 期初 with no
  error. `updateAccount({newName})` rewrites every matching row in `交易` (voided ones included —
  they are historical records). `每日快照` keeps the old name: that is what was true that day.
- **No delete for accounts, only `狀態=停用` — and only at zero balance.** `Position` filters
  停用 accounts out of `現金` entirely, so disabling a funded account makes that money vanish
  from 總資產 without a word.
- **Currency cannot change once the account has trades.** Those rows' amounts were recorded in
  the old currency; the balance would become two currencies added together and multiplied by the
  new FX rate.
- **代號 cannot be changed at all** — it is the join key shared by 交易 / 持倉 / 每日快照.

⚠️ `recordTrade` 的自動登記只生得出**半個標的**：買進沒見過的代號時會補一列 `標的`，但
`區域` / `類型` / `目標配置%` 全留空，而 `配置` 正是按 `區域` 與 `類型` 分組的。也就是說
那個 C **保證**後面需要一次 `updateInstrument`；`listInstruments` 會直接點名缺哪一欄。

### 評估：判定與執行是兩件事

`Eval.gs` splits into a half that needs an LLM and a half that does not, and only the second half
is where the value lives.

**`Eval.CHECKS` are pure functions** — `(reply, ctx) => {ok, why}`. No LLM, no sheet reads, so
`T37` tests them directly: Markdown, yes/no-first, as-of present, no write claim on a read-only
question, length, whether every figure in the reply can be found in that turn's context, and
whether standing rules get cited. `Eval.judge` runs a named set and reports which ones failed.

**`Eval.runBatch(limit)` is the half that costs money and time.** Default 3 questions per run,
oldest-first, writing results back after each. GAS gives 6 minutes and one question can run a
whole ReAct loop, so it is designed to be run repeatedly until every row has a fresh timestamp
rather than to finish in one go. It also stops early if `Utils.execTimeLeftMs()` drops under 90s —
better to do two questions than to be killed mid-question having written nothing.

Two things that would quietly ruin the results:

- **Each question uses its own `userId`, and it carries a per-run stamp** (`EVAL:<id>:<ms>`).
  Per-question alone is not enough, and the second baseline run proved it: `EVAL:Q04` re-read
  its own answer from the previous run's chat history and quoted 300,000 shares without calling
  `getHoldings` again. That is exactly the behaviour the system prompt forbids and the eval is
  supposed to catch — and the eval had built the conditions for it.
- **`platform` is not `TELEGRAM`.** It would otherwise fire the typing indicator at the owner;
  an eval is background work and should not appear in his chat.

⚠️ **Expectations are properties, not answers.** 「應該回答 142萬」 is stale tomorrow and grades
the wrong thing. The set asks whether the reply *carries an as-of*, whether *every figure has a
source*, whether a yes/no question *got a yes or no first*.

⚠️ **The first baseline run graded the checkers, not the model.** 2026-08-09: 3 pass / 7 fail, and
four of those failures were the checker's fault — `yesNoFirst` rejected 「先講結論：不算太高」
(the answer is right there, behind a label), `citesStanding` missed 「您的長期配置原則」 and
「你原本就有預留」 because it only knew three phrasings, and `numbersGrounded` flagged figures the
model had correctly transcribed from tool output, because `_ask` built its context from `Facts` +
knowledge and never captured what the tools returned.

**A checker that fails correct behaviour is worse than one that misses bad behaviour.** A miss
costs you one undetected problem; a false failure sends someone off to "fix" something that was
already right. `T37` now pins each of those four cases.

`_ask` wraps `Tools.execute` for the duration of a question to collect outputs into the context —
in `Eval`, not in `ChatBot`, because the production path should not carry a parameter it only
needs when being graded. The wrapper is restored in a `finally`; leaving it installed would put an
extra layer on every later reply in that execution.

⚠️ `numbersGrounded` is the valuable check and the one most likely to misfire, so its allowances
are deliberate: 「142萬」 counts as grounded for 1,420,000 because the persona *requires* that
form, and anything under 10,000 is skipped — years, percentages, share counts and row numbers all
live there and are nearly always transcription rather than invention. What it is really hunting is
a fabricated figure at money scale.

### 知識檢索：中文切得開，規矩不靠碰運氣

`searchKnowledge` used to tokenise with `query.split(/\s+/)`. Chinese has no spaces, so
「我現在可以加碼嗎」 was **one token** and only matched if those exact seven characters appeared
in an entry. For the project's primary language, keyword search was effectively inert — and it
failed by returning 「沒有找到」, which is indistinguishable from an empty knowledge base.

`_tokens` now emits CJK bigrams plus whole latin/numeric runs (so 代號 and ETF still work), and
scoring weights a tag hit at 3 against a body hit at 1 — tags are the topic someone chose by hand.
Bigrams do over-match; sorting and a top-5 cap absorb that.撈多一點再排序 beats 撈不到.

**Injection and the tool are now different functions, on purpose.** `ChatBot` calls
`knowledgeForPrompt`, which always includes every `[決策]` / `[目標]` / `[偏好]` entry (capped at
10) and then adds up to 3 keyword matches. `searchKnowledge` stays purely query-driven for the
model to call.

The reason is that the persona instructs Iris to compare against 「主人設過的 [目標]」 — and that
rule can only hold if the 目標 is actually in the prompt. Leave it to keyword luck and asking
「現金太多了嗎」 against a goal worded 「年底前現金比例降到 20%」 silently disables the rule.
Standing rules are few; carrying all of them every turn is the cheap half of the trade.

⚠️ **Synonyms remain out of reach and that is accepted.** 「加碼」 and a stored 「加倉」 share no
characters, so no amount of segmenting connects them. A synonym table was considered and rejected:
it goes stale unnoticed. The case that matters — standing rules — is covered by always injecting
them, which does not depend on wording at all. `T36` pins both the limitation and the fallback.

### 每日指標：consolelog 在被丟掉之前先算一次

`Metrics.rollupDaily(days)` folds `consolelog` into one row per day in a `metrics` tab: replies,
average and max turns, average and max seconds, timeouts, tool calls, most-used tool, fallback
takeovers, **false-claim interceptions**, ledger writes, errors. `DevTools.rollupMetrics()` runs
it by hand over 7 days.

⚠️ **It runs first in `dailyCleanUp`, before the `consolelog` purge.** Reversing that order means
throwing the data away and then trying to count it. There is currently a lot of slack (10-day
retention, 3-day rollup) but the ordering is the invariant, not the slack.

Each run recomputes the last 3 days and **overwrites** rows for those dates, so a missed schedule
backfills itself and a manual run never doubles a row.

⚠️ **Do not re-parse the timestamp into a `Date`.** `GoogleSheet.setLog` already wrote it as a
GMT+8 string; parsing it back with the execution's timezone and re-formatting to GMT+8 shifts the
whole day when the two conversions don't cancel — and the symptom is "yesterday has no data",
with no error. `_dayOf` takes the first ten characters instead. It still accepts a real `Date`,
because Sheets sometimes coerces that column.

This exists partly to make the `TOOL_MAX_ITERATIONS` 3 → 5 change checkable: `avgTurns` /
`maxTurns` / `timeouts` are exactly the numbers that say whether it helped or cost anything.

### 人設寫的是行為，排版放最後

`Prompt.SYSTEM_PROMPT` used to spend about 40% of its length on formatting — no Markdown, use
▸ ◆ 【】, a worked example of both — and about three lines on how to actually behave as an
advisor. The formatting rules are still there, but they now sit at the **end**, and the top of
the prompt is `[怎麼回答]`: lead with the conclusion, answer yes/no questions with yes or no
first, separate 事實 (quote it) from 判斷 (say what it rests on), say so when uncertain and name
the as-of, compare against any `[目標]` the owner set, and — when the owner is anxious about a
loss — acknowledge it once and then return to the numbers and *their own stated principles*,
without generic reassurance or an excuse to recommend action.

Those rules are the owner's own stated preferences (see the top of this file) applied to Iris.
That is deliberate: the same person is on both ends.

⚠️ **The prompt must not use Markdown itself.** It told the model 「嚴禁 Markdown」 while using
`**bold**` fifteen times. Models mirror the formatting they are shown, and `Utils.stripMarkdown`
exists precisely because the model emits `**` anyway — so the instruction was competing with the
demonstration. `T33` pins `**` out of both prompts, and the 排版 section now *describes* the
forbidden syntax instead of demonstrating it.

`T33` also pins the ordering (behaviour before tools, formatting last) and the prompt's total
length, since it ships with every single message.

⚠️ **提示詞勸不動它，所以改用剭的。** Three baseline runs in a row had 3 of 10 replies
carrying `**bold**` despite the ban, so `ChatBot.reply` now runs `Utils.stripMarkdown` before
returning. Previously only `Telegram.pushMsg` stripped it, which meant the owner saw clean text
while the chat history, the eval, and any future consumer saw the asterisks — two versions of the
same reply. Stripping here makes all of them agree, and fixes LINE as a side effect
(`Line.pushMsg` never stripped at all).

Keep the strip in `Telegram.pushMsg`: reports, market alerts and `AdvisorCheck` pushes do not go
through `ChatBot`. The cost, stated plainly: the eval can no longer see whether the model obeys
the no-Markdown rule. That signal was traded for one consistent version of the text.

### 回饋閉環

`alert_log` records what was pushed, for dedup. Nothing reads it back, so Iris never knew what it
had advised — which is the line between an advisor and a query interface. `advice_log` +
`AdviceLog.gs` close that: `AdvisorCheck` writes a row after every push, the `logAdvice` tool
lets the model register advice it gives in chat, and `ChatBot` injects the last five into every
prompt.

**「後來如何」 is computed at read time, not backfilled.** The roadmap called for a scheduled job
to fill in outcomes; this stores the total assets *at the time of the advice* and compares against
the current figure whenever the block is built. Three reasons, and the second is the real one:

- One less trigger, against a 20-trigger quota.
- A backfilled cell is stale the next day. 「後來如何」 is inherently a question about *now*;
  freezing it into a cell means committing to keep updating it.
- A failed backfill leaves that row blank forever and nobody notices. Computing on read has no
  such state.

The cost is that callers must supply the current total — they already have it.

⚠️ **主題 must be a text-formatted column.** Topics are usually ticker symbols, and Sheets turns
`00878` into `878` on write. Nothing errors; the topic simply never matches again, so advice on
one instrument stops linking up. Same trap as `AssetSchema`'s `textColumns`. `T32` pins it.

⚠️ `AdviceLog` creates its own tab when missing, unlike `AlertLog`, which logs a warning and gives
up. `AlertLog`'s tab is hand-made and predates it; a *new* module that quietly does nothing would
be indistinguishable from a working one. That is also why `advice_log` is **not** in `setup()`'s
`requiredSheets` — it would report a missing sheet until the first advice is recorded.

Retention is 180 days versus `alert_log`'s 60, because the span is the point: 「你三個月前說要
降現金比例」 is the whole reason the table exists.

### 工具回傳要分得出成功與失敗

`Tools.execute()` returns `{ok, status, text}`, not a bare string. It used to return a string for
everything, so 「查到了」, 「參數不齊」 and 「工具壞了」 were the same type — and the model could
take 「讀取持倉時發生錯誤：xxx」 and summarise it as content, in the same confident tone it uses
for real data.

`ChatBot` puts `status` and `ok` into the `functionResponse` alongside the text (`AIAdapter`
serializes the whole response object to JSON, so the model sees them), and appends an explicit
instruction on failure: this is why it failed, not data, don't paraphrase it as a result. The
same check guards the timeout path that hands the raw tool output straight to the user.

Two distinctions that must not blur:

- **A business rule saying no is `ok: true`.** An over-sell blocked by `recordTrade` means the
  tool ran correctly and the answer is 「不行」. Classifying it as a failure would make the model
  apologise for a malfunction instead of relaying the reason.
- **「成功但查無資料」 is deliberately not a status.** That判斷 lives inside the Chinese sentences
  the underlying functions return (「（尚無持倉資料）」), and recognising it here would mean
  string-matching — the exact thing this envelope exists to remove. Adding it properly means
  changing the underlying functions, not bolting a guessed field onto the envelope.

⚠️ `execute()` is the only place that wraps. `_dispatch()` still returns plain strings for the
success path; anything that is already an envelope (the `invalid_args` guards, the unknown-tool
default) passes through untouched. So adding a tool needs no envelope work unless it has its own
argument guards.

### 數字先算好給它，不要指望它算對

`Facts.build()` puts the headline figures — 總資產, day/week/month change, cash, 未實現/已實現/
累計股利/淨損益, XIRR, 殖利率, 佔比, plus any `⚠️ 待修正` warning — straight into every
`ChatBot` prompt, with an instruction to quote them verbatim. Two reasons, and the second is the
one that usually gets forgotten:

- **An LLM doing arithmetic in prose fails silently.** It will total two figures, divide P&L by
  cost, convert a currency at a rate it assumed — in the same confident tone it uses when right.
- **It saves a whole ReAct turn.** 「我總資產多少」 used to cost a tool call, a round trip and a
  second generation. The number is now already in the prompt.

⚠️ **Only figures that need no external call belong here.** `Facts` reads 指標 / 現金 / 每日快照
— three sheet reads. Per-holding data is deliberately absent because `Snapshot._holdings` calls
TWSE, and this block is built for *every* message, including 「謝謝」. `T30` enforces this by
spying on `StockPrice`, not by pattern-matching the text — the 待修正 warnings legitimately name
instrument codes, so text matching would forbid the wrong thing.

⚠️ **百分比要把分母寫在旁邊。** Two ratios with different denominators, printed next to each
other, are indistinguishable to the reader — and to the model. On 2026-08-09 it set the
portfolio-wide 2.56% 現值殖利率 beside the owner's rule about 息型 ETF dropping under 3.5%,
and compared them. It also reported 009826 as 32.22% (of stock value) in a reply that elsewhere
discussed 佔總資產. Both numbers were correct; only the labels were missing. `Facts` now says
「全部持股合計」 and 「佔總資產」, and `getHoldings` says 「佔股票市值」 instead of a bare
「佔比」. Naming the denominator beats asking the model to be careful.

⚠️ **`Facts.build()` must never throw.** It returns `''` on any failure. It is an enhancement to
a reply; letting it take the whole reply down would be a strictly worse trade.

⚠️ **The system prompt's 「一律重新呼叫工具」 rule had to be amended, not just extended.** As
written it would have made the model ignore a correct number sitting in front of it in order to
obey. The ban was always about quoting *stale numbers from conversation history*; the rule now
names the two acceptable sources (this block, and tool returns) and says which questions each
answers.

### 下架的症狀是「講話變笨」

2026-08-07 `deepseek-ai/deepseek-v4-flash` hit EOL and started returning `410 Gone`. Nothing
broke. The fallback took over on every single request, exactly as designed — and that is why it
went unnoticed for two days. What the owner eventually reported was not an error but a *reply that
read wrong*: an incoherent line comparing 29% against 38%, the conclusion at the bottom instead of
the top, arithmetic that did not hold up.

Those are symptoms of a 21B fallback model doing work meant for a 284B one. **The failure
presented as a quality problem, not an availability problem**, so the instinct was to go and look
at the prompt.

- **First check `consolelog` for `410` / `404` before touching `Prompt.gs`.** A model change
  explains a behaviour change far more often than a prompt change does.
- **`Metrics.rollupDaily` counts `fallback` per day.** A non-zero number there every day means the
  primary is gone, not merely busy. That column is the alarm this incident needed and did not have.

The replacement is the same model under a dated id, `-0731`. `NvidiaService` matches on the
`deepseek-ai/deepseek-v4` prefix, so it needed no new branch — but that was verified, not assumed.

⚠️ **A dated id can EOL too.** The undated one was supposed to be the stable alias and it was the
one that died. Nothing here is permanent; the `find-nim-model` skill exists because this recurs.

### 拿不到就說拿不到，不要生一個 0 出來

`StockPrice.getRawPrices` returns `changePct: null`, never `0`, when there is no trade price
for today (`isClosed` — MIS's `z` field is empty or `-`: outside trading hours, a holiday, or a
holding with no volume). It used to return `0`, and that was a fabricated number: `current` falls
back to yesterday's close, so the calculation is `(y - y) / y`. **That is not "flat today", it is
a meaningless expression that happens to look exactly like one.**

The cost was concrete: every evening Iris told the owner each holding was precisely flat, and had
no way to know it was making that up — the one field that distinguishes the two cases,
`isClosed`, was computed at the bottom and dropped before reaching the model.

The same data already had one consumer doing it right: `MarketAlert` has always guarded with
`if (p.isClosed || !p.yesterday) return;`. The bug was that the other two consumers didn't.

Three layers have to agree, and each is easy to break alone:

- **Source** — `getRawPrices` returns `null`. `getPrice` (the tool) prints 「非交易時段，取不到
  當日成交價」 instead of 「漲跌：0.00　幅度：0.00%」 next to a 「收盤價」 that was actually
  yesterday's close, the same number under two different labels.
- **Middle** — ⚠️ `Snapshot._holdings` must not write `live ? _round(live.changePct, 4) : null`.
  `_round(null)` is `Math.round(null * 10000) / 10000`, which is **0** — "unknown" quietly
  becomes "flat" and the null at the source is wasted. Check the value, not the object.
- **Output** — `GoogleSheet.getHoldings` says 「今日: 取不到當日成交價…，不是平盤」 rather than
  omitting the field silently. `DashboardPage` already rendered `null` as `—`, so it needed nothing.

`T28` pins all three, including the case that must keep reporting `0`: a real quote that genuinely
equals yesterday's close **is** flat, and must not be swept into `null` along with the rest.

The general rule this is an instance of: **a model cannot be honest about something it cannot
distinguish.** Prompt instructions don't fix that — the fix is to not hand it a number to be
wrong with. Compare [「已記錄」是自由文字](#已記錄是自由文字只有工具名字算數), which is the
same lesson from the write side.

⚠️ Known limitation, deliberately not papered over: `Snapshot.isQuiet`'s "any holding moved ≥3%"
condition is inert at its only call site (`advisorCheckEvening`, 19:00), because there is no
day-change data after the close. It was equally inert before — the zeros failed the same
threshold — so this changed nothing except making the reason visible. Fixing it means changing
the schedule or the data source, not treating `null` as `0`.

### 面板 vs 指標

Two tabs, one number set, on purpose:

| Tab | Written by | Shape | Read by |
|---|---|---|---|
| `指標` | `Position._writePanelAndAllocation()` | 指標 / 數值 / 說明, values frozen at rebuild time | `Snapshot._totals`, `DataSync`, `GoogleSheet.getDashboard`, `持倉!R` VLOOKUP |
| `面板` | `Panel.render()` | free-form, **every cell a formula** | humans |

They were one tab and it did not work: 面板 had to keep a strict three-column contract
(`writeBlock` → `assertHeader` refuses to write when column 1 isn't 指標) *and* be laid out
for a person to read. Splitting them means the visual layout can move freely while every
machine reader keeps a stable key-value table.

`面板` stores nothing — it's `=持倉!$I3`, `=SUM(現金!$H$2:$H)` and so on, so it tracks
GOOGLEFINANCE live instead of freezing at the last rebuild. `Panel.render()` only decides
*how many rows to draw*: it lists holdings with 股數 > 0 and mirrors them row-for-row from
`持倉`. That is why `Position.rebuild()` calls it last — sell out a position and the layout
has to shrink. `renderPanel()` in `DevTools.gs` redraws it without recomputing anything.

⚠️ `面板` is `freeform: true` in `AssetSchema.TABS`: no header contract, and `build()` skips
the freeze/bold it applies to every other tab (row 1 there is data, not a header).

⚠️ A new 指標 row has **three** readers to update, not one: `Snapshot._metrics` (which maps
sheet keys to JSON keys by hand) and the 投資績效 block in **both** `DashboardPage.html` and
`MiniAppPage.html`. Writing the row alone changes nothing anyone can see.

### 期初不是買進，是開帳餘額

`XIRR（年化）` read blank for weeks with the note 「現金流時間跨度不足」, and both of those
were wrong. There were 35 flows across 4 days with both signs — plenty of span. The real
problem was the anchor: `期初` rows were fed to XIRR as **purchases at cost**, so a whole
portfolio's lifetime gain got compressed into the few days since the migration date. The true
root sits at r ≈ 2×10¹⁵; `p.xirr` searches `[-0.9999, 10]`, finds no sign change, returns null.

`期初` is an **opening balance**, so the opening flow is the **market value on the anchor date**,
read from `每日快照` (`Position._openingValue`). The lifetime gain then sits inside the opening
balance where it belongs, and XIRR measures return since Iris started keeping complete books.

Three things that must stay true:

- **The opening snapshot is the last one strictly _before_ the anchor date.** Snapshots are
  written at 18:00 and already contain that day's trades; anchoring on the anchor date itself
  double-counts every trade made that day — once inside the opening value, once as a flow.
  Everything dated `<= opening.date` is therefore skipped when building flows.
- **No snapshot, no XIRR.** Falling back to cost is exactly the bug above. The note says so.
- **Under `Position.XIRR_MIN_DAYS` (90) the value stays blank**, because annualizing a short
  window is meaningless — 5 days at +0.7% annualizes to +107%. The note carries the
  *un-annualized* period return instead, which is true from day one.

⚠️ The three reasons XIRR can be blank (no snapshot / no root / span too short) are distinct,
and the note naming which one is written by `Position` and carried through `_metrics().xirrNote`
to both pages. Both pages used to hard-code 「現金流跨度不足」, which was wrong in two cases out
of three. Don't re-introduce a front-end guess.

### 現值殖利率 vs 成本殖利率

Same numerator — the trailing 12 months of dividends actually received — over two denominators:
現在市值 and 投入成本. Their ratio is identically `市值 ÷ 成本` (= 1 + 未實現報酬率), asserted in
`T25`, so 成本殖利率 carries no information the panel doesn't already show. It is displayed
because the owner asked for it; 現值殖利率 is the one with a decision attached (opportunity cost
against what else that money could buy).

Two rules the numerator must keep:

- **Only instruments currently held count.** Cleared positions (2412, 00687B) paid real money in
  the last year, but they are not in the denominator; counting them inflates the yield, and
  inflates it in the flattering direction.
- **Migrated dividends _do_ count**, unlike in XIRR. They carry real dates going back to 2023 and
  are the only reason these two metrics work without backfilling anything. XIRR excludes
  pre-anchor flows because the opening balance already contains them; a yield is asking a
  different question — what these assets pay per year — so the exclusion doesn't apply.

Stored at 6 decimal places, not 4: a yield is a 0.0x quantity, and 4 dp leaves two significant
figures and breaks the ratio identity above.

### Daily Snapshot

`setData()` writes one day of state into `每日快照` at 18:00 — a **long table**:

```
日期 | 類型 | 鍵 | 名稱 | 數量 | 單價 | 市值 | 幣別 | 狀態
```

One row per item: 合計/總資產, 合計/股票市值, one 持股 row per held position, one
現金 row per account, one 實體 row for gold. About 15–20 rows a day.

**This shape is why the old column contract is gone.** The legacy `@所有股票紀錄` gave
each holding its own column, so adding one ETF shifted every value one column right while
the hand-maintained header stayed put — silently, and `getHistory()` then mislabelled ~950
rows. An entire reconciliation mechanism (`syncHeader`, insert-never-delete, anchor column)
existed to contain that. In a long table, adding or selling a holding changes the number of
rows, never the columns, so none of it is needed. The retired implementation is in git
history if the reasoning is ever needed again.

What survived, because it was never about columns:

- **Same-date reruns overwrite.** The day's rows are deleted and rewritten, so a manual run
  or a retried trigger cannot produce two copies. `_removeDate` clears instead of deleting
  when the range would cover every non-frozen row (Sheets refuses that).
- **If every holding is missing a price, nothing is written.** A missing day is recoverable;
  a day of zeroes silently corrupts every downstream percentage. When only some are missing,
  those cells are left blank and the day is marked `報價異常`.
- **`狀態`** records why a day may look flat: `交易日` / `休市` (weekend) / `資料未更新`
  (every price identical to the previous snapshot — public holiday, or a failed fetch) /
  `報價異常`. There is no TW trading calendar here, so this is inferred, not authoritative.
  Filter on it before computing volatility or day-change statistics.

`verifySnapshot()` and `dryRunSetData()` in `DevTools.gs` report what today would write
without writing it.

### Scheduled Triggers

`Cron.gs` holds `SCHEDULE` — one declarative table of what runs when and why. `Cron.setup()`
rebuilds every trigger from it and `Cron.list()` diffs it against what GAS actually has, so a
hand-made trigger or a missing one shows up instead of failing quietly. **Handlers stay in
their own modules**; the table only registers names.

⚠️ `atHour(9)` fires somewhere between 9:00 and 10:00, so **never use trigger order to
guarantee freshness**. `setData()` and `buildDailyReport()` each call `Position.rebuild()`
themselves, because 指標 and 配置 hold values computed at rebuild time — 持倉 and 面板 prices
are live formulas, but the total assets figure Snapshot reads is only as fresh as the last rebuild.
`/refresh` does the same on demand.

Don't restate the schedule here. `Cron.SCHEDULE` is the source of truth and `Cron.list()` diffs it
against what GAS actually has; a copy in this file can only ever drift out of date, which is
exactly what happened to the two hand-maintained lists that used to sit here.

`Cron.ONESHOT` is the second, smaller registry: handlers that are bound by name like any other
trigger but have **no fixed time**, because they're created on demand and delete themselves. Today
that's the three report retries (see [Resilience](#ai-provider-switching)). They're registered so
`Cron.list()` can tell "waiting to fire" apart from "someone made this by hand" — a name that GAS
binds by string still fails silently when renamed, whether or not it's on a schedule.

## Broker CSV import

Send a broker CSV to the bot as a Telegram document and it lands in `交易`. Two formats are
recognised by their header:

- **證券對帳單** (has 委託書號) — both sides. Buy or sell is decided by the **sign of 淨收付**:
  money in is a sale, money out is a purchase. That is the one column a statement cannot get
  wrong. This is the format to prefer.
- **已實現損益** (has 賣出日期) — sells only, for the reason below.

**Duplicate detection has to work across the two formats**, because the same sale appears in
both with different granularity — four matched lots in the realised report, two fills in the
statement — so a content hash never matches. Both importers therefore check *quantity already
recorded* for the same (date, code, action) and skip what is already covered, in addition to
their own row key (`stm:date:order:shares`, `imp:date:code:shares:net`). The two directions
are symmetric; a test sends the same sale in both formats and asserts nothing is written twice.

Broker statements use short names (富邦台50) where 標的 uses the full one (富邦台灣50).
`NAME_FIXES` in `AssetImport.gs` maps the known variants — deliberately an explicit list rather
than fuzzy matching, because guessing wrong files a trade against the wrong instrument. An
unmatched name is reported and skipped, never guessed. `doPost` routes `message.type === 'document'` straight to `AssetImport.fromUpload()` —
no ChatBot, no LLM. The file is already structured; handing it to a model only adds a place
for it to go wrong.

- **Only the sell side is imported.** Every row of a realised-P&L report is a matched pair, so
  importing both sides looks right and is wrong: the buy cost is already inside the `期初` row
  that migration seeded from the legacy sheet's total cost. Buys arrive through `recordTrade`
  instead. The rule is simply *buys come from elsewhere; this reads sells*.
- **Realised P&L will not match the broker, by design.** They match lot by lot; this sheet uses
  weighted average. The broker's own figure for each row is written into 備註 so it stays
  recoverable.
- **Unit price is derived**, `(賣出價金 + 手續費 + 交易稅) ÷ 股數`, not the 賣出單價 column.
  That column is rounded, and a few dollars of drift per row compounds into an account balance
  that never reconciles. The displayed price also goes into 備註.
- **Re-sending the same file is safe.** Each row gets a content key
  (`imp:date:code:shares:net`) stored in 備註; rows whose key already exists are skipped and
  counted. That is what makes importing on receipt acceptable without a confirmation step.
- Add `預覽` to the message caption to parse and summarise without writing.
- Instruments are matched by 名稱 against the `標的` tab — the report has no ticker column. An
  unknown name is reported and skipped, never guessed.

`Telegram.fetchFileText()` does the two-step download (`getFile` → `/file/bot<token>/<path>`)
and falls back from UTF-8 to Big5 when the Chinese headers do not decode. ⚠️ That download URL
contains the bot token; never log it.

## No real figures in git

**The owner's actual asset figures must never reach GitHub.** Pushing them to Apps Script is
fine — that is the owner's own project and where the data lives anyway. The repo is the line.

- Test fixtures pulled from the real spreadsheets live in `*.data`, which `.gitignore`
  excludes. `legacy_fixture.data` and `datasync_fixture.data` are regenerated by dumping the
  sheets, not by hand.
- Test files **are** committed, so they must contain no balances, share counts, costs or
  totals. Derive every expected value from the fixture at runtime (`EXP`, `HOLD`, `H0` in
  `test_asset.cjs`; `REC_HDR`, `HOLDINGS`, `CASH` in `test_datasync.cjs`). Synthetic numbers
  invented by a test are fine.
- The same applies to docs. Describe *what* is reconciled, not the amounts.
- Tickers, account names and sheet layout are not covered by this — they do not disclose
  how much anything is worth.

## Configuration

All secrets are stored in GAS **Script Properties** (not in code):

| Property Key | Purpose |
|---|---|
| `LINE_API_KEY` | LINE channel access token (optional if using Telegram) |
| `TELEGRAM_API_KEY` | Telegram bot token from @BotFather (optional if using LINE) |
| `SHEET_ID` | Google Sheet ID |
| `ADMIN_STRING` | Master user LINE userId |
| `GEMINI_API_KEY` | Gemini API key (optional if using NVIDIA) |
| `NVIDIA_API_KEY` | NVIDIA NIM API key (optional if using Gemini) |

## First-Time Setup

1. Run `setup()` in GAS to verify all sheets exist and properties are set
2. Run `setupAllTriggers()` once to register the 04:00 / 18:00 triggers
3. Point the platform at the fixed deployment URL ending in `/exec`:
   - **Telegram** — run `setupTelegramWebhook()` in the GAS editor (registers the webhook via the Bot API)
   - **LINE** — paste the `/exec` URL into the LINE Developers console

`ADMIN_STRING` holds the allowlist of master userIds, comma-separated. Telegram IDs are stored with a
`TELEGRAM:` prefix (e.g. `TELEGRAM:123456789`); LINE IDs are stored bare. That prefix is also how
`MessagingServiceFactory.push()` decides which platform to send a proactive message on, so per-user
history and scheduled pushes keep working with both platforms registered at once.
