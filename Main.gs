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

      // document 是上傳的檔案（目前只有 Telegram 會送），下面會分流給 AssetImport
      if (!event.message || (event.message.type !== 'text' && event.message.type !== 'document')) continue;

      Logger.info('doPost', '收到訊息', {
        userId: event.source.userId,
        msg:    event.message.type === 'document'
                  ? '[檔案] ' + (event.message.document || {}).fileName
                  : event.message.text.slice(0, 80)
      });

      // 非主人事件靜默忽略：Telegram bot 公開可搜尋，任何人都能 DM。
      // 不回覆（避免反射放大）、不寫 chat history、不消耗 LLM 配額。
      if (!event.isMaster) {
        Logger.info('doPost', '忽略非主人事件', event.source.userId);
        continue;
      }

      // 開始處理就先送「正在輸入…」，讓使用者馬上看到反應
      MessagingServiceFactory.indicateTyping(event);

      // 上傳檔案走自己的路：不進 ChatBot，也不花 LLM 配額。
      // 券商匯出的 CSV 是結構化資料，交給模型改寫只會多一層出錯的機會。
      if (event.message.type === 'document') {
        var fileReply = AssetImport.fromUpload(event);
        if (fileReply) MessagingServiceFactory.push(event.source.userId, fileReply);
        continue;
      }

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
  var view = (e && e.parameter && e.parameter.view) || '';

  // Telegram Mini App：走 /exec（匿名）進來，因為 Google 登入在 Telegram 的
  // 內嵌 webview 裡走不通。這裡回的頁面**不含任何資料**，資料要等前端把 initData
  // 送回 miniAppData / miniAppAsk、通過 MiniApp.verifyInitData 驗簽後才發。
  if (view === 'tg') {
    return HtmlService.createHtmlOutputFromFile('MiniAppPage')
      .setTitle('Iris')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  }

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
