# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iris is a personal asset management LINE bot built on Google Apps Script (GAS). The architecture is:

**LINE / Telegram Bot API → GAS Web App (doPost) → ChatBot (ReAct loop) → AIServiceFactory → Gemini or NVIDIA NIM API**

Outbound messages go the other way through `MessagingServiceFactory`, which dispatches to `Line.gs` or `Telegram.gs`.

There is a second, read-only face on the same script: a web dashboard served by `doGet()`.
See [Web Dashboard](#web-dashboard).

All persistence is in a single Google Sheet (`Config.SHEET_ID`).

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
4. `Tools.gs` — Defines and executes **12** tools via a `definitions` array plus a `switch` in `execute()`; **both must be edited together**. Asset reads (`getHoldings`, `getDashboard`, `getHistory`, `getDividendHistory`, `getPrice`), one write (`recordDividend`), memory (`rememberShortTerm`, `saveKnowledge`, `searchKnowledge`, `listMemories`, `deleteMemory`), external (`searchWeb`).
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
| `@所有股票紀錄` | Daily snapshots written by `setData()` at 18:00 |
| `@股利` | Dividend ledger — date, code, amount (appended by `recordDividend`) |
| `@固定` | Fixed assets (gold weights), read by `Snapshot._gold()` |

### Daily Snapshot Column Contract

⚠️ **`DataSync.gs` must address columns of `@所有股票紀錄` by header text, never by
arithmetic on the holding count. Do not "simplify" it back.**

The sheet's layout is `日期 | 總價值 | …one column per holding… | 股票總價值 | …one column
per cash account… | 狀態`. The original implementation derived positions from the data:

```js
var numStocks   = stockPrices.flat().length;
var sumStartCol = 2 + numStocks + 1;     // where 股票總價值 is assumed to be
```

The header row is maintained by hand, so this held only as long as the holding count never
changed. **Adding one ETF shifted every value one column right while the header stayed put** —
silently, with no error: the `總價值` SUM range drifted onto the wrong columns, and
`GoogleSheet.getHistory()` (which zips header against values before feeding the LLM) started
mislabelling every historical row. Roughly 950 days of history were one new listing away from
being unreadable.

`DataSync.syncHeader()` now reconciles the header against `所有股票` and `面板` before each
write:

- **Insert only, never delete.** A holding that was sold keeps its historical column.
- New holdings are inserted before `股票總價值`; new cash accounts before `狀態`.
- Insertion uses `insertColumnBefore()` so Sheets rewrites the existing rows' `總價值`
  formula ranges automatically. Writing a new header cell past the end would not.
- Holding columns are keyed by **名稱**, not 代號, because that is what the existing 950 rows
  already use. Renaming an ETF in `所有股票!B` therefore creates a new column rather than
  reusing the old one — rename it in the snapshot header too, or accept the split.
- If `股票總價值` is missing from the header, `syncHeader()` **throws**. That anchor is what
  separates the holding block from the cash block; without it there is no safe way to write.

Two more guards in `DataSync.run()`:

- **Same-date reruns overwrite** that day's row instead of appending, so a manual re-run or a
  retried trigger cannot produce duplicate dates.
- **If every price is invalid** (`#N/A`, `Loading…`, non-positive — GOOGLEFINANCE does fail;
  see `consolelog`), the write is abandoned. A missing day is recoverable; a row of zeroes
  silently corrupts every downstream percentage. When only some prices are bad, those cells
  are left blank and the row is marked `報價異常`.

The `狀態` column records why a row may look flat: `交易日` / `休市` (weekend) /
`資料未更新` (prices identical to the previous row — public holiday, or a failed fetch) /
`報價異常`. There is no TW trading calendar in this project, so the distinction is inferred,
not authoritative. Filter on it before computing volatility or day-change statistics —
19 of the pre-`狀態` rows are weekend copies of the previous day.

**Before adding a holding to `所有股票`, run `verifyRecordSheet()` in the GAS editor.** It
reports which columns would be inserted and where, without writing anything. `dryRunSetData()`
previews the entire row today's run would write.

## 資產管理 Spreadsheet (v2, not yet wired in)

A second, transaction-sourced spreadsheet — `AssetSchema.SHEET_ID` — built by
`AssetSchema.gs` / `Position.gs` / `AssetMigrate.gs`. **Iris still reads the legacy sheet
(`Config.SHEET_ID`); nothing here is live yet.** These three files are additive and are not
called by any trigger.

Why it exists: in the legacy sheet, holdings and cost basis are *state* — hand-typed final
values. Nothing can be derived from them, so there is no annualised return, no realised P&L,
no way to answer "how much did I put in this year". Here everything is a projection of one
`交易` table, which also makes "I sold 3000 shares of 0056 at 49.5, fee 21" a single appended
row rather than a multi-cell edit.

| Layer | Tabs | Who writes |
|---|---|---|
| Input | `標的` `帳戶` `實體資產` `交易` | human / Iris tools |
| Derived | `持倉` `已實現損益` `現金` `配置` `面板` | `Position.rebuild()` — **overwritten wholesale, never hand-edit** |
| History | `每日快照` (long format) | daily job |
| System | `env` `consolelog` `chat` `short_term_memory` `knowledge` `alert_log` | same as legacy |

Entry points, in order: `setupAssetSheet()` → `migrateLegacyData()` → `rebuildPositions()` →
`verifyAssetSheet()`. All are idempotent; migration re-runs replace their own
`來源 = migration` rows instead of stacking.

Six things worth knowing before touching this:

- **The generated tabs are written by position, not by header lookup.** `writeBlock()` fills
  columns by index and the formulas it emits hardcode column letters (`$A`, `$H`, `$I`…), so
  the header row of every tab must match its `TABS` entry cell for cell. `AssetSchema.build()`
  enforces that: a missing *trailing* column is appended, a generated tab whose order is wrong
  has its header row rewritten, and an **input** tab whose order is wrong makes `build()`
  throw rather than shuffle human data. `writeBlock()` re-checks before every write.
  ⚠️ **Adding a column to the middle of a `TABS` headers array is therefore a schema
  migration, not an edit** — the older sheet would otherwise take it at the end and every
  later column would be written one place off, silently. Same failure mode as
  [Daily Snapshot Column Contract](#daily-snapshot-column-contract); the note at the top of
  `AssetSchema.gs` claiming header-text addressing describes reads only.
- **Cost basis is weighted-average**, matching TW broker statements. It is path-dependent —
  the third sale's basis depends on the order of the first two trades — so it cannot be a
  spreadsheet formula. `Position.replay()` walks the trades in date order (input order breaks
  ties within a day) and writes the result. That is also where realised P&L comes from.
- **`期初` is a special action**: it creates a position and cost basis but produces **no cash
  flow**. Account opening balances are already today's real balances; charging the seed
  purchase against them would double-count. For the same reason every migrated row leaves
  `帳戶` blank — the cash tab is a `SUMIF` over `帳戶`, so a blank one touches nothing.
- **Never `appendRow` into `交易`.** Use `AssetSchema.appendTrade()`, which writes the row
  *and* its formula columns. A row without the `現金流` formula silently never reaches any
  account balance. Relatedly, `applyTradeFormulas()` fills only down to the last row that has
  a date — pre-filling thousands of blank rows would push `getLastRow()` past the data and
  break every append.
- **XIRR starts at the migration date, not at first purchase.** There are no original trade
  records, so each holding gets one `期初` row dated the migration day. Migrated historical
  dividends are excluded from the XIRR cash flows — leaving them in would create positive
  flows with no matching investment and blow the number up. Replace the `期初` rows with real
  broker history and the figure becomes real.
  **That date is sticky**: re-running the migration reuses the existing `期初` date instead of
  moving it to today. Moving it forward could place the seed rows *after* trades you have
  already recorded, and `replay()` would drop those sales as "sold with no position". If a
  real trade predates the epoch, `AssetMigrate.run()` refuses outright — pass `{force: true}`
  only when you have decided what happens to those rows.
- **A sale larger than the position is clamped, and the clamp is not silent.** `replay()`
  caps the quantity at what is held, but the trade row's `現金流` formula still credits the
  full typed quantity — so 持倉 would be right while 現金 is wrong. The mismatch is returned
  in `rebuild()`'s `warnings` *and* written as `⚠️ 待修正` rows at the top of `面板`
  (key-value + `VLOOKUP`, so inserting rows there breaks no references). Fix the trade row;
  don't just re-run.

### Four things only the real spreadsheet showed

All four passed 84 mocked assertions and still produced a wrong 面板 on the first real run.
The mock now reproduces the first one, which is why the count is higher today.

- **Ticker columns must be formatted `@` (plain text).** `setValues` with the string `'0056'`
  into an auto-formatted column makes Sheets store the *number* 56. Every
  `GOOGLEFINANCE("TPE:"&代號)` then resolves against a code that does not exist, `IFERROR`
  swallows the `#N/A`, and 市值 is silently 0 for every holding — total assets came out as
  cash-only. `build()` sets the format from each tab's `textColumns`. Only codes containing a
  letter (00687B) survive without it, which makes the damage look partial and random.
  `_replaceByKey` normalises leading zeros when matching, so re-running the migration repairs
  rows already damaged instead of appending duplicates beside them.
- **`CURRENCY:XAUTWD` does not exist.** Google Finance only knows `XAUUSD`; TWD has to be
  multiplied in. The old formula returned `#N/A` for every gold row, so 實體資產 was 0. The
  replacement falls back to the per-gram price captured at migration — a stale price is wrong
  by a percent, a zero is wrong by the whole holding.
- **Sheets refuses to delete every non-frozen row.** `deleteRows` covering the entire data
  range throws 「無法刪除所有非凍結的列」. The first migration never hit it (nothing to
  delete); the second one did, on all 17,118 snapshot rows. `_deleteRows()` clears the range
  instead when the deletion would cover everything.
- **`期初` must sort first within its date.** Re-running the migration deletes and re-appends
  the seed rows, so by input order they land *after* a real trade recorded the same day, and
  `replay()` drops that sale as "sold with no position". `期初` means "the position at the
  start of that day", so it now outranks input order.

`test_asset.cjs` mocks the Apps Script API (including a small formula evaluator) and runs
build → migrate → rebuild → reconcile against the real legacy data, asserting that every
derived total (總資產, 股票市值, 未實現損益, per-account cash) equals what the legacy sheet
already shows. 91 assertions, `node test_asset.cjs`. The last three groups cover the traps
above: header misalignment is refused, an oversold row reaches `面板`, and a re-run does not
move `期初`.

The mock deliberately imitates two Sheets behaviours rather than being convenient: it coerces
numeric-looking strings on write unless the column is formatted `@`, and it evaluates the
formulas the code writes. T7b asserts the coercion itself — a mock that quietly stopped
imitating it would make every guard above vacuous.

⚠️ **Expected values are derived from the fixture at runtime, never written into the test
file** — see [No real figures in git](#no-real-figures-in-git). Hardcoding them would also
decouple the assertions from the data they are supposed to check.

One figure deliberately does **not** match: 累計股利 comes out higher than the legacy sheet's
`總股利`. That was a `SUMIF` against the current holdings table, so dividends from positions
since sold (2412, 2881, 00687B) were never counted. The migration registers those as
`狀態 = 已出清` instruments, so the difference is a correction, not a regression.

### Scheduled Triggers (set via `setupAllTriggers()` in `Main.gs`)
- `04:00` — `dailyCleanUp()`: purge expired STM + chat rows older than 30 days
- `18:00` — `setData()` in `DataSync.gs`: write daily asset snapshot to `@所有股票紀錄`
  (header-reconciling and idempotent per date — see [Daily Snapshot Column Contract](#daily-snapshot-column-contract))

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
- `18:00` — `setData()` in `DataSync.gs`: write daily asset snapshot to `@所有股票紀錄`
  (header-reconciling and idempotent per date — see [Daily Snapshot Column Contract](#daily-snapshot-column-contract))

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
