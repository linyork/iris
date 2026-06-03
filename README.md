# Iris — 個人資產管理 LINE Bot

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

Iris 是一個建構在 **Google Apps Script (GAS)** 上的私人資產管理助理，透過 LINE Bot 與使用者互動。
所有資料以單一 Google Sheet 為唯一資料庫，AI 推論支援 **Gemini** 與 **NVIDIA NIM (GLM-5.1)** 雙引擎熱切換，
具備 ReAct 工具呼叫、長短期記憶、每日財經早報、盤中異動警報，以及由 LLM 主導判斷的主動顧問感知層。

---

## 目錄

- [系統定位](#系統定位)
- [架構總覽](#架構總覽)
- [模組結構](#模組結構)
- [Google Sheet 資料表](#google-sheet-資料表)
- [AI 工具集](#ai-工具集)
- [排程任務](#排程任務)
- [記憶與決策系統](#記憶與決策系統)
- [環境設定](#環境設定)
- [部署與開發流程](#部署與開發流程)
- [首次安裝](#首次安裝)

---

## 系統定位

Iris 是「給單一管理員使用」的專屬資產助理，特色：

- **單人服務**：以 `ADMIN_STRING` 比對 LINE userId，非授權使用者一律拒絕回覆。
- **零外部資料庫**：全部狀態（持倉、現金、配置、對話歷史、記憶、知識、通知史、快照）都在同一份 Google Sheet。
- **AI Provider 熱切換**：在 Sheet `env!B3` 寫 `GEMINI` 或 `NVIDIA` 即可即時切換後端，無需重新部署。
- **主動感知 (Proactive Advisor)**：除了被動回覆，Iris 會在排程時點讀快照 + 管理員設定的決策，由 LLM 判斷是否值得主動 push 通知。

---

## 架構總覽

```
LINE Messaging API
       │  (webhook)
       ▼
┌──────────────────────────────────────────────┐
│  Main.gs · doPost()                          │
│  - 驗證 LINE 簽章                              │
│  - CacheService 去重                          │
│  - 拒絕非授權使用者                              │
└────────────────┬─────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────┐
│  ChatBot.gs · ReAct Loop (最多 5 turns)       │
│  - 注入：SYSTEM_PROMPT + STM + 相關長期知識      │
│  - 工具呼叫快取（同一輪不重複叫同樣的 tool）        │
│  - 4.5 分鐘執行時限自動收尾                      │
│  - 清除 GLM 偶發的 <tool_call> XML 殘留          │
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

| 檔案 | 行數 | 職責 |
|---|---:|---|
| `Main.gs` | 223 | `doPost` 入口、`dailyCleanUp`、`setupAllTriggers`、`setup` |
| `Line.gs` | 106 | LINE 簽章驗證、reply / push 訊息封裝 |
| `ChatBot.gs` | 196 | ReAct 對話迴圈，注入記憶、處理工具呼叫與 XML 清理 |
| `Prompt.gs` | 122 | `SYSTEM_PROMPT`（對話人設）與 `ADVISOR_PROMPT`（感知層 prompt） |
| `Tools.gs` | 206 | 工具定義與分派 |
| `AIServiceFactory.gs` | 87 | 依 `env!B3` 路由 Gemini / NVIDIA |
| `GeminiService.gs` | 69 | Gemini API 呼叫（含 function calling） |
| `NvidiaService.gs` | 110 | NVIDIA NIM (GLM-5.1) OpenAI 相容 API 呼叫 |
| `AIAdapter.gs` | 177 | Gemini ⇄ OpenAI 格式相互轉換 |
| `GoogleSheet.gs` | 542 | 所有 Sheet 讀寫：持倉、儀表板、歷史、股利、記憶、知識 |
| `HistoryManager.gs` | 36 | 讀寫 `chat` 工作表 |
| `Snapshot.gs` | 383 | 顧問感知層的「備料」：彙整總資產、持倉、現金、配置、決策、近期快照 |
| `AdvisorCheck.gs` | 246 | 主動感知層：呼叫 LLM 判斷是否 push 通知 |
| `AlertLog.gs` | 116 | 通知史記錄與去重 |
| `DailyReport.gs` | 208 | 每日 09:00 早報、週六週報、每月 1 日月報 |
| `MarketAlert.gs` | 75 | 10:00 / 14:00 盤中異動警報（單檔 ETF 日跌幅 > `ALERT_ETF_DROP`） |
| `DataSync.gs` | 69 | 每日 18:00 寫入 `@所有股票紀錄` 快照 |
| `StockPrice.gs` | 83 | 即時台股股價查詢（非持倉標的） |
| `WebSearch.gs` | 59 | Google Custom Search 包裝 |
| `Utils.gs` | 95 | 文字格式化、`stripToolCallXml`、`formatForLine` |
| `Logger.gs` | 26 | 寫入 `consolelog` 工作表 |
| `Config.gs` | 106 | 集中讀取 Script Properties 與 `env!B2/B3`，含 cache |

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
| `@所有股票紀錄` | 每日資產快照（`setData` 於 18:00 寫入） |
| `股利紀錄` | 股利收入明細 |

---

## AI 工具集

`Tools.gs` 共定義 13 個工具，呼叫者為 LLM：

| 工具 | 用途 |
|---|---|
| `getHoldings` | 完整持倉明細（股數、成本、市價、損益、殖利率） |
| `getDashboard` | 資產儀表板（總成本、收益、現金分布、配置比例） |
| `getHistory(days)` | 每日資產快照歷史（預設 30 天，最多 365） |
| `getPrice(symbols)` | 即時台股股價（一次最多 10 檔） |
| `getDividendHistory(year)` | 股利收入統計 |
| `recordDividend(symbol, amount, date)` | 登記股利入帳 |
| `rememberShortTerm(key, content, hours)` | 寫入短期記憶（預設 24h，最長 168h） |
| `saveKnowledge(tags, content)` | 寫入長期知識（含結構化 tag） |
| `searchKnowledge(query)` | 關鍵字搜尋長期知識 |
| `listMemories` | 列出目前所有 STM + knowledge |
| `deleteMemory(type, key)` | 刪除 STM 或 knowledge |
| `searchWeb(query)` | Google Custom Search 取得即時時事 |

ReAct 迴圈上限 `Config.TOOL_MAX_ITERATIONS = 5`；同一輪相同參數的工具呼叫會被快取避免重複。

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
| 每日 18:00 | `setData` | 寫入當日資產快照至 `@所有股票紀錄` |
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
| `LINE_API_KEY` | ✅ | LINE channel access token |
| `LINE_CHANNEL_SECRET` | ✅ | LINE webhook 簽章驗證 |
| `SHEET_ID` | ✅ | Google Sheet ID |
| `ADMIN_STRING` | ✅ | 管理員的 LINE userId |
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
TOOL_MAX_ITERATIONS: 5     // ReAct 上限
ALERT_ETF_DROP:      0.03  // 盤中警報觸發閾值（日跌幅 3%）
```

---

1. 建立 Google Sheet，填入下列工作表名稱（內容欄位請參考 `GoogleSheet.gs`）：
   `env`、`consolelog`、`chat`、`short_term_memory`、`knowledge`、`alert_log`、
   `所有股票`、`面板`、`配置`、`@所有股票紀錄`、`股利紀錄`
2. 在 GAS 編輯器設定上述 Script Properties。
3. 在 GAS 執行 `setup()`，確認所有工作表與環境變數齊備。
4. 在 GAS 執行 `setupAllTriggers()`，建立全部排程任務。
5. 將 LINE Channel 的 Webhook URL 設為部署的 `/exec` 結尾網址，並啟用 webhook。
6. 用管理員帳號傳訊息到 Bot，驗證 `doPost` → `ChatBot` → AI 路徑全通。

---

## 法律與免責

Iris 為個人自用工具，不執行任何實際交易、不保證投資報酬，所有分析與通知僅供使用者個人決策參考。
