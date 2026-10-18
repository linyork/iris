/**
 * Diag
 * @description 唯讀診斷入口：不經 Google 登入就能看到試算表與排程的**即時**狀態
 *
 *   GET /exec?view=diag&key=<DIAG_KEY>&what=<...>
 *
 *   what=summary（預設）  分頁清單 + 排程比對 + 最近 30 筆 consolelog
 *   what=sheets           每張分頁的名稱、列數、欄數、是否隱藏
 *   what=triggers         GAS 上實際註冊的排程，與 Cron.SCHEDULE 的比對
 *   what=log              consolelog 尾端；可加 n / level / tag / since 篩選
 *   what=chat             chat 尾端；可加 n / since
 *   what=sheet&name=指標  任一分頁的標題列 + 尾端 n 列
 *   what=sheet&name=每日快照&from=2025-08-30&to=2025-09-02
 *                         改成依「日期」欄（沒有就第一欄）取 from～to（含）的列，前 n 列
 *
 * 為什麼要有它：Drive 連接器讀到的是快取，而且會截斷 —— 2026-10-08 它還列著
 * 主人已經手動刪掉的分頁。這個入口跑在 GAS 裡、直接讀試算表，拿到的就是當下。
 *
 * ⚠️ /exec 是匿名可達的（Telegram webhook 需要），所以閘門全在 DIAG_KEY：
 *    - 沒設、或短於 16 字 → 整個入口關閉，不是「不用密碼」
 *    - 金鑰不符一律回 Not Found，和儀表板一樣，不透露這個入口存在
 *    - 只讀不寫。不要在這裡加任何會改資料的動作 —— 金鑰在網址上，
 *      會留在 Google 的存取紀錄裡，它擋得住路人，不該拿來擋寫入。
 * ⚠️ 不寫 consolelog。診斷本身就是拿來讀 log 的，每次查詢都留一筆只會把要看的東西擠掉。
 */
var Diag = (() => {
  var d = {};

  var MAX_N   = 500;    // 一次最多回幾列
  var MAX_SCAN = 5000;  // 有篩選時最多往回掃幾列
  var MAX_CELL = 4000;  // 單格文字上限（chat 的回覆可能很長）

  /** 金鑰比對。逐字元 XOR 而不是 ===，避免用回應時間猜出前綴。 */
  d.authorized = (key) => {
    var want = String(Config.DIAG_KEY || '');
    if (want.length < 16) return false;
    key = String(key || '');
    if (key.length !== want.length) return false;
    var diff = 0;
    for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ key.charCodeAt(i);
    return diff === 0;
  };

  /** 儲存格 → 可序列化的值。Date 轉成 GMT+8 字串，否則 JSON 會給 UTC 的 ISO 格式。 */
  var _cell = (v) => {
    if (v instanceof Date) return Utilities.formatDate(v, 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
    if (typeof v === 'string' && v.length > MAX_CELL) return v.slice(0, MAX_CELL) + '…（截斷）';
    return v;
  };

  var _n = (raw, dflt) => {
    var n = parseInt(raw, 10);
    if (!(n > 0)) n = dflt;
    return Math.min(n, MAX_N);
  };

  var _ss = () => SpreadsheetApp.openById(Config.SHEET_ID);

  /**
   * 分頁尾端 n 列（不含標題列）。有 keep 篩選時往回多掃一段再挑。
   * @returns {{header: Array, rows: Array<Array>, total: number}}
   */
  var _tail = (sheet, n, keep) => {
    var last = sheet.getLastRow();
    var cols = Math.max(sheet.getLastColumn(), 1);
    var header = sheet.getRange(1, 1, 1, cols).getValues()[0].map(_cell);
    if (last < 2) return { header: header, rows: [], total: 0 };

    var scan  = Math.min(last - 1, keep ? MAX_SCAN : n);
    var start = last - scan + 1;
    var rows  = sheet.getRange(start, 1, scan, cols).getValues().map(r => r.map(_cell));
    if (keep) rows = rows.filter(keep);
    return { header: header, rows: rows.slice(-n), total: last - 1 };
  };

  d.sheets = () => _ss().getSheets().map(s => ({
    name:   s.getName(),
    rows:   s.getLastRow(),
    cols:   s.getLastColumn(),
    hidden: typeof s.isSheetHidden === 'function' ? s.isSheetHidden() : null
  }));

  d.triggers = () => ({
    actual: ScriptApp.getProjectTriggers().map(t => ({
      fn:   t.getHandlerFunction(),
      type: String(t.getEventType())
    })),
    diff: Cron.list()
  });

  /**
   * consolelog 尾端。欄位：timestamp, level, tag, message, details。
   * since 用字串比較（'2026/10/08' 或 '2026/10/08 09:00:00'），時間戳已是同一格式。
   */
  d.log = (p) => {
    var sheet = _ss().getSheetByName('consolelog');
    if (!sheet) return { error: '找不到 consolelog' };
    var level = String(p.level || '').toUpperCase();
    var tag   = String(p.tag || '');
    var since = String(p.since || '');
    var keep  = (level || tag || since) ? (r) =>
      (!level || String(r[1]).toUpperCase() === level) &&
      (!tag   || String(r[2]).indexOf(tag) >= 0) &&
      (!since || String(r[0]) >= since) : null;
    return _tail(sheet, _n(p.n, 100), keep);
  };

  d.chat = (p) => {
    var sheet = _ss().getSheetByName('chat');
    if (!sheet) return { error: '找不到 chat' };
    var since = String(p.since || '');
    return _tail(sheet, _n(p.n, 20), since ? (r) => String(r[3]) >= since : null);
  };

  /** 'yyyy-MM-dd'／'yyyy/MM/dd'（可帶時間）或 Date → 'yyyy-MM-dd'；讀不出來回 '' */
  var _day = (v) => {
    if (v instanceof Date) return Utilities.formatDate(v, 'GMT+8', 'yyyy-MM-dd');
    var m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/.exec(String(v === null || v === undefined ? '' : v).trim());
    if (!m) return '';
    var pad = (x) => (x.length === 1 ? '0' + x : x);
    return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  };

  /**
   * 日期落在 from～to（含）的列，照表上的順序取前 n 列；matched 是符合的總列數。
   *
   * 先只讀日期那一欄找出要哪些列，再讀那一段 —— 不受 MAX_SCAN 限制：要看的常是一年前的
   * 某一天（例如核對每日快照的回補），而一年前在那張表上是一萬多列之前，尾端掃不到。
   */
  var _byDate = (sheet, from, to, n) => {
    var last = sheet.getLastRow();
    var cols = Math.max(sheet.getLastColumn(), 1);
    var header = sheet.getRange(1, 1, 1, cols).getValues()[0].map(_cell);
    var out = { header: header, rows: [], total: Math.max(last - 1, 0), matched: 0 };
    if (last < 2) return out;
    var at = header.indexOf('日期');
    if (at < 0) at = 0;
    var hit = [];
    sheet.getRange(2, at + 1, last - 1, 1).getValues().forEach((r, i) => {
      var d = _day(r[0]);
      if (d && (!from || d >= from) && (!to || d <= to)) hit.push(i);
    });
    out.matched = hit.length;
    if (!hit.length) return out;
    var take = hit.slice(0, n);
    var first = take[0], end = take[take.length - 1];
    var want = {};
    take.forEach(i => { want[i] = true; });
    out.rows = sheet.getRange(first + 2, 1, end - first + 1, cols).getValues()
      .filter((_, j) => want[first + j]).map(r => r.map(_cell));
    return out;
  };

  d.sheet = (p) => {
    var name = String(p.name || '');
    var sheet = name && _ss().getSheetByName(name);
    if (!sheet) return { error: '找不到分頁：' + name };
    if (p.from || p.to) {
      var from = p.from ? _day(p.from) : '', to = p.to ? _day(p.to) : '';
      if ((p.from && !from) || (p.to && !to)) return { error: 'from／to 請用 yyyy-MM-dd' };
      return _byDate(sheet, from, to, _n(p.n, 50));
    }
    return _tail(sheet, _n(p.n, 50), null);
  };

  /** 依 what 組出回應物件（純資料，方便測試；包成 HTTP 的是 respond）。 */
  d.collect = (p) => {
    p = p || {};
    var what = String(p.what || 'summary');
    var out = { what: what, at: _cell(new Date()) };
    try {
      if (what === 'summary') {
        out.sheets   = d.sheets();
        out.triggers = d.triggers();
        out.log      = d.log({ n: 30 });
      } else if (what === 'sheets')   out.sheets   = d.sheets();
      else if (what === 'triggers')   out.triggers = d.triggers();
      else if (what === 'log')        out.log      = d.log(p);
      else if (what === 'chat')       out.chat     = d.chat(p);
      else if (what === 'sheet')      out.sheet    = d.sheet(p);
      else out.error = '不認得的 what：' + what +
        '（summary / sheets / triggers / log / chat / sheet）';
    } catch (ex) {
      out.error = ex && ex.message ? ex.message : String(ex);
    }
    return out;
  };

  /** doGet 的出口。金鑰不符回 Not Found，與儀表板拒絕時同一個樣子。 */
  d.respond = (p) => {
    p = p || {};
    if (!d.authorized(p.key)) {
      return ContentService.createTextOutput('Not Found');
    }
    return ContentService.createTextOutput(JSON.stringify(d.collect(p)))
      .setMimeType(ContentService.MimeType.JSON);
  };

  return d;
})();
