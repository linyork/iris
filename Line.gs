/**
 * Line
 * @description LINE Messaging API 整合介面
 */
var Line = (() => {
  var line = {};

  var getSourceId = (source) => {
    switch (source.type) {
      case 'user':  return source.userId;
      case 'group': return source.groupId;
      case 'room':  return source.roomId;
      default:      return null;
    }
  };

  var sendMsg = (url, payload) => {
    Logger.send('Line.sendMsg', '傳送訊息', payload);
    try {
      UrlFetchApp.fetch(url, {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          Authorization: 'Bearer ' + Config.LINE_CHANNEL_TOKEN
        },
        method:  'post',
        payload: payload
      });
    } catch (ex) {
      Logger.error('Line.sendMsg', '傳送失敗', ex);
    }
  };

  line.isLine = (string) =>
    Utils.isJsonString(string) && JSON.parse(string).hasOwnProperty('events');

  // 只補中立事件形狀需要的兩個欄位。以前這裡還會打一次 /profile 取顯示名稱，
  // 但那個結果全專案沒有任何讀取端 —— doPost 每收一則 LINE 訊息就白花一次
  // UrlFetchApp 往返，而這支執行的時間預算很緊。真的要顯示名稱時再加回來。
  line.init = (event) => {
    event.isMaster = Utils.checkMaster(event.source.userId);
    event.sourceId = getSourceId(event.source);
  };

  line.pushMsg = (userId, message) => {
    try {
      var parts = Utils.splitForLine(Utils.stripTimestampPrefix(message));
      // LINE 單次 push 最多 5 則，超過分批送
      for (var i = 0; i < parts.length; i += 5) {
        var batch = parts.slice(i, i + 5).map(function(t) { return { type: 'text', text: t }; });
        sendMsg(Config.LINE_API_BASE + '/message/push', JSON.stringify({
          to: userId,
          messages: batch
        }));
      }
    } catch (ex) {
      Logger.error('Line.pushMsg', '推送失敗', ex);
    }
  };

  line.replyMsg = (replyToken, message) => {
    try {
      sendMsg(Config.LINE_API_BASE + '/message/reply', JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: 'text', text: Utils.stripTimestampPrefix(message) }]
      }));
    } catch (ex) {
      Logger.error('Line.replyMsg', '回覆失敗', ex);
    }
  };

  return line;
})();
