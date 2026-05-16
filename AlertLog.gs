/**
 * AlertLog
 * @description alert_log sheet 讀寫封裝，用於通知去重與可追溯
 *
 * Sheet 結構：
 *   A: timestamp         (yyyy/MM/dd HH:mm:ss)
 *   B: trigger_source    ('10:00' / '14:00' / '18:00' / 'manual')
 *   C: decision_ref      (對應 knowledge 的決策標籤，若無則空)
 *   D: message           (實際發送的訊息全文)
 *   E: snapshot_summary  (當下關鍵指標摘要)
 */
var AlertLog = (() => {
  var al = {};

  var SHEET_NAME = 'alert_log';

  /**
   * 寫入一筆通知記錄
   */
  al.record = (triggerSource, decisionRef, message, snapshotSummary) => {
    try {
      var sheet = SpreadsheetApp.openById(Config.SHEET_ID).getSheetByName(SHEET_NAME);
      if (!sheet) {
        Logger.warning('AlertLog.record', '找不到 alert_log sheet');
        return;
      }
      var ts = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
      sheet.appendRow([
        ts,
        triggerSource || '',
        decisionRef || '',
        String(message || ''),
        String(snapshotSummary || '')
      ]);
      Logger.info('AlertLog.record', '已記錄通知', { source: triggerSource, ref: decisionRef });
    } catch (ex) {
      Logger.error('AlertLog.record', '寫入失敗', ex);
    }
  };

  /**
   * 讀取最近 N 天的通知記錄
   * @param {number} days 預設 7 天
   * @returns {Array<{timestamp, triggerSource, decisionRef, message, snapshotSummary}>}
   */
  al.getRecent = (days) => {
    try {
      days = days || 7;
      var sheet = SpreadsheetApp.openById(Config.SHEET_ID).getSheetByName(SHEET_NAME);
      if (!sheet) return [];
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      var data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
      var cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      return data
        .filter(r => r[0])
        .map(r => ({
          timestamp:       r[0] instanceof Date ? r[0] : new Date(r[0]),
          triggerSource:   String(r[1] || ''),
          decisionRef:     String(r[2] || ''),
          message:         String(r[3] || ''),
          snapshotSummary: String(r[4] || '')
        }))
        .filter(r => !isNaN(r.timestamp.getTime()) && r.timestamp >= cutoff)
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch (ex) {
      Logger.error('AlertLog.getRecent', '讀取失敗', ex);
      return [];
    }
  };

  /**
   * 將最近通知整理成 LLM 可讀的精簡文字（避免塞太多 token）
   */
  al.formatForPrompt = (days) => {
    var recent = al.getRecent(days);
    if (recent.length === 0) return '（最近無通知記錄）';
    return recent.slice(0, 10).map(r => {
      var ts = Utilities.formatDate(r.timestamp, 'GMT+8', 'MM/dd HH:mm');
      var ref = r.decisionRef ? '[' + r.decisionRef + '] ' : '';
      return ts + ' ' + ref + r.message.slice(0, 80).replace(/\n/g, ' ');
    }).join('\n');
  };

  /**
   * 每日清理超過 60 天的舊記錄（接 dailyCleanUp 呼叫）
   */
  al.cleanOld = () => {
    try {
      var sheet = SpreadsheetApp.openById(Config.SHEET_ID).getSheetByName(SHEET_NAME);
      if (!sheet) return;
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return;

      var cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 60);

      var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      var toDelete = [];
      for (var i = data.length - 1; i >= 0; i--) {
        if (data[i][0] && new Date(data[i][0]) < cutoff) toDelete.push(i + 2);
      }
      toDelete.forEach(r => sheet.deleteRow(r));
      if (toDelete.length > 0) {
        Logger.info('AlertLog.cleanOld', '清除舊通知 ' + toDelete.length + ' 筆');
      }
    } catch (ex) {
      Logger.error('AlertLog.cleanOld', '清理失敗', ex);
    }
  };

  return al;
})();
