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
> | `Tools.gs` 的 22 個工具 | `@tool` decorator / `StructuredTool` |
> | `AIServiceFactory` + `AIAdapter` | `BaseChatModel` 抽象 + provider 子類 |
> | `GoogleSheet` 的 chat 讀寫 + STM 注入 | `Memory` / `Checkpointer` |
> | `searchKnowledge` 關鍵字查 Sheet | `VectorStore` retriever |
> | `AdvisorCheck` 排程感知層 | LangGraph 子圖 + Conditional Edge |
>
> 由於每個模組職責切得很乾淨（Provider、Tools、Memory、Retrieval、Graph orchestration 各自獨立），要搬到 **LangChain / LangGraph (Python or TS)** 基本上就是把現有元件一對一換成框架對應的抽象，再接上正式的向量資料庫與可觀測性（LangSmith）即可，不需要重新設計。

---

Iris 是一個建構在 **Google Apps Script (GAS)** 上的私人資產管理助理，透過 **LINE 或 Telegram** 與使用者互動。
所有資料以單一 Google Sheet 為唯一資料庫，AI 推論支援 **Gemini** 與 **NVIDIA NIM (DeepSeek-V4-Flash-0731)** 雙引擎熱切換，
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
│  ChatBot.gs · ReAct Loop (最多 5 turns)       │
│  - 注入：SYSTEM_PROMPT + STM + 相關長期知識      │
│          + Facts 事實區塊（程式算好的關鍵數字）    │
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
│  Tools.gs · 22 個工具                         │
│   ├─ 資產查詢：getHoldings / getDashboard /    │
│   │           getHistory / getPrice           │
│   ├─ 股利：getDividendHistory / recordDividend │
│   ├─ 記帳：addAccount / recordTrade /          │
│   │       setCashBalance / voidTrade          │
│   ├─ 主檔：listTrades / listAccounts /         │
│   │       listInstruments /                   │
│   │       updateAccount / updateInstrument    │
│   ├─ 記憶：rememberShortTerm / saveKnowledge / │
│   │       searchKnowledge / listMemories /    │
│   │       deleteMemory                        │
│   ├─ 回饋：logAdvice（記下自己給過的建議）        │
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
| `Main.gs` | `doPost` / `doGet` 入口、`dailyCleanUp` |
| `Cron.gs` | 排程登記處：`SCHEDULE` 是唯一事實來源，`Cron.list()` 與 GAS 實際註冊的比對 |
| `Commands.gs` | 斜線指令攔截層（定義 + 分派，與 Telegram 選單共用同一份清單） |
| `MessagingServiceFactory.gs` | 依 userId 前綴分派到 LINE 或 Telegram |
| `Line.gs` | LINE 事件正規化、reply / push 訊息封裝 |
| `Telegram.gs` | Telegram update 正規化、訊息推送、webhook 與指令選單註冊 |
| `ChatBot.gs` | ReAct 對話迴圈：注入記憶／知識／`Facts`／先前建議，執行工具，攔截「說已記錄卻沒寫」，剝除 Markdown |
| `Prompt.gs` | `SYSTEM_PROMPT`（對話人設）、`ADVISOR_PROMPT`（感知層 prompt）、`systemContext()`（四個 LLM 迴圈共用的開頭與日期規則） |
| `Facts.gs` | 程式算好的關鍵數字，注入每一則對話 prompt 要求原樣引用。**刻意只收不用打外部 API 的數字**（讀 指標／現金／每日快照），逐檔持倉留給 `getHoldings` —— 這個區塊每則訊息都要組一次 |
| `Tools.gs` | 工具定義與分派 |
| `AIServiceFactory.gs` | 依 `env!B3` 路由 Gemini / NVIDIA，含備援模型 fallback |
| `GeminiService.gs` | Gemini API 呼叫（含 function calling） |
| `NvidiaService.gs` | NVIDIA NIM OpenAI 相容 API 呼叫，含 3 次退避重試 |
| `AIAdapter.gs` | Gemini ⇄ OpenAI 格式相互轉換、分離 `reasoning_content` |
| `GoogleSheet.gs` | 系統分頁讀寫（chat／記憶／知識／log），以及資產查詢的**格式化層**（資料向 Snapshot 拿）|
| `AssetSchema.gs` | 分頁與欄位定義、建表、交易表公式、`readTrades` / `appendTrade` 等共用存取 |
| `Position.gs` | **計算核心**：重放交易算持倉、已實現損益、現金、配置、指標（加權平均法）|
| `AssetMigrate.gs` | 舊表 → 新表的遷移程式。production 不再使用，現為 `test_asset.cjs` 的 fixture |
| `Snapshot.gs` | **唯一的結構化讀取層**：總資產、持倉、現金、配置、股利、實體資產。四個消費端共用（儀表板、Mini App、`GoogleSheet` 的格式化層、`AdvisorCheck`）|
| `Dashboard.gs` | 網頁儀表板的 payload 組裝、快取與存取控制 |
| `DashboardPage.html` | 儀表板前端單頁 |
| `MiniApp.gs` | Telegram Mini App 的 `initData` 驗簽與後端進入點 |
| `MiniAppPage.html` | Mini App 前端（手機優先，可點持倉問 Iris） |
| `AdvisorCheck.gs` | 主動感知層：呼叫 LLM 判斷是否 push 通知 |
| `AlertLog.gs` | 通知史記錄與去重（保留 60 天）|
| `AdviceLog.gs` | Iris 給過的建議與後續追蹤（保留 180 天）。分頁不存在會自己建；「後來如何」在讀取時現算，不回填 |
| `DailyReport.gs` | 三份報告共用的 `_generateReport()` 骨架，加上每日 09:00 早報、週六週報、每月 1 日月報 |
| `MarketAlert.gs` | 10:00 / 14:00 盤中異動警報（單檔 ETF 日跌幅 > `ALERT_ETF_DROP`） |
| `DataSync.gs` | 每日 18:00 寫入 `每日快照`（長表，同日冪等，見「每日快照」） |
| `StockPrice.gs` | 即時台股股價查詢（TWSE API，僅上市） |
| `WebSearch.gs` | Google Custom Search 包裝 |
| `Utils.gs` | 執行時間預算（`execElapsedMs`）、帳本寫入計數（`noteLedgerWrite`）、「說已完成」偵測（`claimsWriteDone`）、文字格式化與分段 |
| `Logger.gs` | 寫入 `consolelog` 工作表 |
| `Eval.gs` | 固定題組 + 可自動判定的性質。**判定是純函式（測得起來），執行才需要 LLM 且一次只跑幾題**，重複執行 `runEval()` 直到整組跑完 |
| `Metrics.gs` | 把 `consolelog` 聚合成每日一列（輪數、耗時、逾時、備援接手、假宣稱攔截、錯誤數）。**在 `dailyCleanUp` 清 consolelog 之前跑**，否則等於丟掉再算 |
| `AssetTools.gs` | 新表**輸入層**的用例層：`recordTrade` 驗證後 append 一列並重算；`voidTrade` 作廢記錯的列；`updateInstrument` / `updateAccount` 改主檔；`listTrades` / `listAccounts` / `listInstruments` 讀主檔（計算層的讀取在 `Snapshot`） |
| `Panel.gs` | 「面板」分頁的排版：整張都是指向持倉／現金／實體資產的公式，由 `Position.rebuild()` 最後呼叫。程式讀的數字在「指標」那張，不在這裡 |
| `AssetImport.gs` | 券商 CSV 匯入（Telegram 傳檔進來）。認得兩種格式：**證券對帳單**（有「委託書號」，買賣都記，首選）與**已實現損益**（有「賣出日期」，只記賣出）。兩種格式互相去重 |
| `DevTools.gs` | **所有在 GAS 編輯器手動執行的進入點**：建表、重算、dry run、診斷。編輯器的函式下拉選單不顯示檔案來源，所以集中在這裡；trigger 與 web 進入點因為綁定名稱，仍留在各自的檔案。遷移相關的進入點已移除 —— 遷移做完了，留在選單裡只會被誤觸 |
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
| `alert_log` | 主動通知歷史，供 AdvisorCheck 去重；保留 60 天 |
| `eval_set` | 評估題組與每題的最新判定（PASS / FAIL 與未通過的性質）。**不存在時自己建立並寫入預設題組** |
| `metrics` | 每日執行指標，由 `Metrics.rollupDaily()` 寫入（同日覆蓋）。**不存在時自己建立** |
| `advice_log` | Iris 給過的建議：時間／來源／主題／建議／當下總資產／使用者反應。保留 180 天，**不存在時由 `AdviceLog` 自己建立** |

### 資產分頁

分頁與欄位的定義在 `AssetSchema.TABS`，那份是規格，這裡只說明各自的角色。

| 工作表 | 層 | 用途 |
|---|---|---|
| `標的` | 輸入 | 投資標的主檔。區域／類型／目標配置% 空著的話不會進「配置」的分組 |
| `帳戶` | 輸入 | 帳戶主檔。期初餘額只填一次，之後的水位由交易推導 |
| `實體資產` | 輸入 | 黃金這類非證券資產 |
| `交易` | 輸入 | **唯一的事實來源**。只新增不改；記錯用 `voidTrade` 把「狀態」設成作廢 |
| `持倉` | 計算 | 股數、成本、累計股利、已實現損益、市價、市值 |
| `已實現損益` | 計算 | 每一筆賣出的沖銷結果 |
| `現金` | 計算 | 餘額 = 帳戶期初 + 交易現金流 |
| `配置` | 計算 | 三個維度：大類／區域／類型，含目標與偏離 |
| `指標` | 計算 | 直式 key-value，**程式讀的是這張** |
| `面板` | 計算 | 人看的橫式儀表板，每一格都是公式 |
| `每日快照` | 歷史 | 每日 18:00 寫入的長表，一列一個項目 |

⚠️ 計算層的分頁由 `Position.rebuild()` 整段覆寫，手改活不過下一次重算。
要修正數字請改「交易」那一列。

⚠️ 舊的「股票」試算表（`所有股票` / `@所有股票紀錄` / `@股利` / `@固定`）**已凍結**，
production 完全不讀不寫，只有 `AssetMigrate.gs` 在測試裡當 fixture 用。

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

### 市價有三層，第三層不在試算表裡

`持倉` 的 H 欄由 `Position._priceFormula()` 產生：GOOGLEFINANCE 優先，TPE 標的抓不到時退到
TWSE 的 `STOCK_DAY_AVG` 端點硬解析收盤價。

**第三層是後來補的，因為前兩層會一起死。** 2026-08-07 六檔裡五檔沒有市價，而
`=GOOGLEFINANCE("TPE:00878","price")` 單獨貼一格也是 `#N/A` —— 掛的是 GOOGLEFINANCE 本身，
`IMPORTDATA` 跟著一起。兩者都是**試算表側**的外部函式，受同一份文件層級的節流管制，備援疊在
同一層等於沒有備援。

所以 `Position._fillMissingPrices()` 在寫完並 flush 之後跑：找出「有股數卻沒有價」的列，改走
`StockPrice.getRawPrices()` → `UrlFetchApp` → TWSE MIS 端點。那是**伺服器端**的請求，完全不受
上面那套配額影響。

- **寫進去的是死值不是公式** —— 它不會像 H 欄平常那樣等報價回來自己更正。可以接受是因為每次
  `rebuild()` 都先把公式整片重寫，下一次重算一定會再給 GOOGLEFINANCE 一次機會，再失敗才會又
  落到第三層。留白更糟：`$I` 歸零，總資產、所有百分比、當天的快照全部跟著錯
- **補成功也要出聲**，而且那句警告要在 `_writePanelAndAllocation` **之前**推進
  `replayed.warnings` —— 「指標」最上面的 `⚠️ 待修正` 列是從那裡生出來的，寫完才推就只剩聊天
  回覆看得到，儀表板的警示條完全不知情
- **MIS 也抓不到就照實留白**，不編一個價；原本的「抓不到市價」警告就是正確結果
- MIS 只認上市（`tse_`），與 `StockPrice` 原本的限制相同，非 TPE 標的不送出去

### 現金餘額怎麼改

現金帳戶的餘額**沒有任何地方可以直接寫**，只有兩個入口：

```
帳戶!期初餘額（人填一次，期初日期當天的餘額）  ┐
                                              ├→ 現金!餘額 → 台幣值 → 指標!總資產 → …
交易!現金流（每一列一筆，SUMIF(帳戶) 彙總）    ┘
```

「現金」整張表是 `Position.rebuild()` 覆寫出來的，手改那一格活不過下一次重算
（記一筆交易、`setData`、日報、`/refresh` 都會重算）。改「帳戶」的期初餘額則是
竄改歷史起點，跟期初日期對不起來，而且不留痕跡。

所以主人講絕對值（「郵局現在是 X」）時，`setCashBalance()` 做的是**把絕對值翻譯回差額**：
重讀「現金」表的當下餘額，往「交易」加一列 `動作=調整`、`分類=校正`，備註寫下校正前後的
數字。餘額因此仍然只是交易的推導結果，校正本身也留下可稽核的一列。

- **「調整」是全表唯一允許「金額」為負的動作**，往下校正就是負數
- **差額只能由 `setCashBalance` 算**，`recordTrade({action:'調整'})` 會被擋下並指路。
  因為 LLM 看到的現金數字是 `Snapshot._cash` 換算過的**台幣值**，拿去減外幣戶的目標餘額
  會整整差一個匯率，兩邊都不會報錯
- **`balance` 一律填該帳戶的原幣** —— 國泰外幣戶(美) 填美金，不要換算台幣
- 餘額本來就對得上時不寫任何一列，直接回「不用校正」

帳戶本身由 `addAccount()` 建立、`updateAccount()` 修改 —— 只有這兩個地方會寫「帳戶」主檔。
`期初餘額` 的語意是**期初日期那天的餘額**，建完就不該再動 —— 之後的水位一律由交易推導。

> `addAccount` 是補回來的：在它之前「帳戶」只能手改，模型被要求開新戶頭時無路可走，
> 於是回了一句「已建立完成」而實際上什麼都沒發生（2026-08-05）。所以提示詞裡另外
> 加了一條硬規則：**寫入類的事沒收到工具回傳結果之前，不准說已完成。**

#### 那條規則擋不住的時候

2026-08-07 又中一次，而且是提示詞在的情況下：主人要把一個帳戶校正成某個絕對值，模型先反問
一句確認，主人答「是的」，模型回「好的，已校正。」—— 那一輪 `toolCallCount: 0`，試算表原封不動。
**謊報成功比拒絕嚴重得多**，因為拒絕會被重試，成功不會。

所以現在多一道結構性的檢查，不靠模型自律：

- 真的動到試算表的每一處都叫一次 `Utils.noteLedgerWrite()`，`ChatBot.reply` 進迴圈前記下
  `Utils.ledgerWriteCount()` 當基準，收尾時比對 —— **證據取自寫入本身**
- `Utils.claimsWriteDone(text)` 認得「已記錄／已校正／幫你記下來了／建好了」這類宣稱
- 有宣稱、沒寫入 → **把話打回模型再跑一輪**（工具還在），那一輪才是真正寫進去的地方
- 打回去之後還是那樣講（或宣稱落在沒有工具的最後一輪）→ 回覆前面加一行警告說明沒有寫入

反問那一句本身就是導火線 —— 「我要去做」和下一輪之間，那個動作就掉了。因此提示詞同時加了：
參數齊全就直接寫、不要為了確認多問一輪，工具回傳才是確認，寫錯了有 `voidTrade`。

> ⚠️ 以前這裡看的是「模型有沒有叫寫入工具」（`Tools.isWrite` 加一份 `WRITE_TOOLS` 名單），
> 而旗子掀在 `Tools.execute` **之前** —— 工具被擋下（賣出股數不足）、參數不齊、丟例外時，
> 帳本沒動，攔截器卻已放行，偏偏那正是最容易也最不該出現假「已記錄」的場合。
>
> ⚠️ `noteLedgerWrite` **不可以改成攔截所有試算表寫入**：`Logger` 每則訊息都寫 consolelog、
> `ChatBot` 每次回覆都寫兩列 chat，全域計數會恆為真，等於把防線關掉又看起來像修好了。
>
> 漏加一個呼叫點的後果是**誤報**（寫成功了卻被加警語），不是漏報。這個方向是刻意選的。

### 記錯了怎麼撤

「交易」是 append-only，但 append-only 需要的是**撤銷的方法**，不是「不准動」。
`voidTrade(row, reason)` 打的是墓碑：那一列留著、原始數字留著，只在 `狀態` 欄寫上
「作廢」，備註接上原因與時間戳。所有算數字的地方（`AssetSchema.readTrades`）跳過它。

> ⚠️ **不要改用「反手記一筆相反的交易」來抵銷。** 現金那邊可以（現金流一路 SUMIF，
> 加一列負的就抵掉了），**股票那邊不行**：記錯的買進反手記一筆賣出，加權平均重放會把
> 它當成真的處分，憑空生出一筆已實現損益 —— 錯的沒消失，只是多了一筆假的。

三件必須同時成立的事：

- **現金流那一欄要一起失效。** `現金!交易淨流` 是 `SUMIF(交易!$L:$L, 帳戶, 交易!$J:$J)`
  —— 整欄加總，它不知道 JS 那邊過濾掉了什麼。所以守門條件寫在**公式裡**
  （`IF(OR($B="",$Q="作廢"),"",…)`），而且作廢時會重寫那一列的公式：既有的列可能還帶著
  加「狀態」欄之前的舊版公式，不重寫就會變成「列跳過了、錢還在」
- **「期初」不給作廢。** 那是遷移建倉的起點，拿掉之後所有後續賣出都會變成「當下無持股」
  而整批被跳過，持倉直接歸零
- **匯入去重仍然認得它。** 作廢的列**內容鍵照算、數量不算**：作廢是刻意的動作，重送同一份
  券商檔案不該讓它悄悄復活；但它已經不是真實部位，不能再抵掉新資料的股數

要作廢哪一列用 `listTrades` 查 —— 它每一筆前面的「第 N 列」就是 `voidTrade` 要的列號。

⚠️ **兩種「只撤一半」的情況，程度不一樣：**

| 情況 | 會怎樣 | 有沒有人講 |
|---|---|---|
| 作廢 `買進`、`賣出` 還在 | 賣出被判定「當下無持股」而跳過，但它的現金流仍入帳 | ✅ `Position.replay` 警告 → `voidTrade` 回覆＋`指標` 的 `⚠️ 待修正` |
| 作廢 `轉出`／`轉入` 的其中一腿 | 總資產憑空多出或少掉那筆錢 | ⚠️ 只有 `voidTrade` 自己提醒 |

### 賣不掉你沒有的股票

`recordTrade` 的賣出會先問「**那一天**帳本裡有沒有這麼多股」，不夠就整筆擋下、什麼都不寫。

要防的是兩套帳對同一列看法不一致：`Position.replay` 知道你沒持股，會把那筆跳過（股數不動、
不產生已實現損益）；但 `現金流` 是那一列**自己的試算表公式**，它只讀這列寫了幾股幾塊，看不到持倉。
放進去的結果就是股票沒動、錢卻入帳。

判斷交給 `Position.replay` 自己跑一次「到那個日期為止」的重放，不另外寫一份算持股的邏輯 ——
加權平均是路徑相依的，第二份實作遲早會跟真正的重放分岔。

> ⚠️ **只有 `recordTrade` 擋。** 券商匯入不擋——對帳單說賣了就是賣了，那裡缺的是買進
> （見「只記賣出」的理由），擋下來只會讓真實成交進不了帳。所以懸空的賣出仍可能從匯入、
> 手改試算表、或「作廢了買進但賣出還在」進來，那幾條路靠上面那張表的事後警告收尾。

轉帳的兩列**沒有欄位把彼此綁在一起**（刻意的，見「現金餘額怎麼改」），而且轉帳不碰持倉，
所以 `replay` 沒有東西可以警告。`voidTrade` 因此在作廢 `轉出`／`轉入` 時會直接把金額講出來，
但配對哪一列仍然要人自己找。

### 主檔怎麼改

`標的` 與 `帳戶` 是**被不可變資料用字串引用的參考資料**，和交易的規則正好相反：
交易禁止修改、只能作廢；主檔沒有「再記一筆」可以退，**更新是唯一的修正路徑**。

- `交易!名稱`、`持倉!目標配置%` 都是 VLOOKUP 回主檔，新建一列正確的並不會讓舊的失效
- **改帳戶名是跨兩張表的事**：`現金!交易淨流` 按帳戶名 SUMIF，只改主檔那一格、不改
  「交易」裡的每一列，那個帳戶的餘額會靜靜地掉回期初值，而且不會有任何錯誤。
  `updateAccount({newName})` 會一起改寫（「每日快照」的歷史列保持舊名，那是當時的紀錄）
- **帳戶不提供刪除，只有停用**，而且**停用前餘額必須是 0** —— 停用的帳戶會被
  `Position` 從「現金」表整列濾掉，裡面還有錢的話那筆錢會直接從總資產上消失
- **已經有交易的帳戶不給改幣別**：那些列的金額是用舊幣別記的，改了之後餘額會變成
  兩種貨幣加在一起再乘新匯率
- `updateInstrument` 的 `target` **一律填 0..1 的比例**，15% 要填 0.15。填 15 會被擋下來，
  程式不做 `/100` 的自動換算 —— 12.5 是「12.5%」還是手滑多打一位，猜錯就是一百倍的偏離

> `updateInstrument` 存在的直接原因是 `recordTrade` 的自動建立只生得出**半個**標的：
> 買進新代號時會自動登記一列，但 `區域` / `類型` / `目標配置%` 一律留空，而「配置」就是
> 按區域與類型分組的。`listInstruments` 會直接點名哪幾檔還缺。

---

## AI 工具集

`Tools.gs` 共定義 22 個工具，呼叫者為 LLM。
工具以 `definitions` 陣列（給模型看的 schema）加上 `execute()` 內的 `switch` 分派實作，
**新增工具時兩處都要改**，只加 definitions 會讓模型叫得出來卻一律收到「未知的工具」。

| 工具 | 用途 |
|---|---|
| `getHoldings` | 完整持倉明細（股數、成本、市價、損益、殖利率） |
| `getDashboard` | 資產儀表板（總成本、收益、現金分布、配置比例） |
| `getHistory(days)` | 每日資產快照歷史（預設 30 天，最多 365） |
| `getPrice(symbols)` | 即時台股股價（一次最多 10 檔） |
| `getDividendHistory(year)` | 股利收入統計 |
| `recordDividend(symbol, amount, date)` | 登記股利入帳（內部走 `recordTrade`，寫進「交易」表後自動重算） |
| `recordTrade(action, symbol, shares, price, fee, tax, amount, account, date, note)` | **寫進新的「資產管理」表**：買進／賣出／股利／存入／提出／費用／利息／轉出／轉入，記完自動 `Position.rebuild()` 重算持倉與餘額。賣出會先驗當天持股，不足整筆擋下 —— 見[賣不掉你沒有的股票](#賣不掉你沒有的股票) |
| `setCashBalance(account, balance, note, date)` | 把某個現金帳戶**校正成指定的餘額**（主人講絕對值時用）。差額由程式重讀「現金」表當場算，寫成一列「調整」交易 —— 見[現金餘額怎麼改](#現金餘額怎麼改) |
| `addAccount(name, type, currency, institution, balance, date, note)` | 開新帳戶，往「帳戶」主檔加一列後重算。**唯一能新增帳戶的途徑**；同名（含停用）一律擋下 |
| `voidTrade(row, reason)` | 作廢一筆記錯的交易：列與原始數字留著，只在「狀態」打記號並讓現金流失效 —— 見[記錯了怎麼撤](#記錯了怎麼撤) |
| `listTrades(limit, symbol, account, action, includeVoid)` | 列出逐筆交易，**每筆都帶「第 N 列」**（`voidTrade` 要的列號）。與 `getHistory`（每日快照）不同 |
| `listAccounts` | 列出所有帳戶（含停用）與**原幣**餘額。`getDashboard` 只給換算後的台幣值 |
| `listInstruments` | 列出「標的」主檔，含已出清與尚未買進的，並點名區域／類型還沒填的 |
| `updateInstrument(symbol, name, market, currency, quoteSource, region, category, target, status, note)` | 改「標的」主檔。代號不能改；`target` 一律 0..1 的比例，填百分比會被擋下 |
| `updateAccount(name, newName, type, currency, institution, status, note)` | 改「帳戶」主檔。改名會**連「交易」的每一列一起改寫**；不提供刪除，只有停用，且停用前餘額必須是 0 |
| `rememberShortTerm(key, content, hours)` | 寫入短期記憶（預設 24h，最長 168h） |
| `saveKnowledge(tags, content)` | 寫入長期知識（含結構化 tag） |
| `searchKnowledge(query)` | 關鍵字搜尋長期知識 |
| `listMemories` | 列出目前所有 STM + knowledge |
| `deleteMemory(type, key)` | 刪除 STM 或 knowledge |
| `logAdvice(topic, advice)` | 登記 Iris 自己剛給出的**具體建議**，寫進 `advice_log`。之後會注入對話，並在讀取時現算「當時 → 現在」的變化 —— 見[回饋閉環](#回饋閉環) |
| `searchWeb(query)` | Google Custom Search 取得即時時事 |

ReAct 迴圈上限 `Config.TOOL_MAX_ITERATIONS = 5`，且**最後一輪不帶工具定義**，
所以實際上有 4 輪能呼叫工具；同一輪相同參數的工具呼叫會被快取避免重複。
上限不是時間保護：每一輪開始前會檢查 `Utils.execElapsedMs()`，超過 200s 就不再開新輪。

---

## 斜線指令

`Commands.gs` 在 `doPost` 進入 ChatBot **之前**攔截 `/` 開頭的訊息。
Telegram 的指令選單只是 UI 提示——點下去送出的仍是普通文字訊息——所以答案固定的指令
在這裡直接處理掉，省下整個 ReAct 迴圈與一次 LLM 配額。

| 指令 | 行為 |
|---|---|
| `/dashboard` | Telegram 上送出一則帶 Mini App 按鈕的訊息（點按鈕就地開啟面板）；其他平台回傳 `DASHBOARD_URL` |
| `/report` | 立即產生今日早報，只回給發問者（排程版本會跳過週末並推給所有主人） |
| `/refresh` | 立即重算持倉／面板／配置。`持倉` 與 `面板` 的市價是活公式，但 `指標` 與 `配置` 是重算當下寫死的值，而程式讀的「總資產」來自 `指標` —— 13:00 排程也有一班，這支是不想等的時候用的 |

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

由上而下：警示條、總資產與日／週／月變化、投資績效、資產走勢圖（30／90／365 天）、
配置圓環與現金、目標配置偏離、持倉明細、個股累計貢獻。

資料**重用 `Snapshot.gs` 既有的結構化讀取器**（`_holdings` / `_cash` / `_totals` / `_dividends`），
儀表板補的是 `totalSeries()`（走勢）與 `_metrics()`（讀「指標」那張 key-value 表）。
⚠️ **序列讀取器刻意不併進 `collectAll()`**——那份 payload 會整份序列化進 LLM prompt，
灌一年份的逐日資料只是燒 context。`_metrics` 小歸小也一樣不併進去：動 `collectAll` 的形狀
就得同時看 `AdvisorCheck` 與三份報告。

`dividendSeries()` 已經沒有頁面在用——網頁版的兩張股利圖換成績效條裡的「累計股利 + 今年 YoY」，
那兩個數字 `_dividends` 本來就有。函式保留（`test_asset.cjs` 有蓋到），哪天想把圖加回去可以直接接。

**其中三塊的存在理由是「看了會去做事」，不是好看：**

| 區塊 | 來源 | 為什麼要有 |
|---|---|---|
| 警示條 | `metrics.warnings` ＋ 當下的 `priceMissing` ＋ 最新快照 `status` | `Position.replay` 的警告在這一頁**本來沒有出口**。懸空的賣出、抓不到的報價，以前照樣被畫成一張很乾淨的圖。 |
| 投資績效 | `metrics`（指標） | 未實現／已實現／累計股利／淨損益／XIRR 每次重算都算好了卻沒地方顯示，畫面講得出「有多少」，講不出「賺多少」。 |
| 目標配置偏離 | `allocation`（配置） | 全頁唯一回答「下一筆錢該往哪放」的區塊。 |

那裡有兩件事不能破壞：

- **偏離長條不共用 `--up` / `--down`。** 紅漲綠跌是**損益**的語意；某類超配並不等於賠錢。
  偏離用自己那組中性的 `--over` / `--under`。
- **「沒設目標」不等於「目標是 0」。** 沒設目標的分組，`配置` 寫的是空字串（見 目標配置%），
  所以 `renderDeviation` 是用「有沒有 `偏離%` 這個 key」在濾，不是看它的值——
  `_allocation` 會把空儲存格整個丟掉，這個區分才活得下來。

配置**圓環**仍由 `holdings` + `cash` 推導，而非讀 `配置` 工作表，因為那張表的欄位是動態依標題讀取、
結構會變。偏離圖則非讀 `配置` 不可——目標只有那張表知道。

> ⚠️ 「指標」新增一列要改**三個地方**：`Snapshot._metrics`（sheet key → JSON key 是手寫對應的），
> 加上 `DashboardPage.html` 與 `MiniAppPage.html` 兩邊的投資績效區塊。只寫那一列，畫面上不會有任何變化。

#### XIRR 為什麼一直是空的（以及怎麼修好的）

`XIRR（年化）` 空了好幾週，說明欄寫「現金流時間跨度不足」——**兩句都不對**：現金流有 35 筆、
跨 4 天、正負都有。真正的問題是**錨點**：`期初` 列被當成「用成本買進」，於是好幾年累積下來的
獲利被壓進遷移後那幾天裡年化，真正的解落在 r ≈ 2×10¹⁵，而 `Position.xirr` 只在
`[-0.9999, 10]` 找根，夾不住就回 null。

`期初` 是**開帳餘額**，不是買進。所以第一筆現金流改成**錨定日的市值**（`Position._openingValue`
從「每日快照」讀），一輩子的獲利留在開帳餘額裡，XIRR 量的是「自 Iris 開始完整記帳以來」的
資金加權報酬。

- 開帳快照取**嚴格早於**錨定日的最後一天。快照是當天 18:00 寫的、已含當天交易，取當天會讓那些
  交易被算兩次（一次在開帳值裡、一次當流量）。所以 `<= opening.date` 的流量一律跳過
- **沒有快照就不算 XIRR**，不拿成本頂替——那就是上面那個坑
- 未滿 `Position.XIRR_MIN_DAYS`（90 天）留空：5 天賺 0.7% 年化就是 107%。說明欄改放**未年化**的
  期間報酬，那個數字第一天就是真的

⚠️ 算不出來的原因有三種（沒快照／無解／期間太短），由 `Position` 寫進說明欄，經
`_metrics().xirrNote` 傳給兩個前端。以前兩頁各自寫死「現金流跨度不足」，三種情況裡有兩種是騙人的。
**不要再讓前端自己猜原因。**

#### 現值殖利率與成本殖利率

分子同一個（近 12 個月**實際領到**的股利），分母一個用現在市值、一個用投入成本。兩者的比值
恆等於 `市值 ÷ 成本`（= 1 + 未實現報酬率），`T25` 有斷言守著——也就是說成本殖利率並沒有帶來
面板上還沒有的資訊，它在畫面上是因為主人要它。有決策意義的是現值殖利率（機會成本）。

分子有兩條規則：

- **只算現在還持有的標的。** 已出清的部位過去一年照樣發過錢，但它們不在分母裡，算進去會讓
  比率虛高，而且是往好看的方向虛高
- **遷移進來的股利要算**（跟 XIRR 相反）。那些是有真實日期的歷史配息，回溯到 2023 年，
  正是這兩個指標不需要回補券商明細就能用的原因。XIRR 排除錨點之前的流量是因為開帳餘額
  已經含著它們；殖利率問的是另一個問題——這些資產一年吐多少現金——所以不適用

`totalSeries()` 的每個點**只有在那天不是正常「交易日」時**才帶 `status`：一年份的 `"交易日"`
字串會白白吃掉單一 key 90KB 的快取上限，而會改變判讀的本來就只有異常的那幾天。

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

刻意**不是** `DashboardPage.html` 的複製品：手機面板該精簡，由上而下是總資產、投資績效、
走勢、可點的持倉、累計貢獻、現金、預設問題。完整版留在 `/dev`。

兩個介面吃的是**同一份** `Dashboard.getPayload()`，所以不需要新欄位的區塊只花前端的工——
投資績效（`metrics`）與累計貢獻（`holdings`）就是這樣同時上了兩邊。刻意**沒有**搬過來的是
警示條、目標配置偏離與持倉明細表：前兩者是寬版的雙向長條，375px 下就不能讀了，
而表格的位置由可點的持倉清單取代。數字看起來不對時，該去的地方仍然是網頁版。

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
| 每日 04:00 | `dailyCleanUp` | **先**把 consolelog 聚合進 `metrics`，再清過期 STM、60 天前的 alert_log、180 天前的 advice_log、10 天前的 log、30 天前的 chat |
| 每日 09:00 | `dailyReport` | 個人化財經早報（週六改發週報） |
| 每日 10:00 | `marketAlert` | 盤中異動警報（單檔跌幅 > 3% 推播） |
| 每日 14:00 | `marketAlert` | 盤中異動警報（第二次） |
| 每週六 09:00 | `weeklyReport` | 週度績效回顧 |
| 每月 1 日 10:00 | `monthlyReport` | 月度總結 |
| 每日 13:00 | `rebuildAssets` | 收盤後重算持倉／面板／配置 |
| 每日 18:00 | `setData` | 寫入當日快照至新表的 `每日快照`（長表，同日覆寫） |
| 每日 19:00 | `advisorCheckEvening` | 主動顧問感知（讀快照 + 決策，LLM 判斷是否推播） |

⚠️ 這張表是 `Cron.SCHEDULE` 的副本，會漂移。以實際註冊的為準時跑 `listTriggers()`，它會拿 `Cron.SCHEDULE` 與 GAS 上真正的 trigger 逐項比對。

週末跳過的是 `dailyReport`／`weeklyReport`／`marketAlert`／`advisorCheckEvening`；`setData` 仍會寫入並把當天標成「休市」。

---

## 記憶與決策系統

### 兩層記憶

- **短期記憶 (STM)**：有時效（最長 7 天），每次對話與快照都會注入，過期自動清除。適合「目前關注標的」「臨時計畫」等。
- **長期知識 (Knowledge)**：永久保存。注入分兩層 —— `[決策]`／`[目標]`／`[偏好]` 這類「主人立的規矩」**每次都帶上**，其餘才靠關鍵字撈。中文以 bigram 切詞（舊版整句當一個詞，對中文幾乎等於沒作用），標籤命中加權高於內文。

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
| `SHEET_ID` | ✅ | 「資產管理」試算表 ID —— 資產分頁與系統分頁都在這一張。全專案唯一來源，`AssetSchema.SHEET_ID` 是指回這裡的 getter，換表只要改這一個地方 |
| `ADMIN_STRING` | ✅ | 管理員 userId 允許清單，逗號分隔；Telegram 加 `TELEGRAM:` 前綴 |
| `LINE_API_KEY` | ⚙️ | LINE channel access token（用 LINE 時必填） |
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
TOOL_MAX_ITERATIONS: 5     // ReAct 上限（最後一輪不帶工具，實際可呼叫工具的有 4 輪）
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

1. 建立一份空的 Google Sheet，把它的 ID 填進 Script Property `SHEET_ID`。
   **所有分頁都在這一份裡**，不需要第二份試算表。
2. 在 GAS 編輯器設定其餘 Script Properties（見上一節的表格）。
3. 在 GAS 執行 `setupAssetSheet()` —— 依 `AssetSchema.TABS` 建立／補齊所有分頁、
   標題列與公式。冪等，重跑不會疊加。
4. 在 GAS 執行 `setup()`，確認系統分頁與環境變數齊備。
   （`advice_log` / `metrics` / `eval_set` 不必先建，第一次用到時會自己建。）
5. 在 GAS 執行 `setupAllTriggers()`，依 `Cron.SCHEDULE` 建立全部排程。
6. 設定訊息平台的 webhook，指向部署的 `/exec` 結尾網址：
   - **Telegram** — 在 GAS 執行 `setupTelegramWebhook()`
   - **LINE** — 將 `/exec` 網址貼進 LINE Developers 主控台並啟用 webhook
7. 在 GAS 執行 `setupTelegramCommands()`，註冊斜線指令選單（僅 Telegram 需要）。
7. 建立第二個 deployment 給儀表板，取得其 `/dev` 網址並填入 Script Property `DASHBOARD_URL`；
   執行 `checkDashboardAuth()` 確認認證閘門看得到你的身分。
8. 用管理員帳號傳訊息到 Bot，驗證 `doPost` → `ChatBot` → AI 路徑全通。

---

## 法律與免責

Iris 為個人自用工具，不執行任何實際交易、不保證投資報酬，所有分析與通知僅供使用者個人決策參考。
