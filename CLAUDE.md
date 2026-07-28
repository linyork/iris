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
| `/dashboard` | Returns `Config.DASHBOARD_URL` (Script Property — the dashboard is on the HEAD deployment's `/dev`, whose deployment id differs from the webhook's `/exec`, so it cannot be derived) |
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
| `所有股票` | Holdings — row2: 0000 aggregate, row3+: individual ETFs |
| `面板` | Dashboard — B1:B8 summary, C1:D4 net value, E1:F8 cash by account |
| `配置` | Asset allocation — rows 2-21 |
| `@所有股票紀錄` | Daily snapshots written by `setData()` at 18:00 |

### Scheduled Triggers (set via `setupAllTriggers()` in `Main.gs`)
- `04:00` — `dailyCleanUp()`: purge expired STM + chat rows older than 30 days
- `18:00` — `setData()` in `DataSync.gs`: write daily asset snapshot to `@所有股票紀錄`

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
