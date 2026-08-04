# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iris is a personal asset management LINE bot built on Google Apps Script (GAS). The architecture is:

**LINE / Telegram Bot API → GAS Web App (doPost) → ChatBot (ReAct loop) → AIServiceFactory → Gemini or NVIDIA NIM API**

Outbound messages go the other way through `MessagingServiceFactory`, which dispatches to `Line.gs` or `Telegram.gs`.

There is a second, read-only face on the same script: a web dashboard served by `doGet()`.
See [Web Dashboard](#web-dashboard).

Asset data lives in the 資產管理 sheet (`AssetSchema.SHEET_ID`); `Config.SHEET_ID` still holds the system tabs (chat, memory, knowledge, alert_log, env) and the frozen legacy tables.

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
2. `ChatBot.gs` — ReAct loop (max `Config.TOOL_MAX_ITERATIONS` = 3 turns). Injects short-term memory + relevant knowledge into system context before each call. Caches tool results within a single turn to prevent duplicate calls.
3. `AIServiceFactory.gs` — Routes to `GeminiService` or `NvidiaService` based on `env!B3`. NVIDIA path goes through `AIAdapter` (Gemini ↔ OpenAI format conversion) so the rest of the codebase always speaks Gemini format.
4. `Tools.gs` — Defines and executes **13** tools via a `definitions` array plus a `switch` in `execute()`; **both must be edited together**. Asset reads (`getHoldings`, `getDashboard`, `getHistory`, `getDividendHistory`, `getPrice`) — formatters over `Snapshot`, reading the 資產管理 sheet — writes (`recordTrade`, `recordDividend`) which go to the **new** 資產管理 sheet via `AssetTools.gs`, memory (`rememberShortTerm`, `saveKnowledge`, `searchKnowledge`, `listMemories`, `deleteMemory`), external (`searchWeb`).
5. `GoogleSheet.gs` — All data access. Single spreadsheet instance cached per execution.

### AI Provider Switching
Switch provider by setting `env!B3` in the Google Sheet to `GEMINI` or `NVIDIA`. Model tiers (`LITE`/`FAST`/`SMART`) are defined in `Config.gs` for both providers. Current NVIDIA model: `deepseek-ai/deepseek-v4-flash` for all tiers (284B MoE, 1M context, native function calling, `temperature 1.0` / `top_p 0.95` per NVIDIA's reference).

**Thinking is controllable on this model, and the tiers use it as the fast/quality dial:**

| Tier | Used by | `enableThinking` |
|---|---|---|
| `FAST` | `ChatBot` ReAct loop — user is waiting | `false` |
| `SMART` | daily/weekly/monthly reports, `AdvisorCheck` — scheduled background | `true` |
| `LITE` | (no caller yet) | `false` |

Control goes out as `chat_template_kwargs: {thinking, reasoning_effort}` from the `deepseek-ai/deepseek-v4` branch in `NvidiaService.gs`. ⚠️ **That field must always be sent for V4 models — omitting it makes NIM hang rather than error.** Reasoning text comes back in `reasoning_content` (separated by `AIAdapter.fromOpenAIResponse`) and consumes the `max_tokens` budget, which is why `SMART` gets a much larger budget than `FAST`.

**Resilience.** deepseek-v4-flash is popular on NIM and overloads often (503 `ResourceExhausted`, 504, and dropped connections). Two layers cover this: `NvidiaService.callAPI` retries 3× with 2s→4s backoff, counting **both** bad status codes and thrown connection exceptions as retryable; if it still returns null, `AIServiceFactory` falls back once to `Config.NVIDIA_FALLBACK_MODEL` (`mistralai/ministral-14b-instruct-2512`, non-thinking, native function calling). When changing the primary model, verify the fallback is still alive too.

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
already return structured JSON for `AdvisorCheck`. The dashboard added only `Snapshot.totalSeries()`
and `Snapshot.dividendSeries()` for the charts. ⚠️ **Keep those two out of `Snapshot.collectAll()`** —
that payload is serialized into the LLM prompt, and a year of daily points would just burn context.

The allocation donut is derived from `holdings` + `cash`, **not** from the `配置` sheet, because that
sheet's columns are read dynamically by header name and have changed before.

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
narrower (total, trend, tappable holdings, cash, preset questions). Colours come from Telegram's
`--tg-theme-*` variables so the panel matches the user's theme; red-up/green-down stays fixed because
it is semantics, not decoration.

Tapping a holding calls `miniAppAsk()`, which builds a `doPost`-shaped synthetic event and runs it
through `ChatBot.reply()` — so tools, memory and chat history all follow the normal path. The answer
is pushed to the chat, not shown in the panel; the front-end closes the panel without awaiting the
callback because the ReAct loop takes far longer than anyone will hold a sheet open.

> `Telegram.WebApp.sendData()` is **not** usable here — it only works for Mini Apps opened from a
> reply-keyboard button, not from inline buttons or the menu button. Hence the `google.script.run`
> round trip.

### Memory System
- **Short-term** (`short_term_memory` sheet): keyed entries with expiry timestamps, injected into every prompt, cleaned by daily trigger
- **Long-term** (`knowledge` sheet): keyword-search only (no vectors), searched against current user message before each prompt

### Google Sheet Tabs
| Tab | Purpose |
|-----|---------|
| `env` | B2: DEBUG_MODE, B3: AI_PROVIDER |
| `consolelog` | Runtime logs written by `Logger.gs` |
| `chat` | Conversation history per userId |
| `short_term_memory` | Temporary context entries with expiry |
| `knowledge` | Persistent user preferences/facts |
| `alert_log` | Proactive-notification history, used by `AdvisorCheck` for dedup |
| `所有股票` | Holdings — row2: 0000 aggregate, row3+: individual ETFs |
| `面板` | Dashboard — B1:B8 summary, C1:D4 net value, E1:F8 cash by account |
| `配置` | Asset allocation — rows 2-21 |
| `@所有股票紀錄` | Legacy wide-format snapshots. Frozen — nothing writes here any more |
| `@股利` | Dividend ledger — date, code, amount (appended by `recordDividend`) |
| `@固定` | Fixed assets (gold weights), read by `Snapshot._gold()` |

(The table above is the **legacy** 股票 sheet. The 資產管理 sheet's own tabs are defined in
`AssetSchema.TABS` — that array is the spec, not a copy of it kept here.)

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

⚠️ The regex grabs the **first** matching date row, and STOCK_DAY_AVG returns the whole month
oldest-first — so the fallback yields an early-in-month close, not today's. Treat it as
"better than a blank" rather than a live quote; verify against an intraday price before
relying on it.

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

(legacy list, kept for reference)
- `04:00` — `dailyCleanUp()`: purge expired STM + chat rows older than 30 days
- `18:00` — `setData()` in `DataSync.gs`: write the daily snapshot into `每日快照`
  (header-reconciling and idempotent per date — see [Daily Snapshot](#daily-snapshot))

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

### Scheduled Triggers (set via `setupAllTriggers()` in `Main.gs`)
- `04:00` — `dailyCleanUp()`: purge expired STM + chat rows older than 30 days
- `18:00` — `setData()` in `DataSync.gs`: write the daily snapshot into `每日快照` (long format, idempotent per date — see [Daily Snapshot](#daily-snapshot))
  (header-reconciling and idempotent per date — see [Daily Snapshot](#daily-snapshot))

## Configuration

All secrets are stored in GAS **Script Properties** (not in code):

| Property Key | Purpose |
|---|---|
| `LINE_API_KEY` | LINE channel access token (optional if using Telegram) |
| `LINE_CHANNEL_SECRET` | LINE webhook signature verification (optional if using Telegram) |
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
