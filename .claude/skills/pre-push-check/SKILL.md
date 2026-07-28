---
name: pre-push-check
description: 推送前一致性檢查。檢查這次改動有無遺漏配套修改，例如新增工具忘了更新 README 工具表、加了斜線指令忘了跑 setupTelegramCommands()、動了 Snapshot 卻污染到 LLM prompt 等。觸發詞：「push 前確認」、「推送前檢查」、「幫我看看有沒有漏」。
---

# Iris 推送前一致性檢查

這個專案沒有 CI 也沒有本地測試執行器，而且 `.git/hooks/pre-push` 會在推上 `main` 時
**自動執行 `clasp push` + `clasp deploy`**——`git push` 等於直接上生產。
執行以下清單，有問題立即指出並等修完再繼續。

## 步驟一 — 確認本次改動範圍

```bash
git diff --name-only HEAD
```

列出所有有變動的檔案，以此為基礎做後續檢查。

## 步驟二 — 依改動類型逐項檢查

### 如果 `Tools.gs` 有變動
Tools.gs 是 **switch 分派**（`definitions` 陣列 + `execute` 的 case），兩處必須手動同步：

- [ ] **definitions**：新工具有完整的 `name` / `description` / `parameters` schema
- [ ] **execute**：`switch` 內有對應的 `case`（漏掉＝模型叫得出來但一律回「未知的工具」）
- [ ] **必填參數檢查**：`case` 內有擋 `args` 缺漏並回傳可讀訊息，而不是讓底層丟例外
- [ ] **實作**：底層函式確實存在（多半在 `GoogleSheet.gs` / `StockPrice.gs` / `WebSearch.gs`）
- [ ] **文件**：`README.md` 的「AI 工具集」表格與工具總數、`CLAUDE.md` 的工具清單同步更新

### 如果 `Commands.gs` 有變動
- [ ] **definitions**：新指令有 `name` / `description` / `handler`
- [ ] **提醒**：push 後需從 GAS 編輯器手動執行一次 `setupTelegramCommands()`，否則 Telegram 選單不會更新
- [ ] **回傳約定**：`tryHandle` 對「不是指令」必須回 `null`（回空字串會讓 `doPost` 誤判為已處理，訊息就此消失）
- [ ] **耗時指令**：若 handler 會呼叫 LLM，必須先送一則實體訊息（typing 狀態只有 5 秒）

### 如果 `Snapshot.gs` 有變動
- [ ] **⚠️ `collectAll()` 的回傳會整份序列化進 LLM prompt**。新增的欄位若是長序列（逐日資料、完整明細），
      必須做成獨立函式給呼叫端自己拿，不要併進 `collectAll()`——參考 `totalSeries()` / `dividendSeries()`
- [ ] `Dashboard.getPayload()` 有沒有需要跟著補

### 如果 `Main.gs` 的觸發器相關有改動
- [ ] **提醒**：push 後需從 GAS 編輯器手動執行一次 `setupAllTriggers()`，否則新的排程不會生效
- [ ] `setupAllTriggers()` 會**先清掉所有舊 trigger 再重建**，確認新增的排程有寫進去

### 如果 `Main.gs` 的 `doGet` / `Dashboard.gs` / `DashboardPage.html` 有改動
- [ ] **認證閘門**：`doGet` 開頭必須有 `Dashboard.isAuthorized()`，webhook 部署是 `ANYONE_ANONYMOUS`，
      少了它等於把資產數字掛在公開網址上
- [ ] **`addMetaTag` 白名單**：只接受 `viewport` / `apple-mobile-web-app-capable` /
      `mobile-web-app-capable` / `google-site-verification`，其餘（如 `theme-color`）會直接丟例外
- [ ] **檔名不得與 `.gs` 撞名**：GAS 的檔名不含副檔名，`Dashboard.html` 會與 `Dashboard.gs` 衝突而 push 失敗
- [ ] **HTML 內的 `<meta>` 會被 GAS 忽略**，viewport 只有 `addMetaTag` 那份生效

### 如果 `MiniApp.gs` / `MiniAppPage.html` 有改動
- [ ] **`doGet(?view=tg)` 回的頁面必須不含任何資料**——它掛在匿名 `/exec` 上，是公開的。
      資料只能由 `miniAppData` / `miniAppAsk` 在 `verifyInitData` 通過後才發
- [ ] **驗簽通過 ≠ 有權限**：`verifyInitData` 內仍要跑 `Utils.checkMaster`
- [ ] **重放保護**：`auth_date` 逾時檢查不能拿掉，`initData` 本身永不過期
- [ ] `Telegram.WebApp.sendData()` **不能用**——它只對 reply keyboard 按鈕開啟的 Mini App 有效，
      inline 按鈕與選單按鈕都不行。要回傳資料一律走 `google.script.run`
- [ ] 前端配色用 `--tg-theme-*`，但漲跌色維持紅漲綠跌（語意，不隨主題）

### 如果 `appsscript.json` 有變動
- [ ] **新增 oauthScopes 會讓既有授權失效**，排程 trigger 會開始噴 "Authorization required"。
      push 後必須進 GAS 編輯器手動執行任一函式重新授權
- [ ] `webapp.access` 維持 `ANYONE_ANONYMOUS`（webhook 需要），不要為了儀表板改動它

### 如果 `Config.gs` 有變動
- [ ] Model 名稱/tier 仍有效（`NVIDIA_MODELS` 裡的 model 在 NIM 目錄上還活著）
- [ ] 換主模型時，`NVIDIA_FALLBACK_MODEL` 也要確認還活著
- [ ] V4 系列必須送 `chat_template_kwargs`，省略會讓 NIM **掛住而不是報錯**
- [ ] 新增 Script Property → `README.md` 的環境設定表格要同步

### 如果 `GoogleSheet.gs` / `DataSync.gs` 有變動
- [ ] 新增或改名工作表 → `setup()` 的 `requiredSheets`、`README.md` 與 `CLAUDE.md` 的資料表列表同步
- [ ] 讀取大表時有限制範圍，沒有整張 `getValues()` 全載

## 步驟三 — 文件同步檢查（gate，預設一句話帶過）

這是收尾反射，**不是每次都認真稽核**。此刻 diff 與改動理由本來就在 context 裡，判斷幾乎不花成本。
先問一句 gate：

**這次 diff 有沒有動到「契約 / 地圖」層級的東西？**
（層職責、工具集、指令集、觸發器時程、記憶模型、Config key、provider 行為、Sheet schema、
部署與存取模型）

- **沒有**（多數情況：內部重構、契約內的 bug 修復、註解 / typo）→ 回一句「無契約變更，文件免動」，
  直接進步驟四。**不要**為此把 CLAUDE.md / README 整份讀一遍。
- **有** → 才進一步分流並實際去改：
  - 改到**契約 / 地圖** → 同步 `CLAUDE.md`（必要時 `README.md`）。**只改動到的那一段**，
    別重寫整份、別讓它腫。
  - 改到**開發流程本身**（新的手動步驟、新的地雷、新的檢查點）→ 同步本 skill
    （`.claude/skills/pre-push-check/SKILL.md`）。踩過一次的坑要寫進來，不要靠記憶。

> 判斷看的是**語意**（有沒有改到「別的 AI 會拿去當真」的事實），不是檔案路徑。
> ⚠️ 反向陷阱：不是每個邏輯小改都要塞進 CLAUDE.md。CLAUDE.md 要維持精簡地圖，
> 過度記錄會讓它自己變成新的漂移源。README 可以厚，CLAUDE.md 不行。

## 步驟四 — 最終確認

```bash
git diff --stat HEAD
```

確認沒有非預期的檔案被包含進去。接著提醒使用者：**`git push` 會直接部署到生產**，
以及本次是否有需要手動執行的 GAS 函式（`setupAllTriggers` / `setupTelegramCommands` /
重新授權）。
