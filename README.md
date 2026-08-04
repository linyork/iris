# Iris — 個人資產管理 LINE / Telegram Bot

> ⚠️ **專案性質聲明 — 請先讀**
>
> 本專案目前的實作（ReAct 迴圈、工具分派、AI Provider 切換、記憶系統、主動感知層等）**全部以原生 JavaScript 手刻在 Google Apps Script 上**，目的只是為了**快速驗證概念與演示**（GAS 部署成本為 0、內建排程、Sheet 直接當資料庫，最適合 PoC）。
>
> 整套架構在設計上對應的就是 **LangChain / LangGraph** 的標準元件：
>
> | 目前手刻 | 對應的 LangChain / LangGraph 概念 |
> |---|---|
> | `ChatBot.gs` 的 ReAct 迴圈 | `LangGraph` StateGraph + ToolNode |
> | `Tools.gs` 的 13 個工具 | `@tool` decorator / `StructuredTool` |
> | `AIServiceFactory` + `AIAdapter` | `BaseChatModel` 抽象 + provider 子類 |
> | `HistoryManager` + STM 注入 | `Memory` / `Checkpointer` |
> | `searchKnowledge` 關鍵字查 Sheet | `VectorStore` retriever |
> | `AdvisorCheck` 排程感知層 | LangGraph 子圖 + Conditional Edge |
>
> 由於每個模組職責切得很乾淨（Provider、Tools、Memory、Retrieval、Graph orchestration 各自獨立），要搬到 **LangChain / LangGraph (Python or TS)** 基本上就是把現有元件一對一換成框架對應的抽象，再接上正式的向量資料庫與可觀測性（LangSmith）即可，不需要重新設計。

---

Iris 是一個建構在 **Google Apps Script (GAS)** 上的私人資產管理助理，透過 **LINE 或 Telegram** 與使用者互動。
所有資料以單一 Google Sheet 為唯一資料庫，AI 推論支援 **Gemini** 與 **NVIDIA NIM (DeepSeek-V4-Flash)** 雙引擎熱切換，
具備 ReAct 工具呼叫、長短期記憶、每日財經早報、盤中異動警報、由 LLM 主導判斷的主動顧問感知層，
以及一個唯讀的網頁資產儀表板。

---

## 目錄

- [系統定位](#系統定位)
- [架構總覽](#架構總覽)
- [模組結構](#模組結構)
- [Google Sheet 資料表](#google-sheet-資料表)
- [AI 工具集](#ai-工具集)
- [斜線指令](#斜線指令)
- [網頁儀表板](#網頁儀表板)
- [Telegram Mini App](#telegram-mini-app)
- [排程任務](#排程任務)
- [記憶與決策系統](#記憶與決策系統)
- [環境設定](#環境設定)
- [部署與開發流程](#部署與開發流程)
- [首次安裝](#首次安裝)

---

## 系統定位

Iris 是「給單一管理員使用」的專屬資產助理，特色：

- **單人服務**：以 `ADMIN_STRING` 比對 userId，非授權使用者靜默忽略（不回覆、不寫歷史、不耗 LLM 配額）。Telegram ID 以 `TELEGRAM:` 前綴與 LINE ID 區分。
- **零外部資料庫**：全部狀態（持倉、現金、配置、對話歷史、記憶、知識、通知史、快照）都在同一份 Google Sheet。
- **AI Provider 熱切換**：在 Sheet `env!B3` 寫 `GEMINI` 或 `NVIDIA` 即可即時切換後端，無需重新部署。
- **主動感知 (Proactive Advisor)**：除了被動回覆，Iris 會在排程時點讀快照 + 管理員設定的決策，由 LLM 判斷是否值得主動 push 通知。

---

## 架構總覽

```
LINE Messaging API ─┐        ┌─ 瀏覽器（Google 登入）
Telegram Bot API ───┤        │
       │  (webhook) │        │  (GET /dev)
       ▼            │        ▼
┌──────────────────────────┐ ┌──────────────────────────────┐
│  Main.gs · doPost()      │ │  Main.gs · doGet()           │
│  - 正規化成中立 event     │ │  - Dashboard.isAuthorized()  │
│  - CacheService 去重      │ │  - 回 DashboardPage.html     │
│  - 靜默丟棄非主人事件      │ └──────────────┬───────────────┘
└────────────┬─────────────┘                │
             │                              ▼
             ▼                 ┌──────────────────────────────┐
┌──────────────────────────┐   │  Dashboard.gs                │
│  Commands.gs             │   │  - 重用 Snapshot 讀取器        │
│  - 斜線指令攔截           │   │  - 15 分鐘 CacheService 快取  │
│  - 非指令回 null 往下走    │   └──────────────────────────────┘
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────────────────────────┐
│  ChatBot.gs · ReAct Loop (最多 3 turns)       │
│  - 注入：SYSTEM_PROMPT + STM + 相關長期知識      │
│  - 工具呼叫快取（同一輪不重複叫同樣的 tool）        │
│  - 200s 不再開新輪 / 280s 不再補救呼叫            │
│  - 清除模型偶發的 <tool_call> XML 殘留           │
└────────────────┬─────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────┐
│  AIServiceFactory.gs                         │
│   ├─ Gemini   → GeminiService.gs             │
│   └─ NVIDIA   → AIAdapter (Gemini⇄OpenAI)    │
│                  └─ NvidiaService.gs         │
└────────────────┬─────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────┐
│  Tools.gs · 13 個工具                         │
│   ├─ 資產查詢：getHoldings / getDashboard /    │
│   │           getHistory / getPrice           │
│   ├─ 股利：getDividendHistory / recordDividend │
│   ├─ 記憶：rememberShortTerm / saveKnowledge / │
│   │       searchKnowledge / listMemories /    │
│   │       deleteMemory                        │
│   └─ 外部：searchWeb (Google Custom Search)    │
└────────────────┬─────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────┐
│  GoogleSheet.gs · 唯一資料層                    │
│  （單一 SpreadsheetApp 實例 cache per exec）    │
└──────────────────────────────────────────────┘
```

業務層永遠以 Gemini 的 `contents` 格式溝通；NVIDIA 路徑由 `AIAdapter` 前後做兩次格式轉換，
上層完全無感。

---

## 模組結構

| 檔案 | 職責 |
|---|---|
| `Main.gs` | `doPost` / `doGet` 入口、`dailyCleanUp`、`setupAllTriggers`、各項一次性 setup 函式 |
| `Commands.gs` | 斜線指令攔截層（定義 + 分派，與 Telegram 選單共用同一份清單） |
| `MessagingServiceFactory.gs` | 依 userId 前綴分派到 LINE 或 Telegram |
| `Line.gs` | LINE 簽章驗證、reply / push 訊息封裝 |
| `Telegram.gs` | Telegram update 正規化、訊息推送、webhook 與指令選單註冊 |
| `ChatBot.gs` | ReAct 對話迴圈，注入記憶、處理工具呼叫與 XML 清理 |
| `Prompt.gs` | `SYSTEM_PROMPT`（對話人設）與 `ADVISOR_PROMPT`（感知層 prompt） |
| `Tools.gs` | 工具定義與分派 |
| `AIServiceFactory.gs` | 依 `env!B3` 路由 Gemini / NVIDIA，含備援模型 fallback |
| `GeminiService.gs` | Gemini API 呼叫（含 function calling） |
| `NvidiaService.gs` | NVIDIA NIM OpenAI 相容 API 呼叫，含 3 次退避重試 |
| `AIAdapter.gs` | Gemini ⇄ OpenAI 格式相互轉換、分離 `reasoning_content` |
| `GoogleSheet.gs` | 所有 Sheet 讀寫：持倉、儀表板、歷史、股利、記憶、知識 |
| `HistoryManager.gs` | 讀寫 `chat` 工作表 |
| `Snapshot.gs` | 結構化資料層：總資產、持倉、現金、配置、股利、黃金，供顧問層與儀表板共用 |
| `Dashboard.gs` | 網頁儀表板的 payload 組裝、快取與存取控制 |
| `DashboardPage.html` | 儀表板前端單頁 |
| `MiniApp.gs` | Telegram Mini App 的 `initData` 驗簽與後端進入點 |
| `MiniAppPage.html` | Mini App 前端（手機優先，可點持倉問 Iris） |
| `AdvisorCheck.gs` | 主動感知層：呼叫 LLM 判斷是否 push 通知 |
| `AlertLog.gs` | 通知史記錄與去重 |
| `DailyReport.gs` | `buildDailyReport()` 產生器，加上每日 09:00 早報、週六週報、每月 1 日月報 |
| `MarketAlert.gs` | 10:00 / 14:00 盤中異動警報（單檔 ETF 日跌幅 > `ALERT_ETF_DROP`） |
| `DataSync.gs` | 每日 18:00 寫入 `每日快照`（長表，同日冪等，見「每日快照」） |
| `StockPrice.gs` | 即時台股股價查詢（TWSE API，僅上市） |
| `WebSearch.gs` | Google Custom Search 包裝 |
| `Utils.gs` | 文字格式化、`stripToolCallXml`、`formatForLine` |
| `Logger.gs` | 寫入 `consolelog` 工作表 |
| `AssetTools.gs` | 新表的寫入用例層：`recordTrade` 驗證後 append 一列並重算 |
| `Panel.gs` | 「面板」分頁的排版：整張都是指向持倉／現金／實體資產的公式，由 `Position.rebuild()` 最後呼叫。程式讀的數字在「指標」那張，不在這裡 |
| `AssetImport.gs` | 券商已實現損益 CSV 匯入（Telegram 傳檔進來），**只記賣出**、內容去重 |
| `DevTools.gs` | **所有在 GAS 編輯器手動執行的進入點**：建表、遷移、對帳、dry run、診斷。編輯器的函式下拉選單不顯示檔案來源，所以集中在這裡；trigger 與 web 進入點因為綁定名稱，仍留在各自的檔案 |
| `Config.gs` | 集中讀取 Script Properties 與 `env!B2/B3`，含 cache |

---

## Google Sheet 資料表

| 工作表 | 用途 |
|---|---|
| `env` | `B2`：DEBUG_MODE（true/false）<br>`B3`：AI_PROVIDER（`GEMINI` / `NVIDIA`） |
| `consolelog` | 執行期記錄；超過 10 天自動清除 |
| `chat` | 對話歷史（每 userId），超過 30 天自動清除 |
| `short_term_memory` | 短期記憶；有 expiry，每日清除 |
| `knowledge` | 長期知識；以關鍵字搜尋（非向量） |
| `alert_log` | 主動通知歷史，供 AdvisorCheck 去重 |
| `所有股票` | 持倉資料：row2 為 0000 合計列，row3+ 為個別 ETF |
| `面板` | 儀表板：B1:B8 摘要、C1:D4 淨值、E1:F8 現金分布 |
| `配置` | 資產配置（rows 2-21，台股/全球/息/指 比例） |
| `@所有股票紀錄` | 舊的寬表快照，已凍結，不再寫入 |
| `@股利` | 股利收入明細（日期、代號、金額） |
| `@固定` | 固定資產（黃金重量），由 `Snapshot._gold()` 讀取 |

### 每日快照（長表）

`每日快照` 的欄位固定是這九個，一列一個項目：

```
日期 | 類型 | 鍵 | 名稱 | 數量 | 單價 | 市值 | 幣別 | 狀態
```

合計（總資產、股票市值）、每檔持股、每個現金帳戶、黃金各一列，一天約 15~20 列。

**這個形狀就是為什麼舊的「欄位契約」可以整個拿掉。** 舊表 `@所有股票紀錄` 是一檔一欄，
多一檔 ETF 就整排右移而手動維護的標題列不動 —— 靜默錯位，將近 950 列歷史全部標錯。
長表裡加減標的只改變列數，欄位永遠不動，那套對齊機制就沒有存在的理由了。

保留下來的三道保險（它們本來就與欄位無關）：

- **同一天重跑會覆寫**當天的列，不會長出兩份
- **所有持股都抓不到報價時放棄寫入** —— 少一天可以補，一整天的 0 會污染所有下游百分比。
  只有部分抓不到時，該列市值留空並把當天標記為 `報價異常`
- **`狀態`** 記錄這天為什麼看起來沒動：`交易日` / `休市` / `資料未更新`（所有單價與前一次
  快照完全相同）/ `報價異常`。專案裡沒有台股行事曆，所以這是推論不是權威判定

在 GAS 編輯器跑 `verifySnapshot()` 或 `dryRunSetData()` 可以看今天會寫什麼，不寫入。

---

## AI 工具集

`Tools.gs` 共定義 13 個工具，呼叫者為 LLM。
工具以 `definitions` 陣列（給模型看的 schema）加上 `execute()` 內的 `switch` 分派實作，
**新增工具時兩處都要改**，只加 definitions 會讓模型叫得出來卻一律收到「未知的工具」。

| 工具 | 用途 |
|---|---|
| `getHoldings` | 完整持倉明細（股數、成本、市價、損益、殖利率） |
| `getDashboard` | 資產儀表板（總成本、收益、現金分布、配置比例） |
| `getHistory(days)` | 每日資產快照歷史（預設 30 天，最多 365） |
| `getPrice(symbols)` | 即時台股股價（一次最多 10 檔） |
| `getDividendHistory(year)` | 股利收入統計 |
| `recordDividend(symbol, amount, date)` | 登記股利入帳（內部走 `recordTrade`，新舊兩表都記） |
| `recordTrade(action, symbol, shares, price, fee, tax, amount, account, date, note)` | **寫進新的「資產管理」表**：買進／賣出／股利／存入／提出／費用／利息／轉出／轉入，記完自動 `Position.rebuild()` 重算持倉與餘額 |
| `rememberShortTerm(key, content, hours)` | 寫入短期記憶（預設 24h，最長 168h） |
| `saveKnowledge(tags, content)` | 寫入長期知識（含結構化 tag） |
| `searchKnowledge(query)` | 關鍵字搜尋長期知識 |
| `listMemories` | 列出目前所有 STM + knowledge |
| `deleteMemory(type, key)` | 刪除 STM 或 knowledge |
| `searchWeb(query)` | Google Custom Search 取得即時時事 |

ReAct 迴圈上限 `Config.TOOL_MAX_ITERATIONS = 3`，且**最後一輪不帶工具定義**，
所以實際上只有 2 輪能呼叫工具；同一輪相同參數的工具呼叫會被快取避免重複。

---

## 斜線指令

`Commands.gs` 在 `doPost` 進入 ChatBot **之前**攔截 `/` 開頭的訊息。
Telegram 的指令選單只是 UI 提示——點下去送出的仍是普通文字訊息——所以答案固定的指令
在這裡直接處理掉，省下整個 ReAct 迴圈與一次 LLM 配額。

| 指令 | 行為 |
|---|---|
| `/dashboard` | Telegram 上送出一則帶 Mini App 按鈕的訊息（點按鈕就地開啟面板）；其他平台回傳 `DASHBOARD_URL` |
| `/report` | 立即產生今日早報，只回給發問者（排程版本會跳過週末並推給所有主人） |

指令清單與分派共用同一份定義，並由 `Telegram.setupCommands()` 註冊到選單，
因此選單不會與實作脫節。**新增或改名指令後，需在 GAS 編輯器執行一次 `setupTelegramCommands()`。**

實作注意事項：

- `tryHandle()` 對「不是指令」必須回 `null`；回空字串會讓 `doPost` 誤判為已處理，訊息就此消失。
- handler 若會呼叫 LLM，必須先送一則實體訊息。`/report` 走 SMART 檔次（開思考）且含一次
  `searchWeb`，耗時以分鐘計，遠超過 typing 狀態的 5 秒。

---

## 網頁儀表板

同一個 GAS 專案上的第二個介面，由 `Main.gs` 的 `doGet()` 提供，唯讀。

| 檔案 | 職責 |
|---|---|
| `Dashboard.gs` | payload 組裝、15 分鐘快取、認證閘門、`dashboardData()` 前端進入點 |
| `DashboardPage.html` | 單頁儀表板：Chart.js 4（CDN）、RWD、深淺色、紅漲綠跌 |

內容包含總資產與日／週／月變化、資產走勢圖（30／90／365 天）、配置圓環、持倉明細、
股利年度與月分佈。

資料**重用 `Snapshot.gs` 既有的結構化讀取器**（`_holdings` / `_cash` / `_totals` / `_dividends`），
儀表板只補了 `totalSeries()` 與 `dividendSeries()` 兩個圖表用的序列。
⚠️ **這兩個刻意不併進 `collectAll()`**——那份 payload 會整份序列化進 LLM prompt，
灌一年份的逐日資料只是燒 context。

配置圓環由 `holdings` + `cash` 推導，而非讀 `配置` 工作表，因為那張表的欄位是動態依標題讀取、
結構會變。

### 存取控制

webhook 部署是 `ANYONE_ANONYMOUS`，所以 `doGet` 是公開可達的，必須自己擋：
`Dashboard.isAuthorized()` 比對 `Session.getActiveUser()` 與 `getEffectiveUser()`，
匿名訪客拿到空字串因而被拒。這需要 `appsscript.json` 內的 `userinfo.email` scope，
少了它閘門會靜默失效。可在 GAS 編輯器執行 `checkDashboardAuth()` 查看閘門實際看到的身分。

**儀表板請用 HEAD 部署的 `/dev` 網址開啟**——它強制 Google 登入且永遠是最新程式碼。
`/exec` 是匿名的 webhook 部署，對 GET 一律回 `Not Found`。
該網址存在 Script Property `DASHBOARD_URL`（`/dev` 的 deployment id 與 `/exec` 完全不同，
無法從程式推導）。

---

## Telegram Mini App

第三個介面：把儀表板嵌在 Telegram 的內嵌 webview 裡，由 `/dashboard` 送出的
inline `web_app` 按鈕開啟，面板從底部滑出、不必離開 App、**不需要 Google 登入**。

| 檔案 | 職責 |
|---|---|
| `MiniApp.gs` | `initData` 驗簽、`miniAppData()` / `miniAppAsk()` 進入點 |
| `MiniAppPage.html` | 手機優先的面板前端 |

### 為什麼要另一套認證

Mini App 掛在 **`/exec`（匿名）** 部署上，因為 Google 的 OAuth 在 Telegram 的內嵌 webview 裡
走不通，`/dev` 那道登入閘門在這裡沒有用。改用 Telegram 自己的機制：

```
data_check_string = 除 hash 外所有欄位，依 key 排序，"k=v" 以 \n 串接
secret_key        = HMAC_SHA256(訊息 = bot_token, 金鑰 = "WebAppData")
expected_hash     = hex(HMAC_SHA256(訊息 = data_check_string, 金鑰 = secret_key))
```

⚠️ **`doGet(?view=tg)` 回的頁面刻意不含任何資料**，它是公開的。
資料要等前端把 `initData` 送回 `miniAppData()` / `miniAppAsk()`、通過
`MiniApp.verifyInitData()` 才發。該函式除了驗簽，還會拒絕 `auth_date` 超過 24 小時的
請求（防重放），並且**仍然**把 user id 丟進 `Utils.checkMaster` ——
驗簽只證明「是誰開的」，不代表這個人有權限。

### 面板內容與互動

刻意**不是** `DashboardPage.html` 的複製品：手機面板該精簡，只放總資產、走勢、
可點的持倉、現金、預設問題。完整版留在 `/dev`。

配色走 Telegram 注入的 `--tg-theme-*` 變數，面板會跟隨使用者當前主題；
漲跌色不跟主題走，紅漲綠跌是語意不是裝飾。

點某一檔持倉會呼叫 `miniAppAsk()`，它組一個與 `doPost` 相同形狀的合成事件丟進
`ChatBot.reply()`，因此工具、記憶、對話歷史全部沿用同一條路徑。答案 push 進對話而不是
顯示在面板裡——面板是入口，對話才是 Iris 的主場。前端送出後不等回呼直接關閉面板，
因為 ReAct 迴圈遠比任何人願意盯著面板的時間長。

> `Telegram.WebApp.sendData()` 在這裡**不能用**——它只對「reply keyboard 按鈕」開啟的
> Mini App 有效，inline 按鈕與選單按鈕都不行。所以走 `google.script.run`。

---

## 排程任務

`setupAllTriggers()` 會清掉所有舊 trigger 並重建：

| 時間 | 函式 | 用途 |
|---|---|---|
| 每日 04:00 | `dailyCleanUp` | 清過期 STM、超過 10 天的 log、超過 30 天的 chat |
| 每日 09:00 | `dailyReport` | 個人化財經早報（週六改發週報） |
| 每日 10:00 | `marketAlert` | 盤中異動警報（單檔跌幅 > 3% 推播） |
| 每日 14:00 | `marketAlert` | 盤中異動警報（第二次） |
| 每週六 09:00 | `weeklyReport` | 週度績效回顧 |
| 每月 1 日 10:00 | `monthlyReport` | 月度總結 |
| 每日 13:00 | `rebuildAssets` | 收盤後重算持倉／面板／配置 |
| 每日 18:00 | `setData` | 寫入當日快照至新表的 `每日快照`（長表，同日覆寫） |
| 每日 19:00 | `advisorCheckEvening` | 主動顧問感知（讀快照 + 決策，LLM 判斷是否推播） |

所有報告與警報任務週末會自動跳過（非交易日）。

---

## 記憶與決策系統

### 兩層記憶

- **短期記憶 (STM)**：有時效（最長 7 天），每次對話與快照都會注入，過期自動清除。適合「目前關注標的」「臨時計畫」等。
- **長期知識 (Knowledge)**：永久保存，依當前訊息做關鍵字搜尋後注入相關項目。適合「投資原則」「風險偏好」等。

### 結構化決策 tag

`SYSTEM_PROMPT` 要求 Iris 在使用者說出特定類型內容時，**先確認再以 tag 格式存入 knowledge**：

| 類型 | tag 格式 | 範例 |
|---|---|---|
| 決策（觸發 → 行動） | `[決策] 標的-動作` | `[決策] 00631L-加倉條件` |
| 目標（數值 + 期限） | `[目標] 主題-期限` | `[目標] 現金比例-2026年底` |
| 偏好（永久原則） | `[偏好] 主題` | `[偏好] 投資工具限制` |
| 計畫（短中期） | `[計畫] 主題-月份` | `[計畫] 加碼台股-2026年6月` |

這些 tag 會被 `AdvisorCheck` 全量讀出來餵給 LLM，作為「是否該主動通知」的最高優先級判斷依據。

### 主動感知流程

```
Snapshot.collectAll()         // 蒐集：總資產變動、持倉變動、現金、配置、近期通知史
       │
       ▼
Snapshot.isQuiet()?           // 短路：明顯平靜直接 return，省 token
       │ no
       ▼
ac._loadDecisions()           // 全量讀 knowledge 中的 [決策][目標][偏好][計畫]
AlertLog.formatForPrompt(7)   // 取最近 7 天通知史去重
       │
       ▼
LLM (ADVISOR_PROMPT)          // 回傳 { shouldAlert, decisionRef, message, reason }
       │
       ▼
shouldAlert? → Line.pushMsg + AlertLog.append
```

---

## 環境設定

### Script Properties（GAS → 專案設定 → 指令碼屬性）

| Key | 必填 | 用途 |
|---|---|---|
| `SHEET_ID` | ✅ | Google Sheet ID |
| `ADMIN_STRING` | ✅ | 管理員 userId 允許清單，逗號分隔；Telegram 加 `TELEGRAM:` 前綴 |
| `LINE_API_KEY` | ⚙️ | LINE channel access token（用 LINE 時必填） |
| `LINE_CHANNEL_SECRET` | ⚙️ | LINE webhook 簽章驗證（用 LINE 時必填） |
| `TELEGRAM_API_KEY` | ⚙️ | Telegram bot token，來自 @BotFather（用 Telegram 時必填） |
| `DASHBOARD_URL` | ⚙️ | 儀表板 `/dev` 網址（`/dashboard` 指令回傳用） |
| `GEMINI_API_KEY` | ⚙️ | Gemini API key（用 Gemini 時必填） |
| `NVIDIA_API_KEY` | ⚙️ | NVIDIA NIM API key（用 NVIDIA 時必填） |
| `GOOGLE_SEARCH_KEY` | ⚙️ | Google Custom Search API key（用 `searchWeb` 時必填） |
| `GOOGLE_SEARCH_CX` | ⚙️ | Custom Search Engine ID |

### Sheet 內可調參數

- `env!B2`：DEBUG_MODE（true 時 Logger 寫更詳細）
- `env!B3`：AI_PROVIDER（`GEMINI` 或 `NVIDIA`），切換後須執行 `Config.clearAllCaches()` 或等下次冷啟動

### Config.gs 內常數

```js
CHAT_MAX_TURNS:      5     // 注入給 LLM 的近期對話輪數
CHAT_CLEANUP_DAYS:   30    // chat 工作表保留天數
TOOL_MAX_ITERATIONS: 3     // ReAct 上限（最後一輪不帶工具，實際可呼叫工具的只有 2 輪）
ALERT_ETF_DROP:      0.03  // 盤中警報觸發閾值（日跌幅 3%）
```

---

## 部署與開發流程

本專案以 **clasp** 將本地 `.gs` / `.html` 同步到 GAS。

```bash
clasp push        # 只更新 HEAD（/dev 立即生效，webhook 仍跑舊版）
clasp deploy -i <deploymentId>   # 更新版本化部署（webhook 生效，URL 不變）
clasp logs        # 檢視執行記錄
```

`.git/hooks/pre-push` 會在推上 `main` 時**自動執行 `clasp push` + `clasp deploy`**，
因此 `git push` 等於直接上生產；平常不需要手動下 clasp 指令。

專案共有兩個 deployment：

| 部署 | 存取權 | 用途 |
|---|---|---|
| 版本化（`/exec`） | 任何人、匿名 | LINE / Telegram webhook。對 GET 回 `Not Found` |
| HEAD（`/dev`） | 需 Google 登入 | 網頁儀表板，永遠是最新程式碼 |

### 推送前檢查

`.claude/skills/pre-push-check/SKILL.md` 收錄了這個專案踩過的地雷與各類改動的配套清單
（新增工具要改兩處、新增指令要重跑 `setupTelegramCommands()`、動 `appsscript.json` 的 scope
會讓既有授權失效等）。在 Claude Code 內說「push 前確認」即可觸發。

**踩到新的坑就寫回那份 skill**，這是它與 `CLAUDE.md` / `README.md` 的分工：
CLAUDE.md 是精簡地圖、README 是完整說明、SKILL 是流程與地雷。

---

## 首次安裝

1. 建立 Google Sheet，填入下列工作表名稱（內容欄位請參考 `GoogleSheet.gs`）：
   `env`、`consolelog`、`chat`、`short_term_memory`、`knowledge`、`alert_log`、
   `所有股票`、`面板`、`配置`、`@所有股票紀錄`、`@股利`、`@固定`
2. 在 GAS 編輯器設定上述 Script Properties。
3. 在 GAS 執行 `setup()`，確認所有工作表與環境變數齊備。
4. 在 GAS 執行 `setupAllTriggers()`，建立全部排程任務。
5. 設定訊息平台的 webhook，指向部署的 `/exec` 結尾網址：
   - **Telegram** — 在 GAS 執行 `setupTelegramWebhook()`
   - **LINE** — 將 `/exec` 網址貼進 LINE Developers 主控台並啟用 webhook
6. 在 GAS 執行 `setupTelegramCommands()`，註冊斜線指令選單（僅 Telegram 需要）。
7. 建立第二個 deployment 給儀表板，取得其 `/dev` 網址並填入 Script Property `DASHBOARD_URL`；
   執行 `checkDashboardAuth()` 確認認證閘門看得到你的身分。
8. 用管理員帳號傳訊息到 Bot，驗證 `doPost` → `ChatBot` → AI 路徑全通。

---

## 法律與免責

Iris 為個人自用工具，不執行任何實際交易、不保證投資報酬，所有分析與通知僅供使用者個人決策參考。
