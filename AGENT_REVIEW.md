# Iris — Agent 架構盤點與改善路線圖

> 這份文件是給**接手改造 Iris 的 AI**看的工作文件，不是給人看的簡介。
> 讀完後你應該能直接從〈Part 3 路線圖〉挑一個階段開工，而不需要再重讀整個 codebase。
>
> 初次撰寫於 commit `ba410b6`，**校準於 `0632f18`（2026-08-08，路線圖跑完後）**。
> 專案地圖看 `CLAUDE.md`，完整說明看 `README.md`，推送前檢查看
> `.claude/skills/pre-push-check/SKILL.md`。**這三份與本文件的分工不要混淆**：
> 本文件講「為什麼要改、往哪裡改」，那三份講「現在是什麼樣子」。
>
> ⚠️ **這份文件會過期，而且過期的代價比註解高** —— 照它開工的人會拿舊前提做一整段工作。
> 上一次校準之間隔了 37 個 commit，期間 D4 被修掉、遷移到新試算表、工具從 12 個變 22 個，
> 而文件全都還停在原處。**動工前先看下面的〈已完成〉，再 `git log --oneline` 掃一眼日期。**
>
> 校準時順手拿掉了所有 `檔名:行號` 的引用，改用函式名。行號保證會爛，而爛掉的行號
> 比沒有行號更糟 —— 它會把人帶到錯的地方，還看起來像是對的。

---

## 已完成（自初版盤點以來）

| 項目 | 初版說 | 現在 |
|---|---|---|
| **D4 兩套讀取器** | `阻擋`，「必須最先修」 | ✅ **已修**。`GoogleSheet` 的資產查詢全部改走 `Snapshot` —— 但做法與初版建議的不同：沒有另開 `Format.gs`，格式化就留在 `GoogleSheet`，它現在是 Snapshot 之上的**格式化層**而不是第二個讀取器 |
| **日期規則抄四份** | 「目前最明顯的結構性債」 | ✅ 已收斂進 `Prompt.systemContext()`，`ChatBot` 與三份報告共用（`AdvisorCheck` 仍用自己的 `ADVISOR_PROMPT`）|
| **資產資料來源** | 舊的 `股票` 試算表（`所有股票`／`面板`／`@所有股票紀錄`…）| ✅ 已遷移到「資產管理」表（`標的`／`交易`／`持倉`／`現金`／`指標`／`每日快照`…），舊表凍結 |
| **`priceMissing` / `dayChangePct` / `ratioOfPortfolio` 進不了 Tools** | D5 的一部分 | ✅ `GoogleSheet.getHoldings` 現在都有輸出（含「⚠️ 市價抓不到，市值不可信」）|
| **提示詞寫「推送 LINE 通知」** | D10 附註 | ✅ 已改（2026-08-08）|
| **假宣稱攔截器看工具名字** | 初版沒提到 | ✅ 已改成看**帳本有沒有真的被寫**（`Utils.noteLedgerWrite`），連帶刪掉 `WRITE_TOOLS`。見 Part 4 最後一條 |

**2026-08-08 一天之內把整份路線圖跑完了**（階段 3 除外，那一項判定不做）。逐項對照：

| 階段／診斷 | 狀態 | 產物 |
|---|---|---|
| 階段 0（D4 + D3）| ✅ | `GoogleSheet` 退成格式化層；`Tools.execute` 回 `{ok, status, text}` 信封 |
| 階段 1（D5 + D8）| ✅ | 【資料時點】、`getHistory` 的狀態標記、`Facts.gs` |
| 階段 2（D7 + D10 + D6）| ✅ | `AdviceLog.gs` + `logAdvice`、人設改寫、中文 bigram 切詞 + 規矩常駐注入 |
| 階段 3（D2）| ❌ 不做 | 改為放寬 `TOOL_MAX_ITERATIONS` 3→5；理由見那節 |
| 階段 4（D9 + D11）| ✅ | `Eval.gs`（判定是純函式）、`Metrics.gs`（每日聚合）|
| 測試 | ✅ | 314 → 441 條，`ChatBot.reply` 首次有測試替身（`T35`）|

⬜ 仍未動：D1（狀態物件）、D2 的 token 收斂、D6 的 STM 那一半。三者目前都不痛。

---

## Part 0 — 先講結論

Iris 目前是一個**能用、穩定、但沒有學習能力的單迴圈 agent**。

它做對的事比多數個人專案多：ReAct 迴圈有逾時預算與收尾策略、provider 有備援、
主動感知層有短路檢查與去重、資料層對 GOOGLEFINANCE 故障有 fallback。這些都不用重做。

初版列的四件事**到 2026-08-08 全部處理完了**：

1. ~~數字沒有時間戳與來源~~ → `Facts` 每則 prompt 帶時點，三支查詢工具各自講清楚時效
2. ~~同一份資料兩套讀取器~~ → `GoogleSheet` 退成 `Snapshot` 之上的格式化層
3. ~~沒有回饋閉環~~ → `advice_log` + `logAdvice`，「後來如何」讀取時現算
4. ~~人設寫的是排版規範~~ → 行為準則移到最前面，排版退到最後

**所以「如果只能做一件事」已經不適用了。** 現在該問的是別的問題 —— 見下面的
〈接下來看哪裡〉。

### 接下來看哪裡

路線圖的四個階段做完了（階段 3 判定不做，理由見那節）。剩下的不是「未完成的計畫」，
而是**做完之後才看得清楚的東西**：

- **先跑基準線再改東西。** `runEval()` 重複執行到 `eval_set` 每列都有時間戳，那是
  第一份可比較的紀錄。在那之前改 `Prompt.gs` 一樣是憑感覺，只是現在有工具而已。
- **`metrics` 累積幾天後再回頭看** `avgTurns` / `maxTurns` / `timeouts`，確認
  `TOOL_MAX_ITERATIONS` 放寬到 5 的實際代價。這是唯一一個「已上線但還沒被量過」的改動。
- **D2 的 token 那一半還在**：模型每輪拿到全部 22 個工具的 schema，多跑兩輪等於多付兩次。
  要解是「依意圖收斂工具集」，不是 plan-then-execute。
- **D1（狀態物件）與 D6 的 STM 那一半**仍未動，兩者目前都不痛。
- **`AssetImport` / `Position` / `DataSync` 這條資料流沒有被這輪盤點碰過。**
  這次的範圍是 `doPost` / `doGet` 的對話與展示路徑；記帳與重算那條只在測試裡被動到。

---

## Part 1 — 現況盤點

### 1.1 三個彼此獨立的 LLM 迴圈

Iris 不是一個 agent，是**三個共用工具與資料層的 agent**，彼此沒有共享狀態：

| 迴圈 | 進入點 | 形態 | 模型檔次 | 有無工具 |
|---|---|---|---|---|
| 對話 | `ChatBot.reply()` | ReAct，最多 5 輪 | FAST（關思考） | 有，22 個 |
| 報告 | `buildDailyReport()` / `weeklyReport()` / `monthlyReport()` | 單趟 prompt | SMART（開思考） | 無，資料預先塞進 prompt |
| 主動感知 | `AdvisorCheck.run()` | 單趟 prompt，要求回 JSON | SMART（開思考） | 無 |

✅ 初版寫「三者各自重複一次日期與年份規則，改一次要改四個地方」—— 那筆債已經還了：
人設、當下時間、日期規則現在只有一份 `Prompt.systemContext()`，`ChatBot` 與三份報告
（它們自己也收斂成 `_generateReport(spec)` 一支）共用。三份報告的差異只剩「餵什麼、問什麼」。

`AdvisorCheck` 仍走自己的 `Prompt.ADVISOR_PROMPT`，沒有吃 `systemContext` —— 它要的是
JSON 輸出與判斷準則，形狀本來就不同。要不要併是個開放問題，但它是**唯一**還留在外面的。

### 1.2 資料流

```
        ┌──────────── 「資產管理」試算表（唯一真實來源，Script Property SHEET_ID）────────────┐
        │ 標的 · 交易 · 持倉 · 現金 · 指標 · 配置 · 每日快照 · 實體資產 · 面板                  │
        │ chat · short_term_memory · knowledge · alert_log · consolelog · env                 │
        └────────────────────────────────┬────────────────────────────────────────────────────┘
                                         │
                              ┌──────────▼───────────┐
                              │ Snapshot.gs          │  唯一的結構化讀取層
                              │ _holdings / _cash /  │
                              │ _totals / _metrics / │
                              │ _dividends / _alloc… │
                              └──┬────────┬───────┬──┘
                                 │        │       │
              ┌──────────────────▼──┐     │       └────────────────┐
              │ GoogleSheet.gs      │     │                        │
              │ **格式化層**          │     │                        │
              │ 結構化 → 給 LLM 的字串 │     │                        │
              └──────┬──────────────┘     │                        │
                     │                    │                        │
          ┌──────────┴────────┐           ▼                        ▼
          ▼                   ▼      AdvisorCheck          Dashboard.getPayload
   Tools.execute()      DailyReport        │                  │          │
          │             （三份報告）         ▼                  ▼          ▼
          ▼                   │       LLM 判斷 JSON      DashboardPage  MiniAppPage
     ChatBot ReAct            │             │             （/dev）      （/exec?view=tg）
          │                   │             │                  │          │
          └───────┬───────────┴─────────────┘                  └────┬─────┘
                  ▼                                                 ▼
         MessagingServiceFactory                             google.script.run
                  │                                                 │
          LINE / Telegram                                        前端圖表
```

✅ **初版在這裡標了 D4（同一份資料兩套讀取器，會漂移），那已經修掉了。**

現在只有一條路：`Snapshot` 是唯一從試算表算出「持倉市值是多少」的地方，`GoogleSheet`
的資產函式退成它上面的**格式化層**（`getHoldings` → `Snapshot._holdings`、`getHistory` →
`totalSeries`、`getDividendHistory` → `AssetSchema.readTrades`、`getDashboard` → `_cash` ＋
直接讀 `指標`／`配置`）。所以聊天回答與儀表板現在吃的是同一份數字。

順帶把初版擔心的三個欄位也帶出去了：`priceMissing`、`dayChangePct`、`ratioOfPortfolio`
現在都會出現在 `getHoldings` 給 LLM 的文字裡。

時間也補上了（D5）：`getHoldings` 開頭有【資料時點】，`getHistory` 逐列標出休市／報價異常，
`Facts` 另外把關鍵數字連同「最後重算」時間直接放進每則 prompt。

### 1.3 對話迴圈的實際控制流

`ChatBot.reply()`（`ChatBot.gs`）逐步拆解：

```
0. 記下 Utils.ledgerWriteCount() 當基準                    ← 假宣稱攔截的地基
1. 讀對話歷史        GoogleSheet.getChatHistory(userId, CHAT_MAX_TURNS * 2)  ← 原文，無摘要
2. 全量讀 STM        GoogleSheet.getValidShortTermMemories()   ← 不做篩選
3. 知識注入        GoogleSheet.knowledgeForPrompt(message)   ← 規矩常駐＋bigram 檢索
4. Facts.build() / AdviceLog.formatForPrompt()            ← 算好的數字＋先前的建議
5. Prompt.systemContext({scope, user, knowledge, stm, facts, advice})
6. for turn in 0..4:
     a. 逾時檢查（Utils.execElapsedMs() > 200s 不再開新輪）
     b. 送 typing
     c. 最後一輪不帶工具定義
     d. 呼叫 LLM（FAST）
     e. 有 functionCall → 全部執行、結果回灌、continue
     f. 有 text → 若宣稱寫入但計數器沒動，打回重做一次；否則結束
6. 沒拿到 text 但有工具結果 → 強制總結（再叫一次 LLM，280s 之後就不叫了）
7. 清 <tool_call> XML → 宣稱寫入但沒寫 → 加警告 → 存對話 → 回傳
```

> 初版這裡寫的是 `HistoryManager.getUserHistory()`。**那個模組不存在**，對話歷史一直
> 是 `GoogleSheet.getChatHistory()` 讀的。這種錯最貴 —— 接手的人會去找一個找不到的檔案。

**輪數**：`TOOL_MAX_ITERATIONS = 5`（`Config.gs`）且最後一輪不帶工具，所以實際有 4 輪能呼叫工具。
⚠️ **上限不是時間保護**：真正守門的是每輪開始前的 `Utils.execElapsedMs()`（200s）。
當初降到 3 是因為那時候輪數是唯一的保護，現在不是了 —— 見 D2 與階段 3。

### 1.4 主動感知迴圈

`AdvisorCheck.run()` 是目前最接近「agent 有自主性」的部分，設計理念寫得很清楚
（程式備料、LLM 判斷、alert_log 去重）：

```
週末跳過 → Snapshot.collectAll() → isQuiet() 短路 → 全量讀決策
        → AlertLog.formatForPrompt(7) 去重脈絡 → LLM 回 JSON → push → 記錄
```

`Snapshot.isQuiet()` 用三條固定門檻（日變動 0.5%、單檔 3%、持倉佔比 50%/2%）短路，
省 token。這是好設計，但門檻是寫死的常數，不會因使用者反應調整。

---

## Part 2 — 用 agent engineering 的框架診斷

以下每一項標了**嚴重度**（阻擋 / 高 / 中 / 低）與對應的改善階段。

### D1 — 沒有狀態物件，也沒有圖　⬜ **仍未動（目前不痛）**

一次對話的所有狀態（contents、calledTools、elapsed、timedOut）都是
`ChatBot.reply()` 裡的區域變數。沒有可序列化的 `AgentState`，因此：

- 無法 checkpoint / resume（GAS 6 分鐘上限下，這其實有價值）
- 無法在迴圈外觀測「這次跑了幾輪、叫了哪些工具、花在哪」
- 三個迴圈無法共用節點

**不建議**為此引入 LangGraph 式的完整框架——GAS 沒有那個生態，而且會讓 6 分鐘上限更難管。
建議只做最小版：一個 plain object 傳遞於各步驟之間。

### D2 — 迴圈預算過緊，且沒有規劃階段　⚠️ **輪數已放寬，token 未處理**

✅ **輪次的部分 2026-08-08 已放寬**：`TOOL_MAX_ITERATIONS` 3 → 5（實際可用工具的輪次
2 → 4）。安全性來自時間關卡而不是輪數 —— 詳見階段 3 那節為什麼不做 plan-then-execute。

⬜ **仍然成立的是 token**：模型每輪都拿到全部 22 個工具的 schema，沒有依意圖收斂，
對話一開始就背負全部工具描述。工具從 12 個長到 22 個之後這件事只有更嚴重，
而且現在多跑兩輪等於多付兩次。這一項要解要靠**收斂工具集**（依意圖只給相關的幾個），
不需要 plan-then-execute 那套架構。

現代做法是 **plan-then-execute**：先用一次便宜的呼叫產生「我需要哪些資料」的清單，
一次把工具全叫完，再進入回答階段。以 Iris 的工具都是唯讀查詢來說特別適合——
它們彼此無依賴，可以平行取，不需要多輪 ReAct。

### D3 — 工具契約是字串，錯誤與空資料無法區分　✅ **已修（「成功但空」刻意保留）**

✅ 2026-08-08：`Tools.execute()` 改回 `{ok, status, text}` 信封，`status` 為
`ok` / `invalid_args` / `error`，`ChatBot` 連同文字一起送給模型，失敗時再補一句
「這是失敗原因不是資料」。詳見 CLAUDE.md〈工具回傳要分得出成功與失敗〉。

⬜ **剩下「成功但查無資料」那一格**，而且刻意留著：那個判斷藏在底層函式回的中文句子裡
（「（尚無持倉資料）」），在信封層認出來只能比對字串 —— 那正是這個信封想消滅的東西。
要做的話得從 `GoogleSheet` / `AssetTools` 一起改，不是在信封上補一個猜出來的欄位。

以下是原本的診斷，留著當背景：

`Tools.execute()` 一律回字串。失敗時回的也是字串
（例如 `GoogleSheet.getHoldings` 的 `'讀取持倉時發生錯誤：' + ex.message`）。

後果：迴圈無法分辨這三種狀況，而它們該有完全不同的處理——

| 狀況 | 現在 | 應該 |
|---|---|---|
| 成功且有資料 | 字串 | 正常使用 |
| 成功但無資料 | 字串「（尚無持倉資料）」 | 告知使用者，不要瞎猜 |
| 工具失敗 | 字串「讀取時發生錯誤…」 | 重試或誠實告知，**絕不能當成事實回給使用者** |

現在模型有機會把「讀取持倉時發生錯誤」當成一段內容拿去總結。

2026-08-08 有一個具體例子說明這件事的代價：假宣稱攔截器本來想問「這個寫入工具成功了嗎」，
但因為 `execute()` 的成功與失敗都是自由文字、分不出來，最後只能繞道去數**帳本被寫了幾次**
（`Utils.noteLedgerWrite`）。那個繞法本身是對的（證據取自寫入本身比取自描述寫入的句子更硬），
但它繞過去的正是 D3。**下一個需要「這次工具到底成功了沒」的功能，會再撞一次同一面牆。**

### D4 — 同一份資料兩套讀取器，會漂移　✅ **已完成**

初版標為`阻擋`、「必須最先修」。已經修掉了，見 1.2。

最終做法與初版建議的不同，值得記下來：**沒有另開 `Format.gs`**。`GoogleSheet` 的資產函式
直接改成呼叫 `Snapshot.*` 再排版，就地退成格式化層。少一個檔案、少一次搬家，
而「只有一個地方定義什麼叫持倉市值」這個目標一樣達成。

初版預期的好處也兌現了：`priceMissing`、`dayChangePct`、`ratioOfPortfolio` 現在都進得了
LLM 的視野。

### D5 — 數字沒有 as-of 與來源　✅ **已完成（2026-08-08）**

`getHoldings` 開頭有【資料時點】把三種時效分開講；`getHistory` 逐列標出休市／報價異常
並統計整段；備援補價的警告跟著持倉一起出去；沒有當日成交價時回 `null` 而不是假的 0%。
`Facts.build()` 另外把總資產等關鍵數字連同「最後重算」時間直接放進每則 prompt。

下面是當初的診斷表，`模型知道嗎` 一欄已更新成現況：

Iris 手上的數字有五種完全不同的時效，全部混在同一段文字裡送進 prompt：

| 資料 | 實際時效 | 模型知道嗎 |
|---|---|---|
| `指標` 的總資產 | **上一次 `Position.rebuild()` 當下**（13:00 排程、記帳、`/refresh`）| ✅ `Facts` 每則 prompt 都帶「資料時點」，`getHoldings` 開頭也講 |
| `每日快照` 的歷史序列 | 每天 18:00 寫一次 | ✅ `getHistory` 逐列標休市／報價異常，並統計整段（含被省略的中段）|
| `持倉` 的市價／市值 | GOOGLEFINANCE 活公式，更新時機不定 | ✅ 【資料時點】明講是活公式、不保證是此刻 |
| TWSE 即時報價（當日漲跌）| 延遲約 20 分鐘，收盤後沒有當日價 | ✅ 沒有當日成交價時回 `null` 而不是 0，輸出明講取不到 |
| `_fillMissingPrices` 補的價 | **死值**，不會自己更新到下次 rebuild | ✅ `指標` 的 `⚠️ 待修正` 跟著持倉一起送出去（以前只有 `getDashboard` 印得到）|

一個專業財經助理**不能**在不講 as-of 的情況下報數字。事實證明成本確實只是在工具輸出加欄位 ——
兩個時間來源本來就存在（`_metrics().lastRebuild`、`每日快照` 的 `狀態`），缺的一直只是把它們
接到輸出上。

⚠️ 初次校準時我把第一列寫成「模型完全看不到」，那是錯的 —— `getDashboard` 逐列印 `指標`，
「最後重算」本來就在裡面。真正的缺口比較窄：**時點沒有跟著數字走**。留著這段是因為
那個錯誤本身有代表性：盤點時很容易把「我沒注意到」寫成「系統沒有」。

### D6 — 記憶是全量注入，不是檢索　✅ **知識層已修（2026-08-08）**

診斷比原本寫的更嚴重：`searchKnowledge` 是 `query.split(/\s+/)`，而**中文沒有空白**，
所以整句是一個詞，只有原文完全出現才算命中 —— 對主要語言而言關鍵字檢索等於沒作用，
而且它回「沒有找到」，跟知識庫真的空的長得一模一樣。

做法就是原本建議的分層，只是把切詞也一起修了：

- `_tokens` 切 CJK bigram，英數字整段保留（代號、ETF 不會被切碎）
- 標籤命中加權 3、內文 1
- `knowledgeForPrompt`（注入用）**一律帶上** `[決策]`／`[目標]`／`[偏好]`，其餘才靠關鍵字；
  `searchKnowledge`（工具用）維持純查詢

**同義詞表刻意不做**（原本的建議之一）：「加碼」與「加倉」沒有共用字，切詞救不了，
而那種表沒人維護就會過期。真正需要被看見的那類知識已經由無條件注入兜底，不看用字。

⬜ **STM 仍是全量注入。** 它有時效、量少，目前不構成雜訊；真的變多再處理。
⬜ 決策清單（`AdvisorCheck._loadDecisions()`）同樣仍是全量讀。

### D7 — 沒有 episodic memory 與回饋閉環　✅ **已完成（2026-08-08）**

`AdviceLog.gs` + `advice_log` 分頁：`AdvisorCheck` 每次推播寫一列，`logAdvice` 工具讓模型
在對話中登記自己給的建議，`ChatBot` 把最近 5 筆注入每則 prompt。

**與原規劃的一處不同：不做排程回填。** 存下建議當下的總資產，「後來如何」在讀取時現算。
少一個 trigger、不會有隔天就過期的死值、也不會有回填失敗留下的空白列。

原本的診斷是「`alert_log` 只用來去重，系統從不記錄我建議過什麼、後來如何」，
而那三句「顧問才說得出的話」現在：第一句本來就做得到（決策有存）；第二、三句
取決於當時有沒有用 `logAdvice` 登記過 —— 登記過就看得到當時的數字與至今的變化。

### D8 — 沒有任何自我檢查　✅ **兩種都有了（2026-08-07 / 08-08）**

原本的建議是「不要再叫一次 LLM 檢查（延遲翻倍），改成用程式算好一份 facts 區塊」。
最後兩條路都走了，因為它們擋的是不同的東西：

- **行為**：模型宣稱「已記錄／已校正」時，`ChatBot` 比對帳本有沒有真的被寫
  （`Utils.noteLedgerWrite`），沒寫就打回去、再不行就加警語。
- **算術**：`Facts.build()` 把關鍵數字算好放進每則 prompt，人設要求原樣引用、
  不准自行加總或換算。沒給它可以算錯的材料，比事後檢查便宜。
- **事後**：`Eval.CHECKS.numbersGrounded` 會查回覆裡的金額能不能在當輪脈絡中找到 ——
  但那是評估用的，不在對話的即時路徑上（會拖慢每一次回覆）。

### D9 — 沒有評估集　✅ **已完成（2026-08-08）**

`Eval.gs`：10 題預設題組＋7 種可自動判定的性質。**判定是純函式所以測得起來**（`T37`），
只有 `runBatch` 需要 LLM，一次跑 3 題、重複執行直到整組跑完 —— 順著 GAS 的 6 分鐘上限設計，
而不是跟它對抗。期望值一律是性質不是答案（「應該回答 142萬」明天就過期）。

### D10 — 人設寫的是排版規範，不是行為準則　✅ **已完成（2026-08-08）**

排版規則移到最後並精簡，開頭換成 `[怎麼回答]`：先講結論、是非題先答是否、
區分事實與判斷、不確定就說不確定並標明時點、主動比對 `[目標]`、
主人焦慮時先承認情緒再回到他自己設的原則。順手修掉提示詞自己違反「嚴禁 Markdown」
那 15 處 `**粗體**` —— 模型會模仿它讀到的格式，指令在跟示範打架。`T33` 釘住這些。

以下是當初的診斷，留著當背景。`Prompt.SYSTEM_PROMPT` 當時的篇幅分配：

- 格式規定（禁 Markdown、全形符號、範例）：約 40%
- 工具選用對照表：約 30%
- 身分/風格/記憶/決策偵測/限制：約 30%

而**顧問行為**幾乎沒有著墨。缺少的行為包括：

- 先講結論，再講理由（目前沒有規定，模型常常鋪陳一大段）
- 明確區分「事實（來自工具）」與「推論（我的判斷）」
- 主動標明不確定性與資料時效
- 主動追蹤先前的建議與使用者設定的目標
- 使用者情緒性發言（虧損焦慮）時的應對方式——這是財經助理的高頻場景，目前完全沒有

✅ 初版另外點名了兩處過時敘述（`SYSTEM_PROMPT` 與 `ADVISOR_PROMPT` 都寫「推送 LINE 通知」），
2026-08-08 已改掉 —— 推播早就走 `MessagingServiceFactory`。

⚠️ 那兩句不是註解，是**餵給模型的文字**，模型會照著它跟主人講話。改 `Prompt.gs` 的時候
要記得：這個檔案裡的每一個字都是會被執行的，過期的敘述在這裡的代價比在註解裡高一級。

### D11 — 觀測性只有日誌，沒有指標　✅ **已完成（2026-08-08）**

`Metrics.rollupDaily()` 把 `consolelog` 聚合成每日一列寫進 `metrics` 分頁：對話數、
平均／最多輪數、耗時、逾時、工具呼叫分布、備援接手、**假宣稱攜截次數**、帳本寫入、錯誤數。

⚠️ 它在 `dailyCleanUp` 裡排在清 `consolelog` **之前** —— 順序倒過來就是丟掉資料再去算它。

---

## Part 3 — 改善路線圖

每個階段都是**可獨立交付、可獨立回滾**的。不要跳階段：階段 1 依賴階段 0 的單一事實來源，
階段 2 依賴階段 1 的 provenance。

> 開工前必讀：`.claude/skills/pre-push-check/SKILL.md`。
> 這個專案 `git push` 會直接部署到生產，沒有 CI 也沒有測試執行器。

---

### 階段 0 — 地基：單一事實來源與工具契約　✅ **兩半都完成了**

**目標**：讓「什麼叫持倉市值」只有一個定義，讓工具回傳可被程式判讀。行為不變。

#### ✅ 已完成的那一半 —— 單一事實來源（D4）

實際做法比初版計畫簡單：**沒有新增 `Format.gs`**，而是讓 `GoogleSheet` 的資產函式
就地改成「呼叫 `Snapshot.*` 再排版」，退成格式化層。`DailyReport` 三份報告因此不必改，
它們照樣叫 `GoogleSheet.getDashboard()` / `getHoldings()`，只是底下換了來源。

初版擔心的風險（`Snapshot._holdings()` 會打 TWSE API，比純讀 sheet 慢）實際沒有成為問題。
`Snapshot._holdings` 本身**沒有**快取 —— `Dashboard.getPayload` 那 15 分鐘的快取是更外面
一層，聊天路徑吃不到。若日後 ReAct 逾時變頻繁，在 `_holdings` 加一層 `CacheService`
（5 分鐘）仍然是正確的下一步，**不要回頭改用直接讀表的版本**。

#### ✅ 另一半 —— 工具契約（D3）

`Tools.execute()` 回 `{ok, status, text}`，`status` 為 `ok` / `invalid_args` / `error`。
`ChatBot` 把 `status` 與 `ok` 一起放進 `functionResponse`（`AIAdapter` 會整個序列化成 JSON，
所以模型看得到），失敗時再補一句「這是失敗原因不是資料」。

**沒有新增 `ToolResult.gs`**，信封就在 `Tools.gs` 裡三個小函式（`ok` / `invalid` / `failed`）——
跟階段 0 前半一樣，不需要為了三行程式開一個檔案。

也**沒有做「成功但空」那一格**：那個判斷藏在底層函式回的中文句子裡，在信封層認出來只能
比對字串，而那正是這個信封要消滅的東西。要做得從 `GoogleSheet` / `AssetTools` 一起改。

⚠️ `Utils.noteLedgerWrite` **沒有**退成第二道證據，維持原樣。原本設想信封做完就可以改用
回傳值判斷有沒有寫入，但那等於把安全檢查綁回「工具說了什麼」——業務規則擋下時工具是
**成功**的（`ok: true`，答案是「不行」），拿它判斷寫入會直接漏掉最該攔的那種情況。
證據取自寫入本身仍然比較硬。

**驗收**：把 `SHEET_ID` 指到一個不存在的 id，問「我有多少持倉」，Iris 要說得出
「我查不到」而不是把錯誤訊息當成內容總結。

---

### 階段 1 — 可信度：讓每個數字都有時間與來源　✅ **已完成（2026-08-08）**

**目標**：Iris 報出的每個數字都能追溯到「什麼時候、哪裡來的」，且不自行推算。

**動這些檔**：`GoogleSheet.gs`（格式化層，不是初版寫的 `Format.gs` —— 那個檔沒有生出來）、
`ChatBot.gs`、`Prompt.gs`、新增 `Facts.gs`

**步驟**：

1. `GoogleSheet` 的每個資產函式輸出開頭加一行 as-of，例如
   `【持倉明細】資料時點：市價 2026-08-08 14:32（TWSE 延遲約 20 分）／總資產 13:02 重算`
   —— 時間不用另外算，`Snapshot._metrics().lastRebuild` 已經讀出來了（見 D5）
2. 新增 `Facts.gs`：用程式算好一份不會錯的關鍵數字表（總資產、各檔市值與佔比、
   當日/週/月變化、現金總額）。這些全部已經在 `Snapshot` 裡，只是要集中成一個區塊。
3. `ChatBot.gs` 的 `systemContext` 加入 `[系統計算的事實]` 區塊，並在
   `Prompt.SYSTEM_PROMPT` 明確要求：**此區塊的數字必須原樣引用，禁止自行推算或換算**。
4. `Prompt.SYSTEM_PROMPT` 加入資料時效準則：報數字必須帶時點；快照與即時價不可混為一談。

**驗收**：
- 問「我現在總資產多少」，回覆必須出現時點，且數字與 `Facts` 完全一致
- 問「00878 佔我多少比例」，回覆的百分比與 `Snapshot` 算的一致（不是模型自己除的）

**風險**：prompt 變長。用 `Config.DEBUG_MODE` 觀察 token 與延遲；
若 FAST 檔次延遲明顯上升，把 `Facts` 精簡成只含前 N 大持倉。

---

### 階段 2 — 人性與記憶：從查詢介面變成顧問　✅ **已完成（2026-08-08）**

**目標**：Iris 記得自己說過什麼，並在後續對話與主動通知中追蹤。

**動這些檔**：新增 `AdviceLog.gs`、新增工作表 `advice_log`、`AdvisorCheck.gs`、
`ChatBot.gs`、`Prompt.gs`、`Tools.gs`

**步驟**：

1. 新增工作表 `advice_log`：`時間 | 來源(chat/advisor/report) | 主題 | 建議摘要 | 當下關鍵指標 | 後續結果 | 使用者反應`
2. 新增 `AdviceLog.gs`：`record()` / `recentByTopic(topic, days)` / `pendingFollowUps()`
3. `AdvisorCheck` 推送成功後，除了寫 `alert_log`，另外寫一筆 `advice_log`
   （帶當下的關鍵指標，供日後回填結果）
4. `ChatBot` 注入「最近的建議與其後續」到 systemContext，讓對話時 Iris 知道自己說過什麼
5. 新增工具 `logAdvice`，讓模型在給出明確建議時主動登記
   （⚠️ 記得 `definitions` 與 `execute` 兩處都要改，見 `pre-push-check`）
6. 每日 19:00 的 `advisorCheckEvening` 前加一步：回填昨日建議的結果
   （用當日快照對照當初記錄的指標）

7. **改寫 `Prompt.SYSTEM_PROMPT` 的行為層**（這步與上面同等重要）：
   - 先講結論，再給理由
   - 明確區分「事實（工具提供）」與「判斷（我的推論）」，判斷要標明依據
   - 不確定就說不確定，不要用模糊語言掩蓋
   - 主人設有 `[目標]` 時，相關對話主動比對現況與目標的差距
   - 主人表達虧損焦慮時：先承認情緒，再回到數據與他自己設定的原則，不說空泛安慰
   - 把〈格式規定〉整段搬到最後，並精簡——它現在佔的篇幅與重要性不成比例
   - ✅「推送 LINE 通知」的過時敘述已於 2026-08-08 修掉，這步不用做了

**驗收**：
- 連續兩天觸發同一條決策，第二天的通知要提到「昨天已提醒過，今天情況變化是…」
- 問「你之前建議我什麼」，Iris 答得出來且有時間
- 設一條 `[目標]`，問相關問題時 Iris 主動指出目前與目標的差距

**風險**：`advice_log` 會持續成長。一開始就寫清理規則（比照 `dailyCleanUp`），
並且 `recentByTopic` 一定要限制筆數，不要全量讀。

---

### 階段 3 — 迴圈升級：plan-then-execute　❌ **不做，理由如下**

2026-08-08 重新檢視時發現這個階段**解決不了它自己宣稱要解決的問題**，而且它的前提
已經不成立。原始內容留在下面當紀錄，但不要照做。

**一、它治不好 D2 講的痛點。** D2 抱怨的是「查持倉 → 看到某檔異常 → 查那檔的新聞 →
綜合回答」這種**串接**推理跑不完。plan-then-execute 是在**看到任何資料之前**先規劃，
所以第二步「看到某檔異常」根本還沒發生 —— 一份事前規劃不可能包含「針對剛才發現的
那一檔去查新聞」。它能加速的是**彼此獨立、可以平行取**的多份資料。

**二、平行取那件事早就做到了。** `ChatBot` 對同一輪的多個 `functionCall` 是全部執行的
（`functionCallParts.forEach`），不是只取第一個。模型本來就可以一次丟三個工具呼叫。

**三、「工具都是唯讀查詢」這個前提已經過期。** 寫這段時是 12 個唯讀工具；現在 22 個裡有
7 個會寫進試算表。把寫入排進事前計畫再盲目執行，會繞過 `recordTrade` 的擋賣超、
繞過「參數齊全才寫」與假宣稱攔截 —— 那些全都建立在「模型看著結果決定下一步」之上。

**實際做的替代方案（2026-08-08）**：把 `TOOL_MAX_ITERATIONS` 從 3 放回 5。

當初降到 3 是因為那個數字**是唯一的時間保護**。現在不是了 —— 每一輪開始前會檢查
`Utils.execElapsedMs()`，超過 200s 就不再開新輪。時間由那道關卡守著，而且它看的是
實際耗時而不是猜的輪數，所以 5 輪與 3 輪的最壞情況一樣長，差別只在跑得快的時候
能多跑幾輪，而那正是串接推理需要的。

✅ **測試替身補上了（`T35`）。** 寫這段時 `ChatBot.reply` 一個測試都沒有；現在有 17 條，
替身只需要兩個 —— 把 `AIServiceFactory.callAPI` 換成可排隊的假回應、把
`MessagingServiceFactory` 換成記事本，其餘（`Tools` / `Facts` / `AdviceLog` / `Utils` /
`Prompt` / `GoogleSheet`）都用真的。涵蓋：一輪作答、工具結果回灌、同一輪多工具、
重複呼叫走快取、最後一輪不帶工具、假宣稱打回與加註、工具失敗、時間關卡。

那組測試做過變異驗證（把「只執行第一個工具」「最後一輪照樣帶工具」「攔截永遠認為有寫」
「拿掉時間關卡」各改壞一次），四個都被抓到。

實際行為仍要看 `consolelog` 的 `totalTurns` / `elapsedMs` 分佈 —— 那是延遲，測試量不到。
`Metrics.rollupDaily()` 每天會把它聚合進 `metrics` 分頁。

以下是原始規劃，僅供參考：

**動這些檔**：`ChatBot.gs`、`Tools.gs`、`Config.gs`

**步驟**：

1. 在 ReAct 之前加一個 **規劃節點**：用 LITE 檔次（目前無呼叫端，正好給它用）
   問模型「回答這個問題需要哪些資料？只回工具名與參數的 JSON 陣列」
2. 一次執行規劃出的所有工具（它們都是唯讀查詢，彼此無依賴，可以全部先取）
3. 帶著全部結果進入回答階段，**不帶工具定義**——變成單趟生成
4. 保留現有 ReAct 作為 fallback：規劃節點失敗或回傳空陣列時走原路
5. 依意圖收斂工具集：規劃階段才需要看到全部 22 個工具的 schema，回答階段完全不用

**驗收**：
- 「幫我分析持倉風險，考慮最近的匯率」這種需要 2~3 種資料的問題，一次答完且資訊完整
- 平均延遲不高於現況（省下的輪次應該足以覆蓋規劃那一次呼叫）

**風險**：這是本路線圖中唯一會**改變主要路徑行為**的階段。務必保留 fallback，
並先用 `env` 加一個開關（比照 `AI_PROVIDER` 的作法）可以隨時切回舊路徑。

---

### 階段 4 — 評估與觀測　✅ **已完成（2026-08-08）**

**目標**：改 prompt 不再憑感覺。

**步驟**：

1. 新增 `Eval.gs` 與工作表 `eval_set`：固定 15~20 題，涵蓋
   查詢類 / 分析類 / 記憶類 / 情緒類 / 資料缺失類
2. 每題定義**可自動判定的性質**（不是期望字串）：
   有無 as-of、有無引用決策、數字是否與 `Facts` 一致、有無使用 Markdown（應為無）、行數是否超限
3. `runEval()` 跑完整組並把結果寫進工作表，可比較不同 prompt 版本
4. `Logger.ai` 的 latency 每日聚合寫入 `metrics` 表：平均輪數、工具呼叫分布、fallback 接手次數、逾時率

**驗收**：改一次 `SYSTEM_PROMPT` 後能跑 `runEval()` 並看到逐題差異。

---

## Part 4 — 不要做的事

這節與路線圖同等重要。以下每一項都是在這個專案脈絡下**明確錯誤**的方向：

- **不要引入向量資料庫或 embedding 檢索。** GAS 沒有這個生態，硬做會變成呼叫外部 API，
  增加延遲與失敗點，而使用者的知識庫只有數十條——關鍵字加 tag 權重就夠了。
- **不要把新東西加進 `Snapshot.collectAll()`。** 那份 payload 會整份序列化進 LLM prompt。
  需要新資料就開獨立函式，參考 `totalSeries()` / `dividendSeries()` 的作法。
- **不要拆成多 agent 互相呼叫。** GAS 單次執行 6 分鐘硬上限，`ChatBot` 已經在
  200s/280s 設了兩道防線。多 agent 會直接撞牆，而且失敗時使用者什麼都收不到。
- **不要為了「更像 LangGraph」而引入節點/邊的抽象。** 需要的是狀態物件與清楚的階段劃分，
  不是一套 DSL。`README.md` 已經說明這個專案的對應關係——那是遷移時的地圖，不是現在要蓋的東西。
- **不要把 `ChatBot` 改成 SMART 檔次。** 使用者在等，開思考的單輪就要 60~90 秒。
  檔次分配（FAST 給對話、SMART 給排程）是刻意的，見 `CLAUDE.md`。
- **不要刪掉那些看起來多餘的防禦**：`MiniAppPage.html` 的底部墊片、
  `NvidiaService` 的退避重試、`AIServiceFactory` 的備援模型、`stripToolCallXml`、
  `Position._fillMissingPrices` 的第三層報價。每一個都對應一次實際發生過的故障。
- **不要把假宣稱攔截改回「模型叫了哪些寫入工具」。** 那是 2026-08-08 之前的作法，
  旗子掀在 `Tools.execute` 之前，所以工具被擋下（賣超）、參數不齊、丟例外時帳本沒動，
  攔截器卻已放行 —— 偏偏那正是最容易出現假「已記錄」的場合。現在證據取自寫入本身
  （`Utils.noteLedgerWrite`）。同理**不要**把它改成攔截所有試算表寫入：`Logger` 與
  `chat` 每次回覆都在寫，全域計數會恆為真，等於把防線關掉又看起來像修好了。
- **不要在文件裡寫 `檔名:行號`。** 這份文件上一版寫滿了行號，37 個 commit 之後幾乎全錯，
  其中一條還指向一個從來不存在的模組（`HistoryManager`）。錯的行號比沒有行號更糟。

---

## 附錄 — 快速定位表

用**函式名**定位，不用行號（見 Part 4 最後一條）。

| 想改什麼 | 看哪裡 |
|---|---|
| 對話迴圈的輪次與逾時 | `ChatBot.reply()` 的 `NEW_TURN_DEADLINE_MS` / `TAIL_CALL_DEADLINE_MS`、`Config.TOOL_MAX_ITERATIONS` |
| 全域的執行時間預算 | `Utils.execElapsedMs()` / `execTimeLeftMs()`（**唯一一支錶**，別再開第二支）|
| 注入給 LLM 的 context | `Prompt.systemContext()`（共用）＋ `ChatBot.reply()` 開頭那段 |
| 工具定義與分派 | `Tools.gs` 的 `definitions` 陣列與 `execute()` 的 switch（**兩處要一起改**）|
| 人設與行為準則 | `Prompt.SYSTEM_PROMPT` |
| 主動感知的判斷準則 | `Prompt.ADVISOR_PROMPT`、`AdvisorCheck.run()` |
| 短路門檻 | `Snapshot.isQuiet()` |
| 結構化資料讀取（唯一來源）| `Snapshot._holdings / _cash / _totals / _metrics / _dividends / _allocation` |
| 給 LLM 讀的文字排版 | `GoogleSheet.getHoldings / getDashboard / getHistory / getDividendHistory`（Snapshot 之上的格式化層）|
| 假宣稱攔截 | `Utils.noteLedgerWrite()` / `ledgerWriteCount()`、`Utils.claimsWriteDone()`、`ChatBot.reply()` 的 `wroteViaTool` |
| 模型檔次與備援 | `Config.NVIDIA_MODELS` / `NVIDIA_FALLBACK_MODEL`、`AIServiceFactory.callAPI()` 的 fallback 段 |
| 排程 | `Cron.SCHEDULE`（唯一事實來源）、`Cron.list()` 比對實際註冊的 |
| 推送前檢查清單 | `.claude/skills/pre-push-check/SKILL.md` |
| 這次盤點的死碼／過期註解紀錄 | `REVIEW_2026-08-08.md` |
