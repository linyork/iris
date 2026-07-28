# Iris — Agent 架構盤點與改善路線圖

> 這份文件是給**接手改造 Iris 的 AI**看的工作文件，不是給人看的簡介。
> 讀完後你應該能直接從〈Part 3 路線圖〉挑一個階段開工，而不需要再重讀整個 codebase。
>
> 撰寫時的 commit：`ba410b6`。動工前先 `git log --oneline -5` 確認落差。
> 專案地圖看 `CLAUDE.md`，完整說明看 `README.md`，推送前檢查看
> `.claude/skills/pre-push-check/SKILL.md`。**這三份與本文件的分工不要混淆**：
> 本文件講「為什麼要改、往哪裡改」，那三份講「現在是什麼樣子」。

---

## Part 0 — 先講結論

Iris 目前是一個**能用、穩定、但沒有學習能力的單迴圈 agent**。

它做對的事比多數個人專案多：ReAct 迴圈有逾時預算與收尾策略、provider 有備援、
主動感知層有短路檢查與去重、資料層對 GOOGLEFINANCE 故障有 fallback。這些都不用重做。

它離「專業財經助理」的距離**不在模型也不在工具數量**，而在四件事：

1. **數字沒有時間戳與來源**——工具回傳的是一團格式化文字，模型無法知道「這個市價是 18:00 的快照還是延遲 20 分鐘的即時報價」，因此也無法誠實地告訴使用者。專業顧問的第一守則是講清楚 as-of。
2. **同一份資料有兩套讀取器**，而且算法不同（`GoogleSheet.getHoldings` vs `Snapshot._holdings`）。LLM 看到的與儀表板看到的可能不一致。
3. **沒有回饋閉環**——`alert_log` 只用來去重，沒有記錄「建議了什麼、後來如何」。所以 Iris 永遠不會變得更懂這個使用者，也永遠說不出「我上個月提醒的那件事後來…」。這是「像個顧問」與「像個查詢介面」的分水嶺。
4. **人設寫的是排版規範不是行為準則**——`Prompt.gs` 的 SYSTEM_PROMPT 有一半篇幅在禁止 Markdown，而「先講結論」「標明不確定性」「區分事實與推論」這些顧問行為只有三行。

**如果只能做一件事**：做〈階段 1〉的 provenance。它成本最低、對「專業感」的影響最直接，而且是後面所有階段的前提。

---

## Part 1 — 現況盤點

### 1.1 三個彼此獨立的 LLM 迴圈

Iris 不是一個 agent，是**三個共用工具與資料層的 agent**，彼此沒有共享狀態：

| 迴圈 | 進入點 | 形態 | 模型檔次 | 有無工具 |
|---|---|---|---|---|
| 對話 | `ChatBot.reply()` | ReAct，最多 3 輪 | FAST（關思考） | 有，12 個 |
| 報告 | `buildDailyReport()` / `weeklyReport()` / `monthlyReport()` | 單趟 prompt | SMART（開思考） | 無，資料預先塞進 prompt |
| 主動感知 | `AdvisorCheck.run()` | 單趟 prompt，要求回 JSON | SMART（開思考） | 無 |

三者各自用字串拼接組 system context，**而且都各自重複了一次「日期與年份規則」**
（`ChatBot.gs:37`、`DailyReport.gs` 內三個函式、`Prompt.ADVISOR_PROMPT`）。
改一次規則要改四個地方——這是目前最明顯的結構性債。

### 1.2 資料流

```
                    ┌──────────────── Google Sheet（唯一真實來源）────────────────┐
                    │ 所有股票 · 面板 · 配置 · @所有股票紀錄 · @股利 · @固定        │
                    │ chat · short_term_memory · knowledge · alert_log · consolelog│
                    └───────┬──────────────────────────────────┬──────────────────┘
                            │                                  │
              ┌─────────────▼──────────────┐      ┌────────────▼─────────────┐
              │ GoogleSheet.gs             │      │ Snapshot.gs              │
              │ 回傳「給 LLM 讀的字串」      │      │ 回傳「結構化 JSON」        │
              │ getHoldings / getDashboard │      │ _holdings / _cash /      │
              │ getHistory / getDividend…  │      │ _totals / _dividends…    │
              └─────────────┬──────────────┘      └────────┬────────┬────────┘
                            │                              │        │
                            ▼                              ▼        ▼
                     Tools.execute()              AdvisorCheck   Dashboard.gs
                            │                          │         MiniApp
                            ▼                          ▼              │
                       ChatBot ReAct              LLM 判斷 JSON        ▼
                            │                          │        google.script.run
                            ▼                          ▼              │
                   MessagingServiceFactory ◄───────────┘              ▼
                            │                                    前端圖表
                    LINE / Telegram
```

**⚠️ 注意圖中左右兩條路徑**：`GoogleSheet.getHoldings()`（`GoogleSheet.gs:402`）與
`Snapshot._holdings()`（`Snapshot.gs:82`）讀同一張 `所有股票`，但：

- `getHoldings` 把整列欄位原樣轉成 `欄名: 值` 字串，不做任何計算
- `_holdings` 自己算 `marketValue = 股數 × 市價`，在 GOOGLEFINANCE 失效時改用 `配置` sheet 的
  「當前價值」補值並標記 `priceMissing`，另外還打 TWSE API 取即時漲跌

也就是說：**主動感知層與儀表板看得到的資料品質旗標與即時漲跌，對話中的 LLM 完全看不到**，
而且兩邊在 GOOGLEFINANCE 故障時會給出不同的數字。這是 D4，優先處理。

### 1.3 對話迴圈的實際控制流

`ChatBot.reply()`（`ChatBot.gs`）逐步拆解：

```
1. 讀對話歷史        HistoryManager.getUserHistory(userId, 5)   ← 最近 5 輪原文，無摘要
2. 全量讀 STM        GoogleSheet.getValidShortTermMemories()    ← ChatBot.gs:28，不做篩選
3. 關鍵字檢索知識     GoogleSheet.searchKnowledge(message)       ← ChatBot.gs:29，substring 比對
4. 字串拼 systemContext                                          ← ChatBot.gs:37
5. for turn in 0..2:                                             ← ChatBot.gs:79
     a. 逾時檢查（200s 不再開新輪）
     b. 送 typing
     c. 最後一輪不帶工具定義                                      ← ChatBot.gs:100
     d. 呼叫 LLM
     e. 有 functionCall → 全部執行、結果回灌、continue
     f. 有 text → 結束
6. 沒拿到 text 但有工具結果 → 強制總結（再叫一次 LLM）             ← ChatBot.gs:205
7. 清 <tool_call> XML → 存對話 → 回傳
```

**關鍵限制**：`TOOL_MAX_ITERATIONS = 3`（`Config.gs:114`）且最後一輪不帶工具，
所以**實際只有 2 輪能呼叫工具**。「查持倉 → 看到某檔異常 → 查新聞找原因 → 綜合回答」
這種三段式推理跑不完，模型會被迫在資訊不足時作答。

### 1.4 主動感知迴圈

`AdvisorCheck.run()` 是目前最接近「agent 有自主性」的部分，設計理念寫得很清楚
（程式備料、LLM 判斷、alert_log 去重）：

```
週末跳過 → Snapshot.collectAll() → isQuiet() 短路 → 全量讀決策
        → AlertLog.formatForPrompt(7) 去重脈絡 → LLM 回 JSON → push → 記錄
```

`Snapshot.isQuiet()`（`Snapshot.gs:458`）用三條固定門檻（日變動 0.5%、單檔 3%、
持倉佔比 50%/2%）短路，省 token。這是好設計，但門檻是寫死的常數，不會因使用者反應調整。

---

## Part 2 — 用 agent engineering 的框架診斷

以下每一項標了**嚴重度**（阻擋 / 高 / 中 / 低）與對應的改善階段。

### D1 — 沒有狀態物件，也沒有圖　｜中｜階段 0

一次對話的所有狀態（contents、calledTools、elapsed、timedOut）都是
`ChatBot.reply()` 裡的區域變數。沒有可序列化的 `AgentState`，因此：

- 無法 checkpoint / resume（GAS 6 分鐘上限下，這其實有價值）
- 無法在迴圈外觀測「這次跑了幾輪、叫了哪些工具、花在哪」
- 三個迴圈無法共用節點

**不建議**為此引入 LangGraph 式的完整框架——GAS 沒有那個生態，而且會讓 6 分鐘上限更難管。
建議只做最小版：一個 plain object 傳遞於各步驟之間。

### D2 — 迴圈預算過緊，且沒有規劃階段　｜高｜階段 3

實際只有 2 輪可呼叫工具（見 1.3）。而且模型每輪都拿到全部 12 個工具的 schema，
沒有依意圖收斂——對話一開始就背負全部工具描述的 token。

現代做法是 **plan-then-execute**：先用一次便宜的呼叫產生「我需要哪些資料」的清單，
一次把工具全叫完，再進入回答階段。以 Iris 的工具都是唯讀查詢來說特別適合——
它們彼此無依賴，可以平行取，不需要多輪 ReAct。

### D3 — 工具契約是字串，錯誤與空資料無法區分　｜高｜階段 0

`Tools.execute()`（`Tools.gs:145`）一律回字串。失敗時回的也是字串
（例如 `GoogleSheet.getHoldings` 的 `'讀取持倉時發生錯誤：' + ex.message`）。

後果：迴圈無法分辨這三種狀況，而它們該有完全不同的處理——

| 狀況 | 現在 | 應該 |
|---|---|---|
| 成功且有資料 | 字串 | 正常使用 |
| 成功但無資料 | 字串「（尚無持倉資料）」 | 告知使用者，不要瞎猜 |
| 工具失敗 | 字串「讀取時發生錯誤…」 | 重試或誠實告知，**絕不能當成事實回給使用者** |

現在模型有機會把「讀取持倉時發生錯誤」當成一段內容拿去總結。

### D4 — 同一份資料兩套讀取器，會漂移　｜阻擋｜階段 0

見 1.2。這是**必須最先修**的一項，因為後面所有「讓數字可信」的工作都建立在
「只有一個地方定義什麼叫持倉市值」之上。

修法很直接：讓 `Tools` 的資產查詢改成呼叫 `Snapshot.*` 取結構化資料，再交給一個
格式化函式轉成給 LLM 看的文字。`GoogleSheet` 的字串版逐步退役。
好處是 LLM 立刻獲得 `priceMissing`、`dayChangePct`、`ratioOfPortfolio` 這些它現在看不到的欄位。

### D5 — 數字沒有 as-of 與來源　｜阻擋｜階段 1

Iris 手上的數字有三種完全不同的時效：

| 資料 | 實際時效 | 目前有告訴模型嗎 |
|---|---|---|
| `@所有股票紀錄` 總資產 | 昨日或今日 18:00 的快照 | ❌ |
| TWSE 即時股價 | 延遲約 20 分鐘，收盤後是昨收 | ❌（`isClosed` 只在 Snapshot 內部） |
| `面板` / `所有股票` 的公式值 | 取決於 GOOGLEFINANCE 更新時機 | ❌ |
| `配置` sheet 的回補值 | 可能是舊值 | ❌（`priceMissing` 沒進 Tools） |

一個專業財經助理**不能**在不講 as-of 的情況下報數字。這一項改完，Iris 的「專業感」
會有立即可感的提升，而且成本只是在工具輸出加欄位。

### D6 — 記憶是全量注入，不是檢索　｜中｜階段 2

- STM：`ChatBot.gs:28` 全量灌入，沒有相關性篩選。條目一多就是純雜訊。
- 長期知識：`searchKnowledge(message)` 是中文 substring 比對，語意檢索能力接近零。
  使用者問「我可以加碼嗎」不會命中 tag 為 `[偏好] 投資工具限制` 的條目。
- 決策清單：`AdvisorCheck._loadDecisions()` 全量讀，目前條目少所以沒事。

GAS 沒有向量資料庫，**不要**試圖引入。務實作法是分層：決策/偏好類常駐注入（量少、價值高），
其餘用改良的關鍵字（加上 tag 權重、同義詞表）檢索。

### D7 — 沒有 episodic memory 與回饋閉環　｜高｜階段 2

**這是「像顧問」與「像查詢介面」的分水嶺。**

現在 `alert_log` 只被 `AlertLog.formatForPrompt(7)` 用來避免重複通知。系統從不記錄：

- 我建議過什麼
- 使用者接受了嗎
- 後來結果如何

所以 Iris 說不出以下這些**顧問才說得出的話**：

> 「你 3 月設的 [決策] 00631L 加倉條件，今天第一次觸發。」（做得到，決策有存）
> 「上次我提醒 00646 匯率風險之後，新台幣又升了 1.2%，這次影響比上次大。」（做不到）
> 「你上個月說要把現金比例降到 20%，目前 31%，兩個月沒有動作，要調整目標還是計畫？」（做不到）

需要一張 `advice_log`：時間、主題、建議、當下關鍵指標、後續回填的結果。

### D8 — 沒有任何自我檢查　｜中｜階段 1

單趟產出，沒有校驗。LLM 在散文中做算術是已知的高風險行為。

**不建議**用「再叫一次 LLM 檢查」——那會讓延遲翻倍，而 ChatBot 的時間預算已經很緊。
建議用程式算好一份 `facts` 區塊（總資產、各檔市值與佔比、當日變化），
在 prompt 中明確標示「以下數字為系統計算，回覆時必須原樣引用，不得自行推算」。
這比事後檢查便宜且有效。

### D9 — 沒有評估集　｜中｜階段 4

每次改 prompt 都是憑感覺，改壞了也不知道。需要一組固定問題 + 期望性質
（不是期望字串——是「有沒有講 as-of」「有沒有引用決策」這類可自動判定的性質）。

### D10 — 人設寫的是排版規範，不是行為準則　｜高｜階段 2

`Prompt.SYSTEM_PROMPT`（`Prompt.gs:8`）目前的篇幅分配：

- 格式規定（禁 Markdown、全形符號、範例）：約 40%
- 工具選用對照表：約 30%
- 身分/風格/記憶/決策偵測/限制：約 30%

而**顧問行為**幾乎沒有著墨。缺少的行為包括：

- 先講結論，再講理由（目前沒有規定，模型常常鋪陳一大段）
- 明確區分「事實（來自工具）」與「推論（我的判斷）」
- 主動標明不確定性與資料時效
- 主動追蹤先前的建議與使用者設定的目標
- 使用者情緒性發言（虧損焦慮）時的應對方式——這是財經助理的高頻場景，目前完全沒有

另外有兩處**已過時**的敘述需要修：
`SYSTEM_PROMPT` 的〈決策偵測〉寫「主動推送 LINE 通知」，`ADVISOR_PROMPT` 也寫
「push LINE 通知」——現在主力是 Telegram，且 `/dashboard` 已有 Mini App。

### D11 — 觀測性只有日誌，沒有指標　｜低｜階段 4

`Logger.ai()` 有記 latency，但沒有聚合。無法回答「這週平均幾輪收斂」「哪個工具最常被叫」
「fallback 模型接手了幾次」。`consolelog` 每 10 天清空，資料就這麼丟了。

---

## Part 3 — 改善路線圖

每個階段都是**可獨立交付、可獨立回滾**的。不要跳階段：階段 1 依賴階段 0 的單一事實來源，
階段 2 依賴階段 1 的 provenance。

> 開工前必讀：`.claude/skills/pre-push-check/SKILL.md`。
> 這個專案 `git push` 會直接部署到生產，沒有 CI 也沒有測試執行器。

---

### 階段 0 — 地基：單一事實來源與工具契約

**目標**：讓「什麼叫持倉市值」只有一個定義，讓工具回傳可被程式判讀。行為不變。

**動這些檔**：`Tools.gs`、新增 `ToolResult.gs`、新增 `Format.gs`、`GoogleSheet.gs`（退役字串版）

**步驟**：

1. 新增 `ToolResult.gs`，定義統一信封：
   ```js
   { ok: true|false, data: <結構化>, error: '', asOf: '2026-07-28 18:00', source: '@所有股票紀錄' }
   ```
2. 新增 `Format.gs`，把結構化資料轉成給 LLM 讀的文字（原本散在 `GoogleSheet` 各函式裡的排版邏輯搬過來）。
3. `Tools.execute()` 的資產查詢改走 `Snapshot.*` + `Format.*`：
   - `getHoldings` → `Snapshot._holdings()` → 格式化（**新增** `priceMissing` / `dayChangePct` / `ratioOfPortfolio` 的呈現）
   - `getDashboard` → `Snapshot._totals()` + `_cash()` + `_allocation()`
   - `getHistory` → `Snapshot.totalSeries(days)`
   - `getDividendHistory` → `Snapshot._dividends()` + `dividendSeries()`
4. `GoogleSheet` 的字串版標記 `@deprecated`，等確認沒有呼叫端後刪除。
   ⚠️ `DailyReport` 系列目前直接呼叫 `GoogleSheet.getDashboard()` / `getHoldings()`，一併改。

**驗收**：
- 對 Iris 說「查持倉」，回覆中出現的市值與 `/dev` 儀表板一致（目前 GOOGLEFINANCE 失效時會不一致）
- 刻意把 `所有股票` 的某個市價欄改成 `#N/A`，Iris 應該說得出「這檔的市價是用配置表回補的」

**風險**：`Snapshot._holdings()` 會打 TWSE API，比原本純讀 sheet 慢。
若 ReAct 逾時變頻繁，在 `Snapshot._holdings` 加一層 `CacheService`（5 分鐘），
不要回頭改用字串版。

---

### 階段 1 — 可信度：讓每個數字都有時間與來源

**目標**：Iris 報出的每個數字都能追溯到「什麼時候、哪裡來的」，且不自行推算。

**動這些檔**：`Format.gs`、`ChatBot.gs`、`Prompt.gs`、新增 `Facts.gs`

**步驟**：

1. `Format.gs` 的每個輸出開頭加一行 as-of，例如
   `【持倉明細】資料時點：市價 2026-07-28 14:32（TWSE 延遲約 20 分）／成本 取自試算表`
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

### 階段 2 — 人性與記憶：從查詢介面變成顧問

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
   - 順手修掉「推送 LINE 通知」的過時敘述（`SYSTEM_PROMPT` 與 `ADVISOR_PROMPT` 各一處）

**驗收**：
- 連續兩天觸發同一條決策，第二天的通知要提到「昨天已提醒過，今天情況變化是…」
- 問「你之前建議我什麼」，Iris 答得出來且有時間
- 設一條 `[目標]`，問相關問題時 Iris 主動指出目前與目標的差距

**風險**：`advice_log` 會持續成長。一開始就寫清理規則（比照 `dailyCleanUp`），
並且 `recentByTopic` 一定要限制筆數，不要全量讀。

---

### 階段 3 — 迴圈升級：plan-then-execute

**目標**：解除「只有 2 輪能用工具」的限制，同時降低延遲。

**動這些檔**：`ChatBot.gs`、`Tools.gs`、`Config.gs`

**步驟**：

1. 在 ReAct 之前加一個 **規劃節點**：用 LITE 檔次（目前無呼叫端，正好給它用）
   問模型「回答這個問題需要哪些資料？只回工具名與參數的 JSON 陣列」
2. 一次執行規劃出的所有工具（它們都是唯讀查詢，彼此無依賴，可以全部先取）
3. 帶著全部結果進入回答階段，**不帶工具定義**——變成單趟生成
4. 保留現有 ReAct 作為 fallback：規劃節點失敗或回傳空陣列時走原路
5. 依意圖收斂工具集：規劃階段才需要看到全部 12 個工具的 schema，回答階段完全不用

**驗收**：
- 「幫我分析持倉風險，考慮最近的匯率」這種需要 2~3 種資料的問題，一次答完且資訊完整
- 平均延遲不高於現況（省下的輪次應該足以覆蓋規劃那一次呼叫）

**風險**：這是本路線圖中唯一會**改變主要路徑行為**的階段。務必保留 fallback，
並先用 `env` 加一個開關（比照 `AI_PROVIDER` 的作法）可以隨時切回舊路徑。

---

### 階段 4 — 評估與觀測

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
  `NvidiaService` 的退避重試、`AIServiceFactory` 的備援模型、`stripToolCallXml`。
  每一個都對應一次實際發生過的故障。

---

## 附錄 — 快速定位表

| 想改什麼 | 看哪裡 |
|---|---|
| 對話迴圈的輪次與逾時 | `ChatBot.gs:79`、`Config.gs:114` |
| 注入給 LLM 的 context | `ChatBot.gs:28-55` |
| 工具定義與分派 | `Tools.gs:8`（definitions）、`Tools.gs:145`（execute）|
| 人設與行為準則 | `Prompt.gs:8` |
| 主動感知的判斷準則 | `Prompt.gs:89`、`AdvisorCheck.gs:18` |
| 短路門檻 | `Snapshot.gs:458` |
| 結構化資料讀取 | `Snapshot.gs:82`（持倉）、`Snapshot.gs:_cash / _totals` |
| 字串版資料讀取（待退役） | `GoogleSheet.gs:402` 起 |
| 模型檔次與備援 | `Config.gs` 的 `NVIDIA_MODELS`、`AIServiceFactory.gs:71` |
| 推送前檢查清單 | `.claude/skills/pre-push-check/SKILL.md` |
