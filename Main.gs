/**
 * Main
 * @description 系統入口點 — 接收 LINE / Telegram Webhook 並分發處理
 */

/**
 * Webhook 處理程序（LINE / Telegram 共用入口）
 * @param {object} e - Google Apps Script doPost 事件
 */
function doPost(e) {
  try {
    // 判斷來源平台，統一組出中立事件陣列（形狀與 LINE event 一致，下游不用區分平台）
    var raw    = e.postData.contents;
    var events = null;

    if (Line.isLine(raw)) {
      events = JSON.parse(raw).events || [];
      events.forEach(ev => { ev.platform = 'LINE'; });
    } else if (Telegram.isTelegram(raw)) {
      events = [Telegram.normalizeEvent(JSON.parse(raw))];
    }

    if (!events) {
      Logger.info('doPost', '無法辨識的來源，忽略');
      return;
    }

    var cache = CacheService.getScriptCache();

    for (var i = 0; i < events.length; i++) {
      var event = events[i];

      // 防止重複事件
      // TTL 拉到 6 小時（CacheService 上限）：單次 ReAct 迴圈可能跑數十秒到數分鐘，
      // 平台若遲遲收不到 200 OK 而重送同一則 update，短 TTL 會讓它被當成新事件完整重跑。
      var eventId = event.webhookEventId;
      if (eventId) {
        if (cache.get(eventId)) {
          Logger.info('doPost', '忽略重複事件', eventId);
          continue;
        }
        cache.put(eventId, '1', 21600);
      }

      if (event.platform === 'TELEGRAM') {
        event.isMaster = Utils.checkMaster(event.source.userId);
      } else {
        Line.init(event);  // 設定 isMaster / profile / sourceId
        if (event.type !== 'message') continue;
      }

      if (!event.message || event.message.type !== 'text') continue;

      Logger.info('doPost', '收到訊息', {
        userId: event.source.userId,
        msg:    event.message.text.slice(0, 80)
      });

      // 非主人事件靜默忽略：Telegram bot 公開可搜尋，任何人都能 DM。
      // 不回覆（避免反射放大）、不寫 chat history、不消耗 LLM 配額。
      if (!event.isMaster) {
        Logger.info('doPost', '忽略非主人事件', event.source.userId);
        continue;
      }

      // 開始處理就先送「正在輸入…」，讓使用者馬上看到反應
      MessagingServiceFactory.indicateTyping(event);

      // 斜線指令先攔截：答案固定的指令不必跑完整個 ReAct 迴圈。
      // 回傳 null 才代表不是指令，交給 ChatBot 當自然語言處理。
      var reply = Commands.tryHandle(event);
      if (reply === null) {
        reply = ChatBot.reply(event);
      }

      if (reply) {
        MessagingServiceFactory.push(event.source.userId, reply);
      }
    }
  } catch (error) {
    Logger.error('doPost', 'Webhook 處理失敗', error);
  }
}

/**
 * 資產儀表板網頁進入點
 *
 * ⚠️ 這支 doGet 在「任何人、匿名」的 webhook deployment 上同樣可達，
 * 所以一定要靠 Dashboard.isAuthorized() 擋——匿名訪客的 getActiveUser()
 * 是空字串，會被擋在外面。請另外建立一個「存取權：只有我自己」的
 * deployment，用那支網址開儀表板。
 *
 * @param {object} e - Google Apps Script doGet 事件
 */
function doGet(e) {
  if (!Dashboard.isAuthorized()) {
    Logger.info('doGet', '拒絕未授權的儀表板存取');
    return HtmlService.createHtmlOutput('<h1>Not Found</h1>')
      .setTitle('Not Found');
  }

  // 檔名是 DashboardPage 而非 Dashboard：GAS 的檔名不含副檔名，
  // 會與 Dashboard.gs 撞名而拒絕 push
  return HtmlService.createHtmlOutputFromFile('DashboardPage')
    .setTitle('Iris 資產儀表板')
    // addMetaTag 只接受白名單內的名稱（viewport / apple-mobile-web-app-capable /
    // mobile-web-app-capable / google-site-verification），其餘會直接丟例外。
    // theme-color 不在白名單，別再加回來。
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes');
}

/**
 * 註冊 Telegram Webhook（首次設定或更換部署時，於 GAS 編輯器手動執行一次）
 *
 * 固定使用既有的版本化部署 URL（與原 LINE webhook 同一個），不用 ScriptApp.getService()
 * ——後者從編輯器執行時可能回傳 /dev 網址，那個需要登入驗證，Telegram 打不進來。
 */
function setupTelegramWebhook() {
  var WEB_APP_URL = 'https://script.google.com/macros/s/' +
    'AKfycbxN-6Yx2GEiLvyBIeZ9z0CyZPbUuBXMyoD6xtN3j_XOc38_S2OBrOonVPaxXM4NVRcI' + '/exec';
  console.log('註冊 webhook → ' + WEB_APP_URL);
  console.log(Telegram.setupWebhook(WEB_APP_URL));
}

/**
 * 註冊 Telegram 斜線指令選單（新增或修改指令後，於 GAS 編輯器手動執行一次）
 */
function setupTelegramCommands() {
  console.log('註冊指令選單：' + JSON.stringify(Commands.getDefinitions()));
  console.log(Telegram.setupCommands());
}

/**
 * 每日例行清理（建議設定 Time-based trigger，每天凌晨 4 點執行）
 * - 清除已過期的短期記憶
 * - 清除超過保留天數的對話歷史
 */
function dailyCleanUp() {
  try {
    GoogleSheet.cleanExpiredShortTermMemories();
    AlertLog.cleanOld();

    var ss = SpreadsheetApp.openById(Config.SHEET_ID);

    // 清除超過 10 天的 consolelog
    var logSheet = ss.getSheetByName('consolelog');
    if (logSheet) {
      var logCutoff = new Date();
      logCutoff.setDate(logCutoff.getDate() - 10);
      var logLastRow = logSheet.getLastRow();
      if (logLastRow >= 2) {
        var logData   = logSheet.getRange(2, 1, logLastRow - 1, 1).getValues();
        var logDelete = [];
        for (var i = logData.length - 1; i >= 0; i--) {
          if (logData[i][0] && new Date(logData[i][0]) < logCutoff) logDelete.push(i + 2);
        }
        logDelete.forEach(r => logSheet.deleteRow(r));
        if (logDelete.length > 0) Logger.info('dailyCleanUp', '清除過期 consolelog ' + logDelete.length + ' 筆');
      }
    }

    // 清除超過 30 天的 chat 紀錄
    // 清除超過 30 天的 chat 紀錄
    var chatSheet = ss.getSheetByName('chat');
    if (chatSheet) {
      var cutoff  = new Date();
      cutoff.setDate(cutoff.getDate() - Config.CHAT_CLEANUP_DAYS);
      var lastRow = chatSheet.getLastRow();
      if (lastRow >= 2) {
        var data    = chatSheet.getRange(2, 4, lastRow - 1, 1).getValues();
        var toDelete = [];
        for (var i = data.length - 1; i >= 0; i--) {
          if (data[i][0] && new Date(data[i][0]) < cutoff) toDelete.push(i + 2);
        }
        toDelete.forEach(r => chatSheet.deleteRow(r));
        if (toDelete.length > 0) {
          Logger.info('dailyCleanUp', '清除過期對話 ' + toDelete.length + ' 筆');
        }
      }
    }
  } catch (ex) {
    Logger.error('dailyCleanUp', '每日清理失敗', ex);
  }
}

/**
 * 初始化所有系統 Trigger（首次部署或重設時手動執行一次）
 * 清除所有舊 Trigger 後重建：
 *   04:00 — dailyCleanUp   (清理過期記憶與舊對話)
 *   18:00 — setData        (每日資產快照)
 */
function setupAllTriggers() {
  try {
    // 清除所有既有 Trigger
    var triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(t => ScriptApp.deleteTrigger(t));
    Logger.info('setupAllTriggers', '已清除 ' + triggers.length + ' 個舊 Trigger');

    // 每日 04:00 — 記憶清理
    ScriptApp.newTrigger('dailyCleanUp')
      .timeBased()
      .atHour(4)
      .everyDays(1)
      .create();

    // 每日 09:00 — 財經早報
    ScriptApp.newTrigger('dailyReport')
      .timeBased()
      .atHour(9)
      .everyDays(1)
      .create();

    // 每日 10:00 — 盤中警報（第一次）
    ScriptApp.newTrigger('marketAlert')
      .timeBased()
      .atHour(10)
      .everyDays(1)
      .create();

    // 每日 14:00 — 盤中警報（第二次）
    ScriptApp.newTrigger('marketAlert')
      .timeBased()
      .atHour(14)
      .everyDays(1)
      .create();

    // 每週六 09:00 — 週報
    ScriptApp.newTrigger('weeklyReport')
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.SATURDAY)
      .atHour(9)
      .create();

    // 每月 1 日 10:00 — 月報（10:00 避免與早報 09:00 撞）
    ScriptApp.newTrigger('monthlyReport')
      .timeBased()
      .onMonthDay(1)
      .atHour(10)
      .create();

    // 每日 18:00 — 資產快照
    ScriptApp.newTrigger('setData')
      .timeBased()
      .atHour(18)
      .everyDays(1)
      .create();

    // 每日 19:00 — 主動顧問感知（setData 寫完快照之後跑，
    // 留 1 小時 buffer 因為 GAS atHour 是 1 小時窗口非精準時間）
    ScriptApp.newTrigger('advisorCheckEvening')
      .timeBased()
      .atHour(19)
      .everyDays(1)
      .create();

    console.log('✅ Trigger 設定完成：');
    console.log('   每日 04:00 → dailyCleanUp');
    console.log('   每日 09:00 → dailyReport');
    console.log('   每日 10:00 → marketAlert');
    console.log('   每日 14:00 → marketAlert');
    console.log('   每週六 09:00 → weeklyReport');
    console.log('   每月 1 日 10:00 → monthlyReport');
    console.log('   每日 18:00 → setData');
    console.log('   每日 19:00 → advisorCheckEvening');
  } catch (ex) {
    Logger.error('setupAllTriggers', '設定 Trigger 失敗', ex);
    console.log('❌ 設定失敗：' + ex.message);
  }
}

/**
 * 初始化系統（首次部署時手動執行）
 * - 確認試算表各工作表已建立
 * - 列印環境變數狀態
 */
function setup() {
  var requiredSheets = ['env', 'consolelog', 'chat', 'short_term_memory', 'knowledge', 'alert_log'];
  var ss = SpreadsheetApp.openById(Config.SHEET_ID);

  requiredSheets.forEach(name => {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      console.log('⚠️  缺少工作表: ' + name + '，請手動建立。');
    } else {
      console.log('✅  工作表存在: ' + name);
    }
  });

  console.log('--- 環境變數 ---');
  console.log('LINE_CHANNEL_TOKEN:  ' + (Config.LINE_CHANNEL_TOKEN  ? '已設定' : '（選用）'));
  console.log('LINE_CHANNEL_SECRET: ' + (Config.LINE_CHANNEL_SECRET ? '已設定' : '（選用）'));
  console.log('TELEGRAM_API_KEY:    ' + (Config.TELEGRAM_API_KEY    ? '已設定' : '（選用）'));
  console.log('SHEET_ID:            ' + (Config.SHEET_ID            ? '已設定' : '❌ 未設定'));
  console.log('ADMIN_STRING:        ' + (Config.ADMIN_STRING        ? '已設定' : '❌ 未設定'));
  console.log('GEMINI_API_KEY:      ' + (Config.GEMINI_API_KEY      ? '已設定' : '（選用）'));
  console.log('NVIDIA_API_KEY:      ' + (Config.NVIDIA_API_KEY      ? '已設定' : '（選用）'));
  console.log('AI_PROVIDER:         ' + Config.AI_PROVIDER + '  ← env!B3 控制（GEMINI 或 NVIDIA）');
  console.log('DEBUG_MODE:          ' + Config.DEBUG_MODE + '  ← env!B2 控制');
}
