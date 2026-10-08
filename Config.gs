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
    DIAG_KEY:     'DIAG_KEY'
  };

  var _debugModeCache    = null;
  var _aiProviderCache   = null;

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
    // （chat／consolelog／env）都在同一張表裡，
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

    // ─── AI Provider 切換（env!B3：GEMINI 或 NVIDIA）────────
    get AI_PROVIDER() {
      if (_aiProviderCache !== null) return _aiProviderCache;
      try {
        var sheet = SpreadsheetApp.openById(scriptProperties.getProperty(ENV_KEYS.SHEET_ID))
                                  .getSheetByName('env');
        var val = String(sheet.getRange('B3').getValue()).toUpperCase();
        _aiProviderCache = (val === 'NVIDIA') ? 'NVIDIA' : 'GEMINI';
      } catch (e) {
        _aiProviderCache = 'GEMINI';
      }
      return _aiProviderCache;
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
    NVIDIA_DEFAULT_MODEL: 'moonshotai/kimi-k3',

    // 可用性保底（N-1）：主模型失敗（404/410 下架、503/504/529 過載、重試耗盡回 null）時，
    // AIServiceFactory 會改用這顆重試一次。
    //
    // gpt-oss-20b：21B MoE、原生 Function Calling、思考可關，單輪約 3 秒。
    // ⚠️ 它的關思考只吃 top-level `reasoning_effort`，與 deepseek / glm 都不同，
    //    NvidiaService 有專屬分支，換掉這顆要一併處理那裡。
    // ⚠️ 備援不會自己報平安：換主模型時、或發現排程報告失敗時，
    //    要順手確認備援還在目錄上（用 find-nim-model skill）。
    AI_FALLBACK_ENABLED:   true,
    NVIDIA_FALLBACK_MODEL: 'openai/gpt-oss-20b',

    // 全檔次使用 Kimi K3（moonshotai/kimi-k3，原生 Function Calling、含繁中）。
    //
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
    // enableThinking 依「使用者是否在等」分流：
    //   FAST  → ChatBot ReAct 迴圈，使用者在等 → 關思考求快
    //   SMART → 早報／週報／月報、顧問檢查，背景排程 → 開思考求質
    //   LITE  → 目前無呼叫端，比照 FAST
    // 思考開啟時 reasoning 會佔用 max_tokens，故 SMART 的預算較寬。
    NVIDIA_MODELS: {
      LITE:  { model: 'moonshotai/kimi-k3', maxOutputTokens: 3072,  enableThinking: false },
      FAST:  { model: 'moonshotai/kimi-k3', maxOutputTokens: 4096,  enableThinking: false },
      SMART: { model: 'moonshotai/kimi-k3', maxOutputTokens: 12288, enableThinking: true  }
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

    // ─── Debug 模式（env!B2）──────────────────────────────────
    get DEBUG_MODE() {
      if (_debugModeCache !== null) return _debugModeCache;
      try {
        var sheet = SpreadsheetApp.openById(scriptProperties.getProperty(ENV_KEYS.SHEET_ID))
                                  .getSheetByName('env');
        _debugModeCache = sheet.getRange('B2').getValue() === true;
      } catch (e) {
        _debugModeCache = true;
      }
      return _debugModeCache;
    }

    // 這裡以前有一支 clearAllCaches()，沒有任何呼叫端，也不會有 ——
    // 上面兩個快取是模組層級變數，而 GAS 每次執行都重載全部 .gs，
    // 它們在每一次新執行的起點本來就是 null。清它沒有可用的場合。
  };
})();
