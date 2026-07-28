/**
 * Config
 * @description 設定檔模組 — 集中管理系統參數與 API 金鑰
 */
var Config = (() => {
  var scriptProperties = PropertiesService.getScriptProperties();

  var ENV_KEYS = {
    LINE_TOKEN:   'LINE_API_KEY',
    LINE_SECRET:  'LINE_CHANNEL_SECRET',
    TELEGRAM_TOKEN: 'TELEGRAM_API_KEY',
    SHEET_ID:     'SHEET_ID',
    ADMIN_STRING: 'ADMIN_STRING',
    GEMINI_KEY:   'GEMINI_API_KEY',
    NVIDIA_KEY:   'NVIDIA_API_KEY',
    SEARCH_KEY:   'GOOGLE_SEARCH_KEY',
    SEARCH_CX:    'GOOGLE_SEARCH_CX',
    DASHBOARD_URL:'DASHBOARD_URL'
  };

  var _debugModeCache    = null;
  var _aiProviderCache   = null;

  return {
    // ─── LINE API ─────────────────────────────────────────────
    get LINE_CHANNEL_TOKEN()  { return scriptProperties.getProperty(ENV_KEYS.LINE_TOKEN); },
    get LINE_CHANNEL_SECRET() { return scriptProperties.getProperty(ENV_KEYS.LINE_SECRET); },
    LINE_API_BASE: 'https://api.line.me/v2/bot',

    // ─── Telegram API ─────────────────────────────────────────
    get TELEGRAM_API_KEY()  { return scriptProperties.getProperty(ENV_KEYS.TELEGRAM_TOKEN); },
    get TELEGRAM_API_BASE() { return 'https://api.telegram.org/bot' + this.TELEGRAM_API_KEY; },

    // ─── Google Sheets ────────────────────────────────────────
    get SHEET_ID()     { return scriptProperties.getProperty(ENV_KEYS.SHEET_ID); },
    get ADMIN_STRING() { return scriptProperties.getProperty(ENV_KEYS.ADMIN_STRING); },

    // ─── 儀表板網址（/dashboard 指令用）────────────────────────
    // 放 Script Property 而非寫死：儀表板要的是 HEAD 部署的 /dev 網址，
    // 而它的 deployment ID 與 webhook 的 /exec 完全不同（不是換字尾就能推導），
    // ScriptApp.getService().getUrl() 從 doPost 執行時也只會拿到 /exec。
    get DASHBOARD_URL() { return scriptProperties.getProperty(ENV_KEYS.DASHBOARD_URL); },

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

    MODEL_CAPABILITIES: {
      'gemini-2.5-flash-lite': { maxOutputTokens: 8192, supportsFunctionCalling: true },
      'gemini-2.5-flash':      { maxOutputTokens: 8192, supportsFunctionCalling: true },
      'gemini-2.5-pro':        { maxOutputTokens: 8192, supportsFunctionCalling: true }
    },

    // ─── Google Custom Search ─────────────────────────────────
    get GOOGLE_SEARCH_KEY() { return scriptProperties.getProperty(ENV_KEYS.SEARCH_KEY); },
    get GOOGLE_SEARCH_CX()  { return scriptProperties.getProperty(ENV_KEYS.SEARCH_CX); },
    GOOGLE_SEARCH_API_BASE: 'https://www.googleapis.com/customsearch/v1',

    // ─── NVIDIA ───────────────────────────────────────────────
    get NVIDIA_API_KEY() { return scriptProperties.getProperty(ENV_KEYS.NVIDIA_KEY); },
    NVIDIA_API_BASE:     'https://integrate.api.nvidia.com/v1',
    NVIDIA_DEFAULT_MODEL: 'deepseek-ai/deepseek-v4-flash',

    // 可用性保底（N-1）：主模型呼叫失敗（下架 404/410、過載 503/504、重試耗盡回 null）時，
    // AIServiceFactory 會自動改用這個備援模型重試一次。deepseek-v4-flash 在 NIM 上很熱門、
    // 過載機率高，這道保底就是為它準備的。ministral-14b 為非思考的 dense 模型、原生
    // Function Calling、含繁中，christina 同樣用它當備援。換主模型時記得確認備援還活著。
    AI_FALLBACK_ENABLED:   true,
    NVIDIA_FALLBACK_MODEL: 'mistralai/ministral-14b-instruct-2512',

    // 全檔次使用 DeepSeek-V4-Flash（前代 minimaxai/minimax-m2.7 將於 NIM 下架）
    // 規格：284B MoE（13B active）、1M context、原生 Function Calling
    //
    // 選它的關鍵：思考「可開可關」，改用 enableThinking 依「使用者是否在等」分流 ——
    //   FAST  → ChatBot ReAct 迴圈，使用者盯著畫面等 → 關思考求快
    //           （M2.7 無法關思考，實測單輪要 74~77 秒；關掉後這段延遲才有救）
    //   SMART → 早報/週報/月報、顧問檢查，全是排程背景任務，沒人在等 → 開思考求質
    //   LITE  → 目前無呼叫端，比照 FAST 設定
    // 思考開啟時 reasoning 會佔用 max_tokens 預算，故 SMART 預算給得比 FAST 寬。
    NVIDIA_MODELS: {
      LITE:  { model: 'deepseek-ai/deepseek-v4-flash', maxOutputTokens: 3072,  temperature: 1.0, topP: 0.95, enableThinking: false },
      FAST:  { model: 'deepseek-ai/deepseek-v4-flash', maxOutputTokens: 4096,  temperature: 1.0, topP: 0.95, enableThinking: false },
      SMART: { model: 'deepseek-ai/deepseek-v4-flash', maxOutputTokens: 12288, temperature: 1.0, topP: 0.95, enableThinking: true  }
    },

    // ─── 對話管理 ─────────────────────────────────────────────
    CHAT_MAX_TURNS:      5,
    CHAT_CLEANUP_DAYS:   30,
    // ReAct 迴圈上限。當初從 5 降到 3，是因為 M2.7 無法關思考、單輪要 60~90 秒，
    // 5 輪最壞情況會逼近 GAS 的 6 分鐘硬上限。改用關思考的 deepseek-v4-flash 後
    // 單輪應大幅縮短，但過載重試（3 次退避）＋備援接手也會吃時間，故先維持 3 輪；
    // 3 輪足夠涵蓋「呼叫工具 → 讀結果 → 回答」這個主要路徑。
    // 想調回 4~5 輪的話，先看 consolelog 裡 ReAct 迴圈結束的 elapsedMs 實際分佈。
    TOOL_MAX_ITERATIONS: 3,
    ALERT_ETF_DROP:      0.03,  // 單檔 ETF 日跌幅超過此值觸發警報

    // ─── 系統提示詞 ───────────────────────────────────────────
    get SYSTEM_PROMPT() { return Prompt.SYSTEM_PROMPT; },

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
    },

    clearAllCaches() {
      _debugModeCache  = null;
      _aiProviderCache = null;
    }
  };
})();
