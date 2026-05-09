/**
 * Logger
 * @description 統一的日誌門面，路由至 GoogleSheet.setLog
 */
var Logger = (() => {
  var log = (level, tag, message, details) => {
    try {
      var detailStr = '';
      if (details !== undefined && details !== null) {
        detailStr = (typeof details === 'object') ? JSON.stringify(details) : String(details);
      }
      GoogleSheet.setLog(level, tag, String(message), detailStr);
    } catch (e) { /* 靜默失敗，避免 log 本身炸掉主流程 */ }
  };

  return {
    info:    (tag, message, details) => log('INFO',    tag, message, details),
    warning: (tag, message, details) => log('WARNING', tag, message, details),
    error:   (tag, message, details) => log('ERROR',   tag, message, details),
    send:    (tag, message, details) => log('SEND',    tag, message, details),
    ai:      (type, caller, message, details) => {
      if (!Config.DEBUG_MODE) return;
      log('AI_' + type, caller, message, details);
    }
  };
})();
