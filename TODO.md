# TODO

未完成的事項登記處。**做完就把該條刪掉**，不要留「已完成」的紀錄——那是 git log 的工作。

現況說明看 `CLAUDE.md`（給 AI 的專案地圖）與 `README.md`（完整說明）。

---

## 已知缺陷

- [ ] **備援模型 `gpt-oss-20b` 不可靠**
      2026-10-08 find-nim-model：忠實轉述算錯總損益（63,000，正解 15,000）、寫入意圖 4/6。
      候選先從同一輪 6/6 的 `nemotron-3-super`／`nemotron-3-ultra` 看起，但兩者推理關不掉，
      要先確認給足 max_tokens 後正文出得來、延遲可接受。

- [ ] **`voidTrade` 作廢轉帳的單一腳沒有防護**
      轉出／轉入是兩列、彼此沒有欄位綁定，作廢其中一列不會被任何檢查擋下，
      而轉帳不碰持倉，`Position.replay` 也不會警告。目前只在 `voidTrade` 印警告，配對仍靠人工。

## 記帳匯入的下一步（規格書 Phase 2，v1 刻意沒做）

- [ ] **`消費` 還沒有讀者**：儀表板、Mini App 都還不讀它，匯入之後畫面上不會多東西
- [ ] **`getSpending` 工具**：依月份、分析類型、分類查詢（「這個月外食花多少」）。
      加的時候 `Tools.gs` 的 definitions 與 switch 要一起改；查詢結果不要整張塞進 prompt
- [ ] **Drive 資料夾入口**：時間觸發器掃資料夾，有新檔就呼叫 `ExpenseImport.run({blob, fileName})`。
      ⚠️ 這會需要 Drive 權限，也就是新的 oauthScope —— 先授權再 deploy（見 pre-push-check）

## 未盤點的區域

- [ ] **`AssetImport` / `Position` / `DataSync` 這條記帳與重算的資料流**
      2026-08 的盤點只涵蓋 `doPost` / `doGet` 的對話與展示路徑。展示層當時找到的問題
      （假的 0%、儲存格格式偽裝成數值、百分比沒寫分母、log 記錄未賦值的變數）
      都是同一類，記帳路徑沒有理由乾淨。

## 架構債（目前不痛，先記著）

- [ ] **每輪都送出全部工具的 schema**，沒有依意圖收斂。輪數上限放寬到 5 之後成本加倍。
- [ ] **沒有可序列化的狀態物件**：一次對話的狀態全是 `ChatBot.reply()` 的區域變數，
      無法 checkpoint、無法在迴圈外觀測。
