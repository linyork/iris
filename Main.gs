/**
 * Main
 * @description 系統入口點 — 接收 LINE Webhook 並分發處理
 */

/**
 * LINE Webhook 處理程序
 * @param {object} e - Google Apps Script doPost 事件
 */
function doPost(e) {
  try {
    if (!Line.isLine(e.postData.contents)) return;

    var jsonData = JSON.parse(e.postData.contents);
    if (!jsonData.events) return;

    var cache = CacheService.getScriptCache();

    for (var i = 0; i < jsonData.events.length; i++) {
      var event = jsonData.events[i];

      // 防止重複事件
      var eventId = event.webhookEventId;
      if (eventId) {
        if (cache.get(eventId)) {
          Logger.info('doPost', '忽略重複事件', eventId);
          continue;
        }
        cache.put(eventId, '1', 60);
      }

      Line.init(event);

      if (event.type !== 'message' || event.message.type !== 'text') continue;

      Logger.info('doPost', '收到訊息', {
        userId: event.source.userId,
        msg:    event.message.text.slice(0, 80)
      });

      // 非主人拒絕服務
      if (!Line.event.isMaster) {
        Line.replyMsg(event.replyToken, '抱歉，我是專屬助理，無法為您提供服務。');
        Logger.info('doPost', '拒絕非主人用戶', event.source.userId);
        continue;
      }

      var reply = ChatBot.reply(Line.event);
      if (reply) {
        Line.pushMsg(event.source.userId, reply);
      }
    }
  } catch (error) {
    Logger.error('doPost', 'Webhook 處理失敗', error);
  }
}

/**
 * 每日例行清理（建議設定 Time-based trigger，每天凌晨 4 點執行）
 * - 清除已過期的短期記憶
 * - 清除超過保留天數的對話歷史
 */
function dailyCleanUp() {
  try {
    GoogleSheet.cleanExpiredShortTermMemories();

    // 清除超過 30 天的 chat 紀錄
    var sheet = SpreadsheetApp.openById(Config.SHEET_ID).getSheetByName('chat');
    if (sheet) {
      var cutoff  = new Date();
      cutoff.setDate(cutoff.getDate() - Config.CHAT_CLEANUP_DAYS);
      var lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        var data    = sheet.getRange(2, 4, lastRow - 1, 1).getValues(); // 第 4 欄是 timestamp
        var toDelete = [];
        for (var i = data.length - 1; i >= 0; i--) {
          if (data[i][0] && new Date(data[i][0]) < cutoff) toDelete.push(i + 2);
        }
        toDelete.forEach(r => sheet.deleteRow(r));
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

    console.log('✅ Trigger 設定完成：');
    console.log('   每日 04:00 → dailyCleanUp');
    console.log('   每日 09:00 → dailyReport');
    console.log('   每日 10:00 → marketAlert');
    console.log('   每日 14:00 → marketAlert');
    console.log('   每週六 09:00 → weeklyReport');
    console.log('   每月 1 日 10:00 → monthlyReport');
    console.log('   每日 18:00 → setData');
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
  var requiredSheets = ['env', 'consolelog', 'chat', 'short_term_memory', 'knowledge'];
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
  console.log('LINE_CHANNEL_TOKEN:  ' + (Config.LINE_CHANNEL_TOKEN  ? '已設定' : '❌ 未設定'));
  console.log('LINE_CHANNEL_SECRET: ' + (Config.LINE_CHANNEL_SECRET ? '已設定' : '❌ 未設定'));
  console.log('SHEET_ID:            ' + (Config.SHEET_ID            ? '已設定' : '❌ 未設定'));
  console.log('ADMIN_STRING:        ' + (Config.ADMIN_STRING        ? '已設定' : '❌ 未設定'));
  console.log('GEMINI_API_KEY:      ' + (Config.GEMINI_API_KEY      ? '已設定' : '（選用）'));
  console.log('NVIDIA_API_KEY:      ' + (Config.NVIDIA_API_KEY      ? '已設定' : '（選用）'));
  console.log('AI_PROVIDER:         ' + Config.AI_PROVIDER + '  ← env!B3 控制（GEMINI 或 NVIDIA）');
  console.log('DEBUG_MODE:          ' + Config.DEBUG_MODE + '  ← env!B2 控制');
}
