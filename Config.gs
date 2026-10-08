/**
 * Config
 * @description 設定檔模組 — 集中管理系統參數與 API 金鑰
 */
var Config = (() => {
  var scriptProperties = PropertiesService.getScriptProperties();

  var ENV_KEYS = {
    LINE_TOKEN:   'LINE_API_KEY',
    TELEGRAM_TOKEN: 'TELEGRAM_API_KEY',
    SHEET_ID:     'SHEET_ID',
    ADMIN_STRING: 'ADMIN_STRING',
    GEMINI_KEY:   'GEMINI_API_KEY',
    NVIDIA_KEY:   'NVIDIA_API_KEY',
    SEARCH_KEY:   'GOOGLE_SEARCH_KEY',
    SEARCH_CX:    'GOOGLE_SEARCH_CX',
    DASHBOARD_URL:'DASHBOARD_URL',
    DIAG_KEY:     'DIAG_KEY',
    AI_PROVIDER:  'AI_PROVIDER',
    DEBUG_MODE:   'DEBUG_MODE'
  };

  return {
    // ─── LINE API ─────────────────────────────────────────────
    //
    // 沒有 LINE_CHANNEL_SECRET：webhook 簽章驗證做不了。GAS 的 doPost(e) 讀不到
    // HTTP header，拿不到 X-Line-Signature，所以那份驗簽程式從寫出來的第一天起
    // 就沒有被呼叫過（2026-08-08 刪除）。防線是 Utils.checkMaster 的允許清單。
    get LINE_CHANNEL_TOKEN()  { return scriptProperties.getProperty(ENV_KEYS.LINE_TOKEN); },
    LINE_API_BASE: 'https://api.line.me/v2/bot',

    // ─── Telegram API ─────────────────────────────────────────
    get TELEGRAM_API_KEY()  { return scriptProperties.getProperty(ENV_KEYS.TELEGRAM_TOKEN); },
    get TELEGRAM_API_BASE() { return 'https://api.telegram.org/bot' + this.TELEGRAM_API_KEY; },

    // ─── Google Sheets ────────────────────────────────────────
    //
    // 整個專案**只有這一個**試算表 ID。資產分頁（標的／交易／持倉／…）與系統分頁
    // （chat／consolelog）都在同一張表裡，
    // `AssetSchema.SHEET_ID` 也是指回這裡的 getter，不是另一個寫死的值。
    // 換試算表只要改這個屬性一個地方。
    get SHEET_ID()     { return scriptProperties.getProperty(ENV_KEYS.SHEET_ID); },
    get ADMIN_STRING() { return scriptProperties.getProperty(ENV_KEYS.ADMIN_STRING); },

    // ─── 儀表板網址（/dashboard 指令用）────────────────────────
    // 放 Script Property 而非寫死：儀表板要的是 HEAD 部署的 /dev 網址，
    // 而它的 deployment ID 與 webhook 的 /exec 完全不同（不是換字尾就能推導），
    // ScriptApp.getService().getUrl() 從 doPost 執行時也只會拿到 /exec。
    get DASHBOARD_URL() { return scriptProperties.getProperty(ENV_KEYS.DASHBOARD_URL); },

    // ─── 唯讀診斷入口的金鑰（見 Diag.gs）。沒設就是關閉 ─────────
    get DIAG_KEY() { return scriptProperties.getProperty(ENV_KEYS.DIAG_KEY); },

    // ─── AI Provider 切換（Script Property AI_PROVIDER：GEMINI 或 NVIDIA）──
    // 以前讀 env!B3，每次執行都要多開一次試算表（2026-10-08 搬過來，env 分頁刪除）。
    // ⚠️ 沒設時預設 NVIDIA，不是 GEMINI：搬過來那天線上跑的就是 NVIDIA，
    //    預設成別的會在主人補設屬性之前靜默換掉整個模型。
    get AI_PROVIDER() {
      var v = String(scriptProperties.getProperty(ENV_KEYS.AI_PROVIDER) || '').trim().toUpperCase();
      return v === 'GEMINI' ? 'GEMINI' : 'NVIDIA';
    },

    // ─── Gemini ───────────────────────────────────────────────
    get GEMINI_API_KEY() { return scriptProperties.getProperty(ENV_KEYS.GEMINI_KEY); },
    GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta',

    GEMINI_MODELS: {
      LITE:  { model: 'gemini-2.5-flash-lite', maxOutputTokens: 2048, temperature: 1.0 },
      FAST:  { model: 'gemini-2.5-flash',      maxOutputTokens: 4096, temperature: 1.0 },
      SMART: { model: 'gemini-2.5-pro',        maxOutputTokens: 6144, temperature: 1.0 }
    },

    // ─── Google Custom Search ─────────────────────────────────
    get GOOGLE_SEARCH_KEY() { return scriptProperties.getProperty(ENV_KEYS.SEARCH_KEY); },
    get GOOGLE_SEARCH_CX()  { return scriptProperties.getProperty(ENV_KEYS.SEARCH_CX); },
    GOOGLE_SEARCH_API_BASE: 'https://www.googleapis.com/customsearch/v1',

    // ─── NVIDIA ───────────────────────────────────────────────
    get NVIDIA_API_KEY() { return scriptProperties.getProperty(ENV_KEYS.NVIDIA_KEY); },
    NVIDIA_API_BASE:     'https://integrate.api.nvidia.com/v1',
    NVIDIA_DEFAULT_MODEL: 'google/gemma-4-31b-it',

    // 可用性保底（N-1）：主模型失敗（404/410 下架、503/504/529 過載、重試耗盡回 null）時，
    // AIServiceFactory 會改用這顆重試一次。
    //
    // gpt-oss-20b：21B MoE、原生 Function Calling、思考可關，單輪約 3 秒。
    // ⚠️ 它的關思考只吃 top-level `reasoning_effort`，與 deepseek / glm 都不同，
    //    NvidiaService 有專屬分支，換掉這顆要一併處理那裡。
    // ⚠️ 備援不會自己報平安：換主模型時、或發現排程報告失敗時，
    //    要順手確認備援還在目錄上（用 find-nim-model skill）。
    // ⚠️ 2026-10-08 實測它並不可靠：忠實轉述把總損益算成 63,000（正解 15,000），
    //    寫入意圖 4/6（台幣戶校正叫成 listAccounts／updateAccount）。還在目錄上、
    //    還接得住，但只是「比沒有好」——替代品待找（見 TODO.md）。
    AI_FALLBACK_ENABLED:   true,
    NVIDIA_FALLBACK_MODEL: 'openai/gpt-oss-20b',

    // 全檔次使用 Gemma 4 31B（google/gemma-4-31b-it，非思考模型、原生 Function Calling、含繁中）。
    //
    // 2026-10-08 換掉 kimi-k3：10/5 它對四次「把某帳戶調成 X」都沒叫工具，照
    // setCashBalance 的輸出格式編出「已校正（第 98 列）…」，另有兩次只吐 `!!!!!!!!`。
    // find-nim-model 加了第五關 testNimWriteIntent（真的 systemContext + 全部工具 +
    // 一段「看起來沒叫工具就回了已記錄」的歷史），kimi-k3 0/6、拿掉歷史也只有 2/6，
    // 還會吐 `<|open|>tools…` 這種亂碼。gemma-4-31b-it 是唯一全過的：寫入意圖有無歷史
    // 都 6/6、日幣不換算成台幣、忠實轉述 2/2 算對。nemotron-3-super／ultra 寫入也 6/6，
    // 但推理關不掉，在 512 token 預算內吐不出正文或把英文推理當正文。（n=2，見 DevTools）
    //
    // gemma 沒有思考開關可送，也不需要：NvidiaService 沒有它的分支，什麼都不加；
    // 工具呼叫時不送 tool_choice（既有的 gemma 例外，實測就是這樣過關的）。
    // 所以 enableThinking 對它沒有作用，三個 tier 只差在字數預算 —— 早報／週報／月報
    // 不再有推理這一步，SMART 不必再為 reasoning 預留大預算。
    //
    // ── 以下是 kimi-k3 上任時（2026-09-24）的紀錄 ──
    // ⚠️ `deepseek-ai/deepseek-v4-flash-0731` 已於 2026-09-24 從 NIM 目錄消失（下架，
    //    不是過載 —— 同代的 `deepseek-ai/deepseek-v4.1-flash` 單獨測也整整 302s 504，
    //    不是候選）。`find-nim-model` 流程重新掃過一輪：同批一起下架的還有
    //    `openai/gpt-oss-120b`／`minimaxai/minimax-m3`／`stepfun-ai/step-3.7-flash`／
    //    `meta/llama-3.3-70b-instruct`（2026-08-09 那輪備援候選）。10 顆候選中 5 顆打得
    //    到帳號，其中 `z-ai/glm-5.3-flash` 在決選關（忠實轉述）兩種思考模式都
    //    `finish_reason=length`、正文吐不出來，`z-ai/glm-5.3` 的 `enable_thinking=false`
    //    只降低推理量、沒歸零，一樣在決選關把 512 token 預算燒光。`kimi-k3` 是唯一
    //    四關全過的新候選：thinking 開關乾淨（`chat_template_kwargs.thinking` 一 false
    //    推理長度就是 0），忠實轉述與算術都對。
    //
    // NvidiaService 新增了 `moonshotai/kimi` 前綴的分支（形狀同 deepseek-v4 的布林
    // thinking 開關，但 `reasoning_effort` 欄位未驗證過對它有沒有效，故不比照送出）。
    //
    // temperature／topP 刻意不覆寫（省略後 NvidiaService 用各模型自身預設）——
    // 1.0 / 0.95 是 NVIDIA 官方範例**針對 deepseek-v4-flash** 的建議組合，沒有對應
    // 給 kimi 的官方數字，硬套舊模型的建議值沒有依據。
    //
    // 三個 tier 的用途：
    //   FAST  → ChatBot ReAct 迴圈，使用者在等
    //   SMART → 早報／週報／月報，背景排程
    //   LITE  → 目前無呼叫端
    // enableThinking 仍照「使用者是否在等」填：gemma 不吃這個旗標，但備援 gpt-oss
    // 吃（決定 reasoning_effort low／high），所以這個欄位對備援路徑仍有意義。
    // ⚠️ 備援沿用同一個 tier 的 maxOutputTokens（AIServiceFactory 只換 model）。
    //    SMART 備援是 reasoning_effort=high，推理會吃預算，所以 SMART 給 8192，
    //    不是 gemma 自己需要的量 —— 縮回去的話備援接手早報時正文會被截掉。
    NVIDIA_MODELS: {
      LITE:  { model: 'google/gemma-4-31b-it', maxOutputTokens: 2048, enableThinking: false },
      FAST:  { model: 'google/gemma-4-31b-it', maxOutputTokens: 4096, enableThinking: false },
      SMART: { model: 'google/gemma-4-31b-it', maxOutputTokens: 8192, enableThinking: true  }
    },

    // ─── 對話管理 ─────────────────────────────────────────────
    CHAT_MAX_TURNS:      5,
    CHAT_CLEANUP_DAYS:   30,
    // ReAct 迴圈上限（最後一輪不帶工具，所以實際有 4 輪可呼叫工具）。
    // ⚠️ 這個數字**不是**時間保護：真正守門的是 ChatBot.reply 每輪開始前的
    //    Utils.execElapsedMs()（200s 就不再開新輪）。5 輪與 3 輪的最壞情況一樣長。
    // 設 5 是為了讓串接推理跑得完（查持倉 → 發現異常 → 查該檔新聞 → 回答）。
    // 平行取多份資料不需要多輪：同一輪可以丟多個工具呼叫，ChatBot 會全部執行。
    TOOL_MAX_ITERATIONS: 5,
    ALERT_ETF_DROP:      0.03,  // 單檔 ETF 日跌幅超過此值觸發警報

    // ─── Debug 模式（Script Property DEBUG_MODE）─────────────────
    // 只控制 Logger.ai —— 要不要把每次 LLM 呼叫的請求／回應寫進 consolelog。
    // 沒設就是開，與以前讀 env!B2 失敗時的預設一樣；只有明寫 false 才關。
    get DEBUG_MODE() {
      var v = String(scriptProperties.getProperty(ENV_KEYS.DEBUG_MODE) || '').trim().toLowerCase();
      return v !== 'false';
    }
  };
})();
