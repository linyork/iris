---
name: find-nim-model
description: 當 Config.gs 裡設定的 NVIDIA NIM 模型（NVIDIA_DEFAULT_MODEL / NVIDIA_MODELS 各 tier / NVIDIA_FALLBACK_MODEL）下架、過載或想找更合適的模型時，查詢 NIM 目錄找候選並實測到能下決定為止。觸發詞：「找備援模型」「這個模型還在嗎」「換一個 NIM 模型」「模型下架了幫我找替代」。
---

# 尋找並實測 NIM 替代模型

## 背景

`NVIDIA_API_BASE`（`https://integrate.api.nvidia.com/v1`）上的模型會被 NVIDIA 單方面下架
（回 404/410），沒有任何主動通知——通常是呼叫失敗當下才發現。這份 skill 是 2026-08-05
`NVIDIA_FALLBACK_MODEL`（`mistralai/ministral-14b-instruct-2512`，已於 2026-07-27 下架）
找替代品時走過一遍的完整路徑，包含當時踩到的每一個坑。

**核心心法：目錄只能用來產生候選，不能用來下決定。** 能不能用一定要實測。

## 步驟一 — 確認現況

讀 [Config.gs](../../../Config.gs) 裡目前指到的所有 NIM 模型 id：`NVIDIA_DEFAULT_MODEL`、
`NVIDIA_MODELS`（LITE/FAST/SMART 三個 tier）、`NVIDIA_FALLBACK_MODEL`。
記下要替換的是哪一個、以及它原本承擔的角色。

## 步驟二 — 查詢目前 NIM 目錄

```
WebFetch: https://integrate.api.nvidia.com/v1/models
prompt: "Extract EVERY model id from the data array, one per line, verbatim, no summarization or omission. Do not skip any entries even if there are 100+."
```

這個 endpoint **不需要 API key**（只有實際打 completion 才要驗證），但預設會被 WebFetch 的
摘要模型壓縮——清單上百個，摘要一定會漏，prompt 務必明確要求「逐行、不省略」。

比對現況：要換的那顆是否真的不在清單上了（還在的話問題可能是過載而非下架），
順便檢查其他還在用的 id 是不是也消失了，一併回報。

## 步驟三 — 產生候選清單

`/v1/models` 只回 `id` / `object` / `created` / `owned_by`，**不含任何能力或可用性資訊**。
依角色套用不同標準，湊 8~10 顆、**橫跨不同家族**（Meta / Mistral / NVIDIA / OpenAI / Google / 智譜），
不要押寶單一供應商：

- **`NVIDIA_FALLBACK_MODEL`**（主模型掛掉時頂上，使用者在等）：思考可關、原生 function
  calling、體型小求快、中文可用
- **`NVIDIA_MODELS.FAST`**：同上
- **`NVIDIA_MODELS.SMART`**：背景排程，可用思考模型，品質優先於速度

**清單裡一定要放一顆現役模型當對照組**（例如 `deepseek-ai/deepseek-v4-flash`）。
它若也失敗，代表是 API key / 網路 / NIM 整體壅塞的問題，不是候選模型的問題——
沒有對照組時很容易把壅塞誤判成模型不可用。

## 步驟四 — 實測（**這步是重點，不能跳**）

測試進入點寫在 [DevTools.gs](../../../DevTools.gs)（依 `devtools-gs-convention`：
手動執行的函式一律放那裡）。**Claude 不能自己執行 GAS**——這個專案沒開 API executable
部署，只能 `clasp push` 後請使用者從 GAS 編輯器的下拉選單跑，再把輸出貼回來。

### 四條硬規則（每一條都是踩過才知道的）

1. **一律 `UrlFetchApp.fetchAll()` 並行，絕不串列 for 迴圈。**
   NIM 單次呼叫遠比想像慢：冷啟動或壅塞時單顆 36~46 秒。串列跑 10 顆必定撞上
   **GAS 的 6 分鐘上限**，而逾時會把整段 log 一起吃掉，等於白跑。

2. **NIM 的閘道逾時是固定 ~300 秒，而 `fetchAll` 會等整批。**
   一顆卡住就吃滿 5 分鐘、綁死整批（實測兩次，兇手分別是 `mistral-medium-3.5-128b`
   和 `z-ai/glm-5.2`）。所以**探測與能力測試必須是兩支不同的函式**：先探測找出壞蘋果，
   能力測試只放已確認會回應的模型。

3. **每一支都要有時間預算與提早退場**（`DEADLINE_MS` 約 4.5 分鐘，留 1.5 分鐘收尾），
   時間不夠就印出「還沒測的是哪些」再 return。乾淨地少測幾顆，遠勝逾時把已測結果一起賠掉。

4. **失敗原因要當場印出來，不要只依賴 consolelog。**
   `NvidiaService.callAPI` 失敗只回 `null`，原因寫進 consolelog 分頁——但那個分頁會截斷、
   常拿不到最新幾筆。探測階段直接用原始 `UrlFetchApp` 打並印出 HTTP 狀態碼與 body。

### 關卡一 — 可用性（全部並行，最小請求 `max_tokens: 16`）

⚠️ **目錄列得出來 ≠ 這個帳號打得到。** 實測 `nv-mistralai/mistral-nemo-12b-instruct`
目錄上有，實打回：

```
404 {"detail":"Function '<uuid>': Not found for account '<hash>'"}
```

NIM 的目錄是全域的，可用性是綁帳號的。所以第一關永遠是「打不打得到」。
狀態碼判讀：`404` 帳號無權 → 淘汰；`410` 已下架 → 淘汰；`503`/`504`/`529` 過載或逾時 →
可能只是當下壅塞，但會拖垮批次，先移出後續測試。

### 關卡二 — Function Calling（並行）

拿**真實的工具定義**測，不要自己捏一個 schema：

```js
var toolDef     = Tools.getDefinitions().filter(d => d.name === 'getHistory');
var openaiTools = AIAdapter.convertToolsToOpenAI(toolDef);
```

（`Tools.definitions` 是私有變數，對外只有 `Tools.getDefinitions()`。）

三種結果，中間那種最危險：

- ✅ 有 `tool_calls` 且參數型別正確
- ⚠️ **有 `tool_calls` 但型別錯**（實測 `llama-3.1-8b` 把 `days` 傳成字串 `"7"`，schema 明明是
  `number`）——不會報錯，只會讓下游算出怪結果，比失敗更難查
- ❌ **沒有 `tool_calls`，卻回「好的，我現在幫你查詢…」**（實測 `mistral-nemotron`）——
  這是最惡劣的失敗模式：接手早報會產出語氣正常但數字全是編的內容

### 關卡三 — 思考開關（並行，把診斷攤開）

思考模型的推理文字走 `reasoning_content`，而且**會吃掉 `max_tokens` 預算**——預算太小時
`content` 直接是 `null`。所以每個案例都要印出 `finish_reason` / `completion_tokens` /
`reasoning_content` 長度，才分得清「關不掉」還是「預算不夠」。

**NIM 沒有統一的關思考開關，每家形狀都不同**，實測結果：

| 模型家族 | 有效寫法 | 驗證 |
|---|---|---|
| `deepseek-ai/deepseek-v4*` | `chat_template_kwargs: { thinking: false }` | 現役 |
| `z-ai/glm*` | `chat_template_kwargs: { enable_thinking, clear_thinking }` | 現役 |
| `nvidia/*nemotron*` | **system 訊息內容放 `/no_think`** | reasoning 493 → 0 |
| `openai/gpt-oss*` | **top-level `reasoning_effort: 'low'`** | reasoning 1036 → 68 |

⚠️ gpt-oss 只吃 **top-level**：放 `chat_template_kwargs` 裡無效，放 system 訊息
（`Reasoning: low`）也無效，兩種都試過都是推理量不降反升。**一種寫法沒生效不代表模型
不支援，先換寫法再下結論。**

⚠️ Nemotron 走 system 訊息這條路，跟 iris 既有架構會撞：`Prompt.systemContext` 已經送了
一則 system 訊息，`/no_think` 必須**併進既有 system 內容**，不能另外多送一則。

### 關卡四 — 忠實轉述（決選，並行）

**這關才是真正在測 iris 要它做的事。**

⚠️ 不要考模型的內建知識（第一次做這件事時問了「台股交易時間」，七顆有六顆答錯，
但那個結果沒有意義）——iris 的數字全部從試算表和 `searchWeb` 餵進 prompt，模型記不記得
台股幾點開盤根本不重要。要測的是：**給它資料，它能不能忠實轉述。**

作法：在 prompt 裡給一份小小的持股資料，要求用繁體中文寫 80 字內的損益摘要、
只准用給它的數字。**在測試輸出的開頭把正確答案印出來**（市值合計、總成本、損益），
一眼就能對。

⚠️ **測試資料必須是捏造的。** `DevTools.gs` 會進 git，主人的真實金額不得入庫
（見 CLAUDE.md「No real figures in git」）。

這關刷掉的東西，前三關完全看不出來——實測兩顆 Nemotron（49B 與 9B 都一樣）
把 `68000 − 65000` 算成 23000，再一路推導出「總損益 −5000」（正解 +15000），
語氣專業、格式完整、數字全錯。**對一個報損益的機器人，這一項一票否決，跟體型無關。**

## 步驟五 — 呈現結果，等使用者決定

把四關結果整理成一張表給使用者。誠實標註限制：**每個案例只跑一次（n=1）**，
偶發性不能完全排除；但像「算錯減法」這種，對財務用途即使偶發也該一票否決。

使用者選定後才動手改 [Config.gs](../../../Config.gs)，並確認連帶的事：

- **`NvidiaService.gs` 的思考分流可能要加一條新分支**（上面那張表的形狀各不相同）。
  漏了這一步，模型換了但思考關不掉，備援會比主模型還慢。
- **更新該模型上方的中文註解**。原本寫「非思考的 dense 模型、原生 Function Calling、含繁中」
  這類描述，換模型後不跟著改，註解就會說謊。
- `pre-push-check` skill 的「如果 Config.gs 有變動」那組檢查會在 push 前再確認一次
  模型是否還活著——兩者互補，不要互相取代。
