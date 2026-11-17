/**
 * DataSync
 * @description 每日資產快照任務
 *
 * 每天 18:00 由 Trigger 執行 `setData()`，把當日狀態寫進新表的「每日快照」。
 *
 * ⚠️ **舊表（`@所有股票紀錄`）已經不再寫入。** 那張寬表一檔一欄，
 * 加一檔 ETF 就整排右移，維護成本全花在對齊欄位上（見 git 歷史裡的
 * 「Daily Snapshot Column Contract」）。長表把那個問題整個消滅：
 *
 *     日期 | 類型 | 鍵 | 單價 | 市值 | 狀態
 *
 * 一列一個項目。新增標的、賣光一檔，都只是列數變化，沒有欄位需要跟著移動。
 * 讀寫一律依**欄名**（不靠欄位位置），主人在表上刪欄不會讓它寫錯位置。
 *
 * 寫入的內容（一天約 8 列）：
 *   合計 / 總資產、股票市值   ← 指標（走勢、日週月漲跌、XIRR 開帳市值都讀這兩列）
 *   持股 / 每檔代號            ← 持倉（僅股數 > 0）；只有「單價」被讀 —— 判斷「資料未更新」
 *   應收 / 每個對方            ← 應收款的當日餘額（餘額 0 的不寫）。總資產已經含它
 *
 * 2026-10-08 起不再寫「現金」「實體」列，也拿掉名稱／數量／幣別三欄：從來沒有讀者。
 * 舊的現金／實體列還留在表上（歷史資料），讀的地方都只挑合計與持股，不受影響。
 */
var DataSync = (() => {
  var ds = {};

  var SNAP = '每日快照';

  // 狀態欄的值
  var ST_TRADING = '交易日';
  var ST_CLOSED  = '休市';
  var ST_STALE   = '資料未更新';
  var ST_BADFEED = '報價異常';

  // 儲存格取值走 AssetSchema.str / .num（見那裡的註解）
  var _str = (v) => AssetSchema.str(v);
  var _num = (v) => AssetSchema.num(v);

  var _ymd = (d, tz) => Utilities.formatDate(d, tz || 'GMT+8', 'yyyy-MM-dd');

  /** 日期正規化，快照的日期欄可能是 Date 也可能是字串 */
  var _dateKey = (v, tz) => {
    if (v instanceof Date) return _ymd(v, tz);
    var s = _str(v);
    var m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (!m) return s;
    var pad = (x) => (x.length === 1 ? '0' + x : x);
    return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  };

  // ─── 組出當日的列 ──────────────────────────────────────────────

  /**
   * @returns {{rows: Array, prices: object, badCodes: string[], held: number}}
   */
  var _buildRows = (ss, dateStr) => {
    var rows = [], prices = {}, badCodes = [];

    var panel = AssetSchema.readObjects(ss.getSheetByName('指標'));
    var pick = (key) => {
      var hit = panel.filter(x => _str(x['指標']) === key)[0];
      return hit ? _num(hit['數值']) : 0;
    };

    // ── 合計 ──
    rows.push({ 日期: dateStr, 類型: '合計', 鍵: '總資產',   市值: pick('總資產') });
    rows.push({ 日期: dateStr, 類型: '合計', 鍵: '股票市值', 市值: pick('股票市值') });

    // ── 持股 ──
    AssetSchema.readObjects(ss.getSheetByName('持倉')).forEach(p => {
      var shares = _num(p['股數']);
      if (shares <= 0) return;                 // 已出清的不必每天記
      var code  = _str(p['代號']);
      var price = _num(p['市價']);
      if (price <= 0) badCodes.push(code);
      prices[code] = price;
      rows.push({ 日期: dateStr, 類型: '持股', 鍵: code, 單價: price || '', 市值: _num(p['市值']) || '' });
    });
    var held = Object.keys(prices).length;

    // ── 應收 ── 每個對方一列，市值＝當天的餘額。合計／總資產已經含應收款（指標的公式）
    Receivable.getReceivables(ss).forEach(x => {
      if (x['餘額']) rows.push({ 日期: dateStr, 類型: '應收', 鍵: x['對方'], 市值: x['餘額'] });
    });

    return { rows: rows, prices: prices, badCodes: badCodes, held: held };
  };

  /**
   * 判定當日狀態。沒有台股行事曆，所以這是推論不是權威判定：
   *   休市       — 週六日
   *   報價異常   — 有持股抓不到市價
   *   資料未更新 — 所有持股單價與前一次快照完全相同（國定假日，或整批抓取失敗）
   */
  var _decideStatus = (now, prices, prevPrices, hasBad) => {
    var dow = now.getDay();
    if (dow === 0 || dow === 6) return ST_CLOSED;
    if (hasBad) return ST_BADFEED;

    var codes = Object.keys(prices);
    if (prevPrices && codes.length && codes.every(c => c in prevPrices)) {
      var same = codes.every(c => String(prices[c]) === String(prevPrices[c]));
      if (same) return ST_STALE;
    }
    return ST_TRADING;
  };

  /** 讀出快照裡最後一個「不是今天」的日期，以及那天各檔的單價 */
  var _previousPrices = (sheet, todayStr, tz) => {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    var span = Math.min(lastRow - 1, 200);         // 往回 200 列足夠涵蓋前幾天
    var m = AssetSchema.headerMap(sheet);
    var D = m['日期'], T = m['類型'], K = m['鍵'], P = m['單價'];
    var data = sheet.getRange(lastRow - span + 1, 1, span, Math.max(sheet.getLastColumn(), 1)).getValues();

    var prevDate = null;
    for (var i = data.length - 1; i >= 0; i--) {
      var d = _dateKey(data[i][D], tz);
      if (d && d !== todayStr) { prevDate = d; break; }
    }
    if (!prevDate) return null;

    var out = {};
    data.forEach(r => {
      if (_dateKey(r[D], tz) !== prevDate) return;
      if (_str(r[T]) !== '持股') return;
      out[_str(r[K])] = _num(r[P]);
    });
    return Object.keys(out).length ? out : null;
  };

  /** 刪掉某一天既有的列（同日重跑用），回傳刪除筆數 */
  var _removeDate = (sheet, dateStr, tz) => {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;
    var dates = sheet.getRange(2, AssetSchema.headerMap(sheet)['日期'] + 1, lastRow - 1, 1).getValues();

    var first = -1, count = 0;
    for (var i = 0; i < dates.length; i++) {
      if (_dateKey(dates[i][0], tz) === dateStr) {
        if (first < 0) first = i + 2;
        count++;
      } else if (first >= 0) break;                // 同一天的列一定連續
    }
    if (count === 0) return 0;

    // Sheets 不允許刪光所有非凍結列
    if (first === 2 && count >= sheet.getMaxRows() - 1) {
      sheet.getRange(first, 1, count, sheet.getMaxColumns()).clearContent();
    } else {
      sheet.deleteRows(first, count);
    }
    return count;
  };

  // ─── 主流程 ────────────────────────────────────────────────────

  /**
   * @param {object} [options]
   * @param {boolean} [options.dryRun] 只回報要寫什麼，不寫入
   */
  ds.run = (options) => {
    options = options || {};
    var ss = AssetSchema.open();
    var tz = ss.getSpreadsheetTimeZone();
    var sheet = ss.getSheetByName(SNAP);

    if (!sheet) {
      Logger.error('DataSync.run', '找不到「' + SNAP + '」分頁');
      return { ok: false, reason: '找不到分頁：' + SNAP };
    }

    var now = new Date();
    var dateStr = _ymd(now, tz);
    var built = _buildRows(ss, dateStr);

    if (built.held === 0) {
      Logger.error('DataSync.run', '持倉表沒有任何在持部位，放棄寫入');
      return { ok: false, reason: '無持股資料' };
    }

    // 報價全滅就不要寫進歷史 —— 缺一天可以補，一整天的 0 會污染所有百分比
    if (built.badCodes.length === built.held) {
      Logger.error('DataSync.run', '所有持股都抓不到市價，放棄寫入', { codes: built.badCodes });
      return { ok: false, reason: '報價全數無效' };
    }

    var prevPrices = _previousPrices(sheet, dateStr, tz);
    var status = _decideStatus(now, built.prices, prevPrices, built.badCodes.length > 0);
    built.rows.forEach(r => { r['狀態'] = status; });

    var summary = {
      ok: true,
      date: dateStr,
      rows: built.rows.length,
      holdings: built.held,
      status: status,
      badPrices: built.badCodes
    };

    if (options.dryRun) {
      summary.preview = built.rows.map(r => r['類型'] + '/' + r['鍵'] + '=' + r['市值']).join(' | ');
      return summary;
    }

    // 同日重跑覆寫：先刪掉當天的列再寫，不會長出兩份
    summary.replaced = _removeDate(sheet, dateStr, tz);
    // 依欄名寫：表上多一欄或少一欄都放對位置（標題列一定要有 TABS 定義的欄）
    var hm = AssetSchema.headerMap(sheet);
    var missing = AssetSchema.expected(SNAP).filter(h => hm[h] === undefined);
    if (missing.length) {
      Logger.error('DataSync.run', '「' + SNAP + '」缺少欄位', missing);
      return { ok: false, reason: '每日快照缺少欄位：' + missing.join('、') };
    }
    var header = hm.__header;
    var out = built.rows.map(o => header.map(h => (h && o[h] !== undefined) ? o[h] : ''));
    sheet.getRange(sheet.getLastRow() + 1, 1, out.length, header.length).setValues(out);

    if (built.badCodes.length) {
      Logger.warning('DataSync.run', '部分持股抓不到市價', { codes: built.badCodes });
    }
    Logger.info('DataSync.run', '每日資產快照完成', summary);
    return summary;
  };

  /** 只檢查不寫入：回報今天會寫幾列、狀態是什麼 */
  /**
   * 同一天有兩份以上快照的，只留最後一份。
   *
   * 一份＝從一列「合計／總資產」開始，到下一列「合計／總資產」或日期換掉為止（那一天在第一列
   * 總資產之前的列算第一份）。舊表遷移進來的歷史裡有整天重複的：2026-10-18 發現 2026-03-28 有
   * 兩份各 18 列。重複會讓走勢在那一天有兩個點；兩份的總資產又不一樣的話（應收款回補撤回時，
   * 第一份被多扣了一次應收款），圖上就是一個假的凹陷。
   *
   * ⚠️ 只刪「結構一樣」的副本：每一份的 類型／鍵 順序都要跟留下來的那份相同。不一樣的那天
   *    整天不碰，列在 skipped —— 那可能不是重複，而是同一天記了不同的東西。
   * 刪除用 deleteRows，由下往上刪，其他列的值一格都不重寫。
   *
   * @param {{dryRun?: boolean}} [options] dryRun 只回報不刪
   * @returns {{ok: boolean, reason?: string, dates: Array, skipped: Array, removed: number}}
   */
  ds.dedupe = (options) => {
    options = options || {};
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();
      var sheet = ss.getSheetByName(SNAP);
      if (!sheet || sheet.getLastRow() < 2) return { ok: true, dates: [], skipped: [], removed: 0 };
      var m = AssetSchema.headerMap(sheet);
      if (['日期', '類型', '鍵', '市值'].some(h => m[h] === undefined)) {
        return { ok: false, reason: '每日快照缺少必要欄位' };
      }
      var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(sheet.getLastColumn(), 1)).getValues();

      // 每一天切成幾份：{date, copies: [{first, last, sig, total}]}，first/last 是表上的列號
      var days = {}, order = [];
      data.forEach((r, i) => {
        if (!_str(r[m['日期']])) return;
        var d = _dateKey(r[m['日期']], tz);
        var row = i + 2;
        var isTotal = _str(r[m['類型']]) === '合計' && _str(r[m['鍵']]) === '總資產';
        var day = days[d];
        if (!day) { day = days[d] = { date: d, copies: [] }; order.push(d); }
        var cur = day.copies[day.copies.length - 1];
        // 新的一份：遇到總資產列，或這一天的列中間被別的日期隔開了
        if (!cur || (isTotal && cur.hasTotal) || cur.last !== row - 1) {
          cur = { first: row, last: row, sig: [], total: null, hasTotal: false };
          day.copies.push(cur);
        }
        cur.last = row;
        cur.sig.push(_str(r[m['類型']]) + '/' + _str(r[m['鍵']]));
        if (isTotal) { cur.hasTotal = true; cur.total = _num(r[m['市值']]); }
      });

      var dates = [], skipped = [], drop = [];
      order.forEach(d => {
        var copies = days[d].copies;
        if (copies.length < 2) return;
        var keep = copies[copies.length - 1];
        var same = copies.every(c => c.sig.join('|') === keep.sig.join('|'));
        var info = {
          date: d,
          keep: [keep.first, keep.last],
          drop: copies.slice(0, -1).map(c => [c.first, c.last]),
          totals: copies.map(c => c.total)
        };
        if (!same) { skipped.push(info); return; }
        dates.push(info);
        copies.slice(0, -1).forEach(c => drop.push(c));
      });

      var removed = drop.reduce((a, c) => a + c.last - c.first + 1, 0);
      if (!options.dryRun && drop.length) {
        drop.sort((a, b) => b.first - a.first)
          .forEach(c => sheet.deleteRows(c.first, c.last - c.first + 1));
        SpreadsheetApp.flush();
        if (typeof Dashboard !== 'undefined') Dashboard.invalidate();
        Logger.info('DataSync.dedupe', '刪除重複的快照', {
          dates: dates.map(x => x.date), removed: removed, skipped: skipped.map(x => x.date)
        });
      }
      return { ok: true, dates: dates, skipped: skipped, removed: removed, dryRun: !!options.dryRun };
    } catch (ex) {
      Logger.error('DataSync.dedupe', '檢查重複快照失敗', ex);
      return { ok: false, reason: ex && ex.message ? ex.message : String(ex) };
    }
  };

  ds.verify = () => {
    var r = ds.run({ dryRun: true });
    if (!r.ok) return '⚠️ 今天不會寫入：' + r.reason;
    return [
      '【每日快照檢查】',
      '日期：' + r.date + '　狀態：' + r.status,
      '將寫入 ' + r.rows + ' 列（持股 ' + r.holdings + ' 檔）',
      r.badPrices.length ? '⚠️ 抓不到市價：' + r.badPrices.join('、') : '▸ 報價正常',
      '',
      r.preview
    ].join('\n');
  };

  return ds;
})();

// ─── Trigger 進入點 ───────────────────────────────────────────────
// 18:00 的 Trigger 是以函式名稱 `setData` 註冊的，改名等於讓排程失效。

/**
 * 這次執行是不是快照的重試。跟 _isReportRetry 同一個道理（見 DailyReport.gs）：
 * GAS 會把事件物件當第一個引數傳進來，所以不能用參數；全域每次執行都重新載入成 false。
 */
var _isSnapshotRetry = false;

function setData() {
  var res = null, why = '';
  try {
    // 快照要記的是當下的指標數字，而指標是重算當下寫死的值 ——
    // 不先重算就會把上一次寫交易時的舊數字當成今天的收盤狀態。
    Position.rebuild();
    res = DataSync.run();
    if (!res || !res.ok) why = res && res.reason ? res.reason : '沒有回傳結果';
  } catch (ex) {
    why = ex && ex.message ? ex.message : String(ex);
    Logger.error('setData', '每日快照失敗', why);
  }
  if (!why) return;

  // 缺的那一天之後補不回來（當天的市價已經拿不到），所以失敗就隔 15 分鐘再試一次。
  // ⚠️ 只重試一次，理由同早報：持續失敗時每 15 分鐘生一個 trigger 會塞爆 20 個的額度。
  if (!_isSnapshotRetry && _scheduleReportRetry('setDataRetry')) return;

  // 重試也失敗（或排不了重試）才講：快照沒寫成在任何畫面上都看不出來，只會是走勢圖少一天
  try {
    MessagingServiceFactory.pushToMasters('⚠ 今天的每日快照沒有寫成（' + why + '），' +
      '走勢圖會缺這一天。詳情見 consolelog。');
  } catch (ex) {
    Logger.error('setData', '快照失敗的通知也送不出去', ex);
  }
}

/** setData 的一次性重試（見 Cron.ONESHOT）。先刪自己的 trigger，被 GAS 砍掉也不佔額度 */
function setDataRetry() {
  _deleteTriggersFor('setDataRetry');
  _isSnapshotRetry = true;
  setData();
}
