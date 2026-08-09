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
    DASHBOARD_URL:'DASHBOARD_URL'
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
    // （chat／knowledge／short_term_memory／alert_log／env）都在同一張表裡，
    // `AssetSchema.SHEET_ID` 也是指回這裡的 getter，不是另一個寫死的值。
    // 換試算表只要改這個屬性一個地方。
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

    // ─── Google Custom Search ─────────────────────────────────
    get GOOGLE_SEARCH_KEY() { return scriptProperties.getProperty(ENV_KEYS.SEARCH_KEY); },
    get GOOGLE_SEARCH_CX()  { return scriptProperties.getProperty(ENV_KEYS.SEARCH_CX); },
    GOOGLE_SEARCH_API_BASE: 'https://www.googleapis.com/customsearch/v1',

    // ─── NVIDIA ───────────────────────────────────────────────
    get NVIDIA_API_KEY() { return scriptProperties.getProperty(ENV_KEYS.NVIDIA_KEY); },
    NVIDIA_API_BASE:     'https://integrate.api.nvidia.com/v1',
    NVIDIA_DEFAULT_MODEL: 'deepseek-ai/deepseek-v4-flash-0731',

    // 可用性保底（N-1）：主模型呼叫失敗（下架 404/410、過載 503/504/529、重試耗盡回 null）時，
    // AIServiceFactory 會自動改用這個備援模型重試一次。主模型在 NIM 上很熱門、
    // 過載機率高，這道保底就是為它準備的 —— 而 2026-08-07 那次它擋下的是**下架**。
    //
    // gpt-oss-20b：21B MoE（3.6B active）、原生 Function Calling、思考可關。
    // 2026-08-05 從 10 顆候選實測選出（見 find-nim-model skill），四關全過：
    // 打得到、工具參數型別正確、思考關得掉、給定數字能忠實轉述，單輪約 3 秒。
    // ⚠️ 它的關思考只吃 **top-level `reasoning_effort`**，與 deepseek / glm 都不同 ——
    //    NvidiaService 有專屬分支，換掉這顆時記得一併處理那裡。
    //
    // ⚠️ 前一顆備援 ministral-14b 於 2026-07-27 被 NVIDIA 下架，直到 8/5 主模型過載時
    //    才被發現 —— 那段期間保底等於不存在。備援不會自己報平安，換主模型時、
    //    或發現早報失敗時，都要順手確認備援還活著。
    //    2026-08-09 複驗：仍在目錄上，四關全過（忠實轉述那關算得完全正確）。
    AI_FALLBACK_ENABLED:   true,
    NVIDIA_FALLBACK_MODEL: 'openai/gpt-oss-20b',

    // 全檔次使用 DeepSeek-V4-Flash-0731。
    //
    // ⚠️ **無日期的 `deepseek-ai/deepseek-v4-flash` 已於 2026-08-07 EOL，打過去回 410。**
    //    那兩天所有訊息都是備援 gpt-oss-20b 在扛（也就是備援已經沒有備援），
    //    直到 08-09 主人回報「回覆變怪」才發現 —— 回覆品質下降是下架的**間接症狀**，
    //    因為備援是顆 21B 小模型。下次遇到「講話變笨」先查 consolelog 有沒有 410。
    //
    // `-0731` 是同一顆的日期版：`NvidiaService` 的分支比對 `deepseek-ai/deepseek-v4` 前綴，
    // 所以**不必加新分支**，三個 tier 的參數也原封不動沿用。
    // 規格：284B MoE（13B active）、1M context、原生 Function Calling
    //
    // 2026-08-09 四關實測（見 find-nim-model skill），它是唯一四關全過的：
    //   可用性 200 ／ 工具參數型別正確（days 是數字 7 不是字串）
    //   關思考生效（reasoning 639 → 0，completion 371 → 30）
    //   忠實轉述全對（市值 233,000／成本 218,000／損益 +15,000，51 token）
    //
    // 選它的關鍵：思考「可開可關」，用 enableThinking 依「使用者是否在等」分流 ——
    //   FAST  → ChatBot ReAct 迴圈，使用者盯著畫面等 → 關思考求快
    //   SMART → 早報/週報/月報、顧問檢查，全是排程背景任務，沒人在等 → 開思考求質
    //   LITE  → 目前無呼叫端，比照 FAST 設定
    // 思考開啟時 reasoning 會佔用 max_tokens 預算，故 SMART 預算給得比 FAST 寬。
    NVIDIA_MODELS: {
      LITE:  { model: 'deepseek-ai/deepseek-v4-flash-0731', maxOutputTokens: 3072,  temperature: 1.0, topP: 0.95, enableThinking: false },
      FAST:  { model: 'deepseek-ai/deepseek-v4-flash-0731', maxOutputTokens: 4096,  temperature: 1.0, topP: 0.95, enableThinking: false },
      SMART: { model: 'deepseek-ai/deepseek-v4-flash-0731', maxOutputTokens: 12288, temperature: 1.0, topP: 0.95, enableThinking: true  }
    },

    // ─── 對話管理 ─────────────────────────────────────────────
    CHAT_MAX_TURNS:      5,
    CHAT_CLEANUP_DAYS:   30,
    // ReAct 迴圈上限。當初從 5 降到 3，是因為 M2.7 無法關思考、單輪要 60~90 秒，
    // 5 輪最壞情況會逼近 GAS 的 6 分鐘硬上限 —— 那時候**這個數字是唯一的保護**。
    //
    // 現在不是了。`ChatBot.reply` 每一輪開始前會先看 `Utils.execElapsedMs()`，
    // 超過 200s 就不再開新輪。時間上限由那道關卡守著，而且它守得比數輪次好：
    // 它看的是實際花了多久，不是猜的。所以把上限放回 5 不會讓最壞情況變長 ——
    // 5 輪與 3 輪都在 200s 停，差別只在「跑得快的時候能多跑幾輪」。
    //
    // 放回 5 是為了讓需要**串接**的推理跑得完：「查持倉 → 看到某檔異常 →
    // 查那檔的新聞 → 綜合回答」。這種鏈條每一步都要看到上一步的結果，
    // 3 輪（實際只有 2 輪能用工具）中途就會被迫作答。
    // 平行取多份資料本來就不需要多輪 —— 同一輪可以一次丟多個工具呼叫，
    // `ChatBot` 會全部執行（見那裡的註解）。
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
    },

    clearAllCaches() {
      _debugModeCache  = null;
      _aiProviderCache = null;
    }
  };
})();
