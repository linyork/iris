/**
 * MessagingServiceFactory
 * @description 訊息平台派發層
 *
 * doPost 判斷來源平台後，下游一律透過這裡送出回覆/推播，呼叫端不再直接判斷
 * 要用 Line 還是 Telegram。派發方式與 AIServiceFactory 依 Config.AI_PROVIDER
 * 派發 Gemini/NVIDIA 的模式一致：
 *   - reply / indicateTyping：依 event.platform（doPost 判斷來源時已標記）
 *   - push：依 userId 前綴（"TELEGRAM:" 視為 Telegram，其餘視為 LINE，
 *           向下相容 ADMIN_STRING 與 chat/knowledge 表裡既有的 LINE userId）
 */
var MessagingServiceFactory = (() => {
  var factory = {};

  var isTelegramUserId = (userId) => !!userId && userId.indexOf('TELEGRAM:') === 0;

  /**
   * 回覆訊息（對應 doPost 收到的 event）
   * @param {object} event - 中立事件物件（含 platform、replyToken）
   * @param {string} message - 訊息文字
   */
  factory.reply = (event, message) => {
    if (event.platform === 'TELEGRAM') {
      Telegram.replyMsg(event.replyToken, message);
    } else {
      Line.replyMsg(event.replyToken, message);
    }
  };

  /**
   * 推播訊息給指定使用者（早報、盤中警報、顧問提醒等主動訊息）
   * @param {string} userId - Telegram 為 "TELEGRAM:<id>"，LINE 維持原樣不加前綴
   * @param {string} message - 訊息文字
   */
  factory.push = (userId, message) => {
    if (isTelegramUserId(userId)) {
      Telegram.pushMsg(userId.slice('TELEGRAM:'.length), message);
    } else {
      Line.pushMsg(userId, message);
    }
  };

  /**
   * 送出「正在輸入…」狀態提示（開始處理、尚未產生回覆前呼叫）
   * @param {object} event - 中立事件物件（含 platform、sourceId）
   * @note LINE 無對等的簡易 typing API，直接略過（不影響流程）
   * @note 純提示性質，ReAct 迴圈每輪都會呼叫。失敗絕不能影響主回覆流程，
   *       故這裡完全吞掉例外（Telegram.sendTyping 內部另有自己的 try/catch）。
   */
  factory.indicateTyping = (event) => {
    try {
      if (event && event.platform === 'TELEGRAM') {
        Telegram.sendTyping(event.sourceId);
      }
    } catch (ex) {
      Logger.error('MessagingServiceFactory.indicateTyping', '狀態提示失敗（已忽略）', ex);
    }
  };

  return factory;
})();
