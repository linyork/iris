/**
 * Logger
 * @description 統一的日誌門面，路由至 GoogleSheet.setLog
 */
var Logger = (() => {
  // ⚠️ 例外不能直接丟給 JSON.stringify —— `message` 與 `stack` 是不可列舉屬性，
  //    `JSON.stringify(new Error('boom'))` 得到的是 `{}`。GAS 的例外物件只有
  //    `name` 是可列舉的，所以整份 consolelog 裡的每一筆 `Logger.error(tag, msg, ex)`
  //    都只留下 `{"name":"Exception"}` —— 有記等於沒記。
  //    2026-08-06 起 `StockPrice._fetch` 連續失敗好幾天，就是因為這個查不出原因。
  var _detail = (d) => {
    if (d === undefined || d === null) return '';
    if (typeof d !== 'object') return String(d);
    if (typeof d.message === 'string' && (typeof d.stack === 'string' || d instanceof Error)) {
      return JSON.stringify({
        name:    String(d.name || 'Error'),
        message: String(d.message),
        // 堆疊留前幾行就夠定位，整份塞進儲存格只會把日誌撐爆
        stack:   String(d.stack || '').split('\n').slice(0, 4).join(' | ')
      });
    }
    var s = JSON.stringify(d);
    // stringify 吐出空物件但物件本身有話可說（例外的子類、GAS 的原生物件）
    return (s === '{}' && String(d) !== '[object Object]') ? String(d) : s;
  };

  // consolelog 寫不進去時，改寫到 GAS 的執行紀錄（Apps Script 編輯器 → 執行項目）。
  // 2026-11-07、11-10 每日快照在重算完成後就沒了下文：連一列錯誤都沒有。最可能的是
  // 試算表服務出錯，而記錄那個錯誤的 consolelog 在同一份試算表上，跟著寫不進去 ——
  // 以前兩層都靜默吞掉，所以到底發生什麼事已經查不到了。
  // ⚠️ 只在寫失敗時才走 console：每一列都寫兩份的話，執行紀錄會被雜訊淹掉。
  var _fallback = (level, tag, message, detail, why) => {
    try {
      var line = '[consolelog 寫入失敗' + (why ? '：' + why : '') + '] ' +
        level + ' ' + tag + ' ' + message + (detail ? ' ' + detail : '');
      if (level === 'ERROR') console.error(line); else console.log(line);
    } catch (e) { /* 連 console 都不行就真的沒辦法了 */ }
  };

  var log = (level, tag, message, details) => {
    var detail = '';
    try {
      detail = _detail(details);
      if (!GoogleSheet.setLog(level, tag, String(message), detail)) {
        _fallback(level, tag, String(message), detail, '');
      }
    } catch (e) {
      // 避免 log 本身炸掉主流程
      _fallback(level, tag, String(message), detail, e && e.message ? e.message : String(e));
    }
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
