/**
 * Cron
 * @description 排程登記處 —— 「什麼時候會跑什麼」只看這一個檔案
 *
 * 底下的 `SCHEDULE` 是唯一的事實來源：`Cron.setup()` 照它重建所有 Trigger，
 * `Cron.list()` 拿它跟 GAS 上實際註冊的比對。要改排程就改這張表。
 *
 * ⚠️ **處理函式本身留在各自的模組**（`dailyReport` 在 `DailyReport.gs`、
 * `setData` 在 `DataSync.gs`……）。排程檔只登記「誰、什麼時候」，不搬邏輯 ——
 * 報表怎麼寫是報表模組的事，搬過來只會讓兩邊都難找。
 *
 * ⚠️ GAS 的 `atHour(9)` 是「9:00~10:00 之間某個時刻」，不是 9:00 整。
 * 所以**不要用排程順序來保證資料新舊** —— 需要新鮮數字的任務自己在進入點
 * 先呼叫 `Position.rebuild()`，這比祈禱 8 點那班先跑完可靠得多。
 */
var Cron = (() => {
  var cron = {};

  /**
   * type: 'daily' | 'weekday' | 'monthday'
   * fn 必須是**頂層函式的名字**（GAS 以名稱綁定），改名就等於讓排程失效。
   */
  cron.SCHEDULE = [
    { fn: 'dailyCleanUp',        type: 'daily',    hour: 4,
      what: '清過期短期記憶、10 天前的 consolelog、30 天前的對話' },

    { fn: 'dailyReport',         type: 'daily',    hour: 9,
      what: '財經早報（週末不發）。進入點會自己先 rebuild 一次' },

    { fn: 'marketAlert',         type: 'daily',    hour: 10,
      what: '盤中異動警報（第一次）' },

    { fn: 'rebuildAssets',       type: 'daily',    hour: 13,
      what: '收盤後重算持倉／面板／配置，讓儀表板與 Mini App 看到當日結果' },

    { fn: 'marketAlert',         type: 'daily',    hour: 14,
      what: '盤中異動警報（第二次）' },

    { fn: 'setData',             type: 'daily',    hour: 18,
      what: '把當日狀態寫進「每日快照」。進入點會自己先 rebuild 一次' },

    { fn: 'advisorCheckEvening', type: 'daily',    hour: 19,
      what: '主動顧問感知：讀快照 + 決策清單，由 LLM 判斷要不要推播' },

    { fn: 'weeklyReport',        type: 'weekday',  hour: 9, day: 'SATURDAY',
      what: '週度績效回顧' },

    { fn: 'monthlyReport',       type: 'monthday', hour: 10, day: 1,
      what: '月度總結（10:00 避開早報的 9:00）' }
  ];

  /**
   * 一次性重試的進入點（實作在 `DailyReport.gs`）。
   *
   * 這些**不在 SCHEDULE 裡**，因為它們沒有固定時間 —— 是報告產生失敗的當下才被
   * `_scheduleReportRetry()` 排出來、跑完就自己刪掉的臨時 trigger。登記在這裡只
   * 為了一件事：讓 `cron.list()` 認得它們。否則一個正在等待的重試會被報成
   * 「多出來的，可能是手動建的」，而假警報正是排程檔最不該製造的東西。
   *
   * 看到它們短暫出現在 list() 裡是正常的；長期賴著不走才代表 `_deleteTriggersFor`
   * 沒跑到（例如那次重試又被 GAS 砍掉），可以手動刪。
   */
  cron.ONESHOT = ['dailyReportRetry', 'weeklyReportRetry', 'monthlyReportRetry'];

  /**
   * 依 SCHEDULE 重建所有 Trigger。
   * ⚠️ 會先清掉**所有**既有 Trigger，包含你手動在觸發條件頁面建的，
   *    以及還在等待中的一次性重試（無妨 —— 下次失敗會再排）。
   */
  cron.setup = () => {
    var old = ScriptApp.getProjectTriggers();
    old.forEach(t => ScriptApp.deleteTrigger(t));

    cron.SCHEDULE.forEach(s => {
      var b = ScriptApp.newTrigger(s.fn).timeBased();
      if (s.type === 'weekday') {
        b = b.onWeekDay(ScriptApp.WeekDay[s.day]).atHour(s.hour);
      } else if (s.type === 'monthday') {
        b = b.onMonthDay(s.day).atHour(s.hour);
      } else {
        b = b.atHour(s.hour).everyDays(1);
      }
      b.create();
    });

    Logger.info('Cron.setup', '重建排程', { removed: old.length, created: cron.SCHEDULE.length });
    return { removed: old.length, created: cron.SCHEDULE.length };
  };

  /**
   * 列出 GAS 上實際註冊的 Trigger，並與 SCHEDULE 比對。
   * 刪掉任何 trigger 進入點之前先跑這個 —— 指向不存在的函式會每天靜默失敗。
   */
  cron.list = () => {
    var actual = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
    var wanted = cron.SCHEDULE.map(s => s.fn);

    var count = (arr, x) => arr.filter(v => v === x).length;
    var names = wanted.concat(actual).filter((v, i, a) => a.indexOf(v) === i).sort();

    var lines = ['【排程比對】實際 ' + actual.length + ' 個 / 登記 ' + wanted.length + ' 個'];
    names.forEach(n => {
      var w = count(wanted, n), a = count(actual, n);

      // 一次性重試不該出現在 SCHEDULE 裡，所以「登記 0 / 實際 1」是它的正常狀態，
      // 不是缺漏也不是多餘 —— 照一般規則標會變成每次失敗後都跳一個假的 ✗。
      if (cron.ONESHOT.indexOf(n) !== -1 && w === 0) {
        lines.push('  ⏳ ' + n + '：一次性重試等待中（' + a + ' 個），跑完會自己刪');
        return;
      }

      var mark = (w === a) ? '✓' : '✗';
      lines.push('  ' + mark + ' ' + n + '：登記 ' + w + ' / 實際 ' + a +
        (w === a ? '' : (a === 0 ? '  ← 沒註冊，跑 setupAllTriggers()' : '  ← 多出來的，可能是手動建的')));
    });

    lines.push('');
    cron.SCHEDULE.forEach(s => {
      var when = s.type === 'weekday' ? '每週' + s.day + ' ' + s.hour + ':00'
               : s.type === 'monthday' ? '每月 ' + s.day + ' 日 ' + s.hour + ':00'
               : '每日 ' + s.hour + ':00';
      lines.push('  ' + when + '　' + s.fn + '　' + s.what);
    });
    return lines.join('\n');
  };

  return cron;
})();

// ─── Trigger 進入點：只在這裡登記，實作留在各模組 ─────────────────

/**
 * 收盤後重算，讓儀表板與 Mini App 看到當日結果。
 *
 * 為什麼需要這班：`持倉` 與 `面板` 的市價、市值是活公式，但 `指標` 與 `配置`
 * 是重算當下算好寫死的值，而 `Snapshot` 的「今天總資產」讀的正是 `指標`。
 * 沒有這班，那個數字就會停在最後一次寫入交易的時間點。
 */
function rebuildAssets() {
  try {
    var r = Position.rebuild();
    Logger.info('rebuildAssets', '排程重算完成', r);
    return r;
  } catch (ex) {
    Logger.error('rebuildAssets', '排程重算失敗', ex && ex.message ? ex.message : String(ex));
  }
}
