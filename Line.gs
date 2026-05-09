/**
 * Line
 * @description LINE Messaging API 整合介面
 */
var Line = (() => {
  var line = {};
  line.event = {};

  var verifySignature = (e) => {
    try {
      if (!Config.LINE_CHANNEL_SECRET) return true;
      var signature = e.parameter['X-Line-Signature'] || e.parameter['x-line-signature'];
      if (!signature) return false;
      var hash = Utilities.computeHmacSha256Signature(
        Utilities.newBlob(e.postData.contents).getBytes(),
        Config.LINE_CHANNEL_SECRET
      );
      return signature === Utilities.base64Encode(hash);
    } catch (ex) {
      Logger.error('Line.verifySignature', '簽章驗證失敗', ex);
      return false;
    }
  };

  var getSourceId = (source) => {
    switch (source.type) {
      case 'user':  return source.userId;
      case 'group': return source.groupId;
      case 'room':  return source.roomId;
      default:      return null;
    }
  };

  var getProfile = (source) => {
    try {
      var url = '';
      switch (source.type) {
        case 'user':  url = Config.LINE_API_BASE + '/profile/' + source.userId; break;
        case 'group': url = Config.LINE_API_BASE + '/group/' + source.groupId + '/member/' + source.userId; break;
        case 'room':  url = Config.LINE_API_BASE + '/room/' + source.roomId + '/member/' + source.userId; break;
        default: return { userId: null, displayName: null };
      }
      return JSON.parse(UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + Config.LINE_CHANNEL_TOKEN }
      }).getContentText());
    } catch (ex) {
      Logger.error('Line.getProfile', '取得個人檔案失敗', ex);
      return { userId: null, displayName: null };
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

  line.init = (event) => {
    event.isMaster = Utils.checkMaster(event.source.userId);
    event.profile  = getProfile(event.source);
    event.sourceId = getSourceId(event.source);
    line.event = event;
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
