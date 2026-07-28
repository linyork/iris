/**
 * Telegram
 * @description Telegram Bot API 整合介面
 *
 * 介面刻意鏡射 Line.gs：normalizeEvent() 把 Telegram update 轉成與 LINE event
 * 相同形狀的中立物件（source.userId / message.type,text / replyToken），
 * 讓 ChatBot 不用區分平台就能直接讀取欄位。
 *
 * 註：Telegram 沒有 LINE 的一次性 replyToken 機制，sendMessage 只需要 chat_id
 *     且無時效限制，故 normalizeEvent 直接把 chat_id 塞進 event.replyToken 沿用既有欄位。
 * 註：Apps Script doPost(e) 讀不到 HTTP header，無法驗證 Telegram 建議的 secret token；
 *     防線與 LINE 相同 —— Utils.checkMaster 對 event.source.userId 做 allowlist 過濾
 *     （Telegram 數字 ID 加前綴 "TELEGRAM:" 以跟 LINE ID 區分）。
 */
var Telegram = (() => {
  var telegram = {};

  // Telegram 單則訊息上限 4096 字，留 buffer 切在 4000
  var TG_LIMIT = 4000;

  var cleanMessage = (message) =>
    Utils.stripMarkdown(Utils.stripTimestampPrefix(message));

  var sendMsg = (chatId, message) => {
    Logger.send('Telegram.sendMsg', '傳送訊息', message);
    try {
      UrlFetchApp.fetch(Config.TELEGRAM_API_BASE + '/sendMessage', {
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        method:  'post',
        payload: JSON.stringify({ chat_id: chatId, text: message })
      });
    } catch (ex) {
      Logger.error('Telegram.sendMsg', '傳送失敗', ex);
    }
  };

  telegram.isTelegram = (string) => {
    if (!Utils.isJsonString(string)) return false;
    var data = JSON.parse(string);
    return data.hasOwnProperty('update_id') &&
           (data.hasOwnProperty('message') || data.hasOwnProperty('edited_message'));
  };

  /**
   * 把 Telegram update 轉成與 LINE event 相同形狀的中立事件物件
   * @param {object} update - Telegram webhook update
   * @returns {object} 中立事件物件
   */
  telegram.normalizeEvent = (update) => {
    var msg    = update.message || update.edited_message;
    var chatId = String(msg.chat.id);

    return {
      webhookEventId: 'tg_' + update.update_id,
      platform:   'TELEGRAM',
      replyToken: chatId,
      sourceId:   chatId,
      source: {
        type:   (msg.chat.type === 'private') ? 'user' : 'group',
        userId: 'TELEGRAM:' + msg.from.id
      },
      message: {
        type: 'text',
        text: msg.text || msg.caption || '',
        id:   String(msg.message_id)
      }
    };
  };

  /**
   * 推送訊息（長訊息自動分段 —— 早報/週報/月報常超過 Telegram 4096 字上限）
   * @param {string} chatId - Telegram chat ID
   * @param {string} message - 訊息文字
   */
  telegram.pushMsg = (chatId, message) => {
    try {
      var parts = Utils.splitForLine(cleanMessage(message), TG_LIMIT);
      parts.forEach(part => sendMsg(chatId, part));
    } catch (ex) {
      Logger.error('Telegram.pushMsg', '推送失敗', ex);
    }
  };

  /**
   * 回覆訊息（Telegram 無時效性 replyToken，實質與 pushMsg 相同）
   * @param {string} chatId - 沿用 event.replyToken 傳入
   * @param {string} message - 訊息文字
   */
  telegram.replyMsg = (chatId, message) => {
    telegram.pushMsg(chatId, message);
  };

  /**
   * 送出「正在輸入…」狀態（約 5 秒或直到下一則訊息送出）
   * 讓使用者等待 ReAct 迴圈時馬上看到反應，降低誤以為沒送出而重複發送
   * @param {string} chatId - Telegram chat ID
   */
  telegram.sendTyping = (chatId) => {
    try {
      UrlFetchApp.fetch(Config.TELEGRAM_API_BASE + '/sendChatAction', {
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        method:  'post',
        payload: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        muteHttpExceptions: true
      });
    } catch (ex) {
      Logger.error('Telegram.sendTyping', '傳送輸入中狀態失敗', ex);
    }
  };

  /**
   * 註冊 Telegram Webhook（一次性設定，於 GAS 編輯器手動執行 setupTelegramWebhook）
   * @param {string} webAppUrl - 已部署的 GAS Web App /exec URL
   */
  telegram.setupWebhook = (webAppUrl) => {
    var response = UrlFetchApp.fetch(Config.TELEGRAM_API_BASE + '/setWebhook', {
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      method:  'post',
      payload: JSON.stringify({
        url: webAppUrl,
        // 只收一般訊息，過濾 edited_message / my_chat_member 等雜訊
        allowed_updates: ['message'],
        // 重設時清掉積壓的舊 update（含逾時重送、尚未消化的那些）
        drop_pending_updates: true,
        // 一次只投遞一則、收到回應才送下一則 —— 消除多個 doPost 併發搶去重快取的競態
        max_connections: 1
      })
    });
    Logger.info('Telegram.setupWebhook', 'setWebhook 回應: ' + response.getContentText());
    return response.getContentText();
  };

  /**
   * 註冊斜線指令選單（輸入框旁的 "/" 清單）
   *
   * 純粹是 UI 提示：使用者點選後 Telegram 送出的仍是普通文字訊息，
   * 實際處理在 Commands.tryHandle。清單來源與分派共用 Commands 的定義。
   *
   * @returns {string} Bot API 回應
   */
  telegram.setupCommands = () => {
    var response = UrlFetchApp.fetch(Config.TELEGRAM_API_BASE + '/setMyCommands', {
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      method:  'post',
      payload: JSON.stringify({ commands: Commands.getDefinitions() }),
      muteHttpExceptions: true
    });
    Logger.info('Telegram.setupCommands', 'setMyCommands 回應: ' + response.getContentText());
    return response.getContentText();
  };

  return telegram;
})();
