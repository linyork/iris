/**
 * AdviceLog
 * @description advice_log 分頁：Iris 說過什麼、當時的數字是多少、後來怎麼了
 *
 * alert_log 只記「推播過什麼」用來去重，沒有人回頭看；這張讓 Iris 知道自己建議過什麼。
 *
 * ⚠️ 「後來如何」在讀取時現算（存下建議當下的總資產，用時與現在比），不做排程回填：
 *    少一個 trigger（GAS 只有 20 個額度）；回填的格子隔天就過期，因為那本來就是
 *    相對於現在的問題；回填失敗會留下永遠空白的列而沒有人發現。
 *    代價是讀取時要傳入現在的總資產，呼叫端本來就有。
 *
 * Sheet 結構（不存在就自己建，見 _sheet()）：
 *   A: 時間        yyyy/MM/dd HH:mm:ss
 *   B: 來源        chat / advisor / report
 *   C: 主題        代號或一句話標籤，用來把同一件事的建議串起來
 *   D: 建議        摘要（不是全文，全文在 alert_log 或對話裡）
 *   E: 當下總資產  給「後來如何」當錨點
 *   F: 使用者反應  之後補的（接受／不接受／已執行），可空
 */
var AdviceLog = (() => {
  var al = {};

  var SHEET_NAME = 'advice_log';
  var HEADERS = ['時間', '來源', '主題', '建議', '當下總資產', '使用者反應'];

  /**
   * 取得分頁，不存在就建一個（冪等）。
   * ⚠️ 與 AlertLog 不同（那張找不到就放棄）：這張是新的，安靜地不做事會讓功能
   *    完全沒反應又沒有錯誤，最難查。
   */
  var _sheet = (create) => {
    var ss = SpreadsheetApp.openById(Config.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (sheet || !create) return sheet;

    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);

    // ⚠️ 主題欄一定要設成純文字。topic 多半就是台股代號，而代號有前導零 ——
    //    寫字串進「自動」格式的欄位，Sheets 會判定它像數字，00878 變成 878。
    //    這裡不會讓任何東西報錯，只會讓「同一個 topic 串得起來」這件事默默失效：
    //    下次用 '00878' 去比對，表上躺的是 878，永遠對不上。
    //    同一個坑在 AssetSchema 的 textColumns 已經踩過一次（見那裡的註解）。
    try {
      sheet.getRange(1, 3, sheet.getMaxRows(), 1).setNumberFormat('@');
    } catch (e) {
      Logger.warning('AdviceLog._sheet', '主題欄設純文字失敗，代號前導零可能會掉', e.message);
    }

    Logger.info('AdviceLog._sheet', '建立 advice_log 分頁');
    return sheet;
  };

  /**
   * 記一筆建議
   * @param {object} o
   * @param {string} o.source      chat / advisor / report
   * @param {string} o.topic       主題（代號或短標籤）
   * @param {string} o.advice      建議摘要
   * @param {number} [o.totalAssets] 當下總資產，之後用來算「後來如何」
   * @returns {boolean} 有沒有寫進去
   */
  al.record = (o) => {
    try {
      o = o || {};
      var advice = String(o.advice || '').trim();
      if (!advice) return false;

      var sheet = _sheet(true);
      if (!sheet) return false;

      sheet.appendRow([
        Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss'),
        String(o.source || 'chat'),
        String(o.topic || '').trim(),
        advice,
        (o.totalAssets === null || o.totalAssets === undefined) ? '' : Math.round(o.totalAssets),
        ''
      ]);
      // 這是模型可以宣稱「我記下來了」的動作之一，所以要進帳本寫入計數
      Utils.noteLedgerWrite('advice_log ' + (o.topic || '') + '：' + advice.slice(0, 30));
      Logger.info('AdviceLog.record', '已記錄建議', { source: o.source, topic: o.topic });
      return true;
    } catch (ex) {
      Logger.error('AdviceLog.record', '寫入失敗', ex);
      return false;
    }
  };

  /**
   * 最近 N 天的建議（新到舊）
   */
  al.getRecent = (days) => {
    try {
      days = days || 30;
      var sheet = _sheet(false);
      if (!sheet) return [];
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      var data = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
      var cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      return data
        .filter(r => r[0])
        .map(r => ({
          timestamp:   r[0] instanceof Date ? r[0] : new Date(r[0]),
          source:      String(r[1] || ''),
          topic:       String(r[2] || ''),
          advice:      String(r[3] || ''),
          totalAssets: AssetSchema.num(r[4]),
          reaction:    String(r[5] || '')
        }))
        .filter(r => !isNaN(r.timestamp.getTime()) && r.timestamp >= cutoff)
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch (ex) {
      Logger.error('AdviceLog.getRecent', '讀取失敗', ex);
      return [];
    }
  };

  /**
   * 整理成注入 prompt 用的精簡文字，並**現算**每一筆的後續變化
   *
   * @param {number} [days]         回看幾天（預設 30）
   * @param {number} [currentTotal] 現在的總資產；沒給就不算後續變化（不要自己去讀，
   *                                呼叫端幾乎都已經有這個數字了）
   * @param {number} [limit]        最多幾筆（預設 5）—— 這段會進每一則 prompt
   * @returns {string} 空字串代表沒有東西可講，呼叫端應整段略過
   */
  al.formatForPrompt = (days, currentTotal, limit) => {
    try {
      var rows = al.getRecent(days);
      if (rows.length === 0) return '';

      var lines = ['[我先前給過的建議]（這些是你自己說過的話，主人問起時要認帳；' +
        '相關話題再次出現時主動提，不要假裝沒說過）'];

      rows.slice(0, limit || 5).forEach(r => {
        var ts = Utilities.formatDate(r.timestamp, 'GMT+8', 'MM/dd HH:mm');
        var line = ts + (r.topic ? ' [' + r.topic + ']' : '') + ' ' +
          r.advice.slice(0, 90).replace(/\n/g, ' ');

        // 「後來如何」現算，不存 —— 存下去隔天就過期了
        if (currentTotal > 0 && r.totalAssets > 0) {
          var diff = currentTotal - r.totalAssets;
          var pct  = (diff / r.totalAssets * 100).toFixed(2);
          line += '（當時總資產 ' + Math.round(r.totalAssets).toLocaleString() +
            '，至今 ' + (diff >= 0 ? '+' : '') + Math.round(diff).toLocaleString() +
            '，' + (diff >= 0 ? '+' : '') + pct + '%）';
        }
        if (r.reaction) line += '［主人反應：' + r.reaction + '］';
        lines.push('▸ ' + line);
      });

      return lines.join('\n');
    } catch (ex) {
      Logger.warning('AdviceLog.formatForPrompt', '整理失敗（已略過）',
        ex && ex.message ? ex.message : String(ex));
      return '';
    }
  };

  /**
   * 清掉超過 180 天的紀錄（接 dailyCleanUp）
   *
   * 比 alert_log 的 60 天長很多，因為這張表的價值就在時間跨度 ——
   * 「你三個月前說要降現金比例」正是它存在的理由。
   */
  al.cleanOld = () => {
    try {
      var sheet = _sheet(false);
      if (!sheet) return;
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return;

      var cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 180);

      var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      var toDelete = [];
      for (var i = data.length - 1; i >= 0; i--) {
        if (data[i][0] && new Date(data[i][0]) < cutoff) toDelete.push(i + 2);
      }
      toDelete.forEach(r => sheet.deleteRow(r));
      if (toDelete.length > 0) {
        Logger.info('AdviceLog.cleanOld', '清除舊建議 ' + toDelete.length + ' 筆');
      }
    } catch (ex) {
      Logger.error('AdviceLog.cleanOld', '清理失敗', ex);
    }
  };

  return al;
})();
