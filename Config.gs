/**
 * Config
 * @description 設定檔模組 — 集中管理系統參數與 API 金鑰
 */
var Config = (() => {
  var scriptProperties = PropertiesService.getScriptProperties();

  var ENV_KEYS = {
    LINE_TOKEN:   'LINE_API_KEY',
    LINE_SECRET:  'LINE_CHANNEL_SECRET',
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
    NVIDIA_DEFAULT_MODEL: 'z-ai/glm-5.1',

    // 全檔次使用 GLM-5.1：原生中文、agentic 工作流、原生 Function Calling
    NVIDIA_MODELS: {
      LITE:  { model: 'z-ai/glm-5.1', maxOutputTokens: 3072, temperature: 0.5, enableThinking: false },
      FAST:  { model: 'z-ai/glm-5.1', maxOutputTokens: 4096, temperature: 0.7, enableThinking: false },
      SMART: { model: 'z-ai/glm-5.1', maxOutputTokens: 8192, temperature: 0.7, enableThinking: false }
    },

    // ─── 對話管理 ─────────────────────────────────────────────
    CHAT_MAX_TURNS:      5,
    CHAT_CLEANUP_DAYS:   30,
    TOOL_MAX_ITERATIONS: 3,

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
