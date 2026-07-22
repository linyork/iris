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
    SEARCH_CX:    'GOOGLE_SEARCH_CX'
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
    NVIDIA_DEFAULT_MODEL: 'minimaxai/minimax-m2.7',

    // 全檔次使用 MiniMax-M2.7（前代 z-ai/glm-5.1 已於 2026-07-02 EOL，API 回 410）
    // 規格：context 204,800 tokens、原生 Function Calling、官方建議 temperature 1.0 / top_p 0.95
    //
    // ⚠️ M2.7 是 reasoning 模型且無法關閉思考（NIM 未提供 GLM 那種 enable_thinking 開關），
    //    思考內容與答案共用 max_tokens 預算。預算抓太緊會讓 token 全被思考吃光、
    //    content 回空字串 → ChatBot 判定「無效回應」，所以下列數字比 GLM 時代加倍。
    //    模型本身輸出上限遠高於此（131k），這裡的值是為了壓住 GAS 執行時間而非模型限制。
    NVIDIA_MODELS: {
      LITE:  { model: 'minimaxai/minimax-m2.7', maxOutputTokens: 6144,  temperature: 1.0, topP: 0.95 },
      FAST:  { model: 'minimaxai/minimax-m2.7', maxOutputTokens: 8192,  temperature: 1.0, topP: 0.95 },
      SMART: { model: 'minimaxai/minimax-m2.7', maxOutputTokens: 12288, temperature: 1.0, topP: 0.95 }
    },

    // ─── 對話管理 ─────────────────────────────────────────────
    CHAT_MAX_TURNS:      5,
    CHAT_CLEANUP_DAYS:   30,
    TOOL_MAX_ITERATIONS: 5,
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
