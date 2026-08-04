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
 *     日期 | 類型 | 鍵 | 名稱 | 數量 | 單價 | 市值 | 幣別 | 狀態
 *
 * 一列一個項目，欄位永遠是這九個。新增標的、新增帳戶、賣光一檔，
 * 都只是列數變化，沒有任何欄位需要跟著移動。
 *
 * 寫入的內容（一天約 15~20 列）：
 *   合計 / 總資產、股票市值   ← 指標
 *   持股 / 每檔代號            ← 持倉（僅股數 > 0）
 *   現金 / 每個帳戶            ← 現金（台幣值）
 *   實體 / 黃金                ← 實體資產
 */
var DataSync = (() => {
  var ds = {};

  var SNAP = '每日快照';

  // 狀態欄的值
  var ST_TRADING = '交易日';
  var ST_CLOSED  = '休市';
  var ST_STALE   = '資料未更新';
  var ST_BADFEED = '報價異常';

  var _str = (v) => String(v === null || v === undefined ? '' : v).trim();
  var _num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = _str(v);
    if (s.charAt(0) === '#' || /^loading/i.test(s)) return 0;
    var n = parseFloat(s.replace(/[,$]/g, ''));
    return isNaN(n) ? 0 : n;
  };

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
    rows.push([dateStr, '合計', '總資產',   '', '', '', pick('總資產'),   'TWD', '']);
    rows.push([dateStr, '合計', '股票市值', '', '', '', pick('股票市值'), 'TWD', '']);

    // ── 持股 ──
    AssetSchema.readObjects(ss.getSheetByName('持倉')).forEach(p => {
      var shares = _num(p['股數']);
      if (shares <= 0) return;                 // 已出清的不必每天記
      var code  = _str(p['代號']);
      var price = _num(p['市價']);
      if (price <= 0) badCodes.push(code);
      prices[code] = price;
      rows.push([dateStr, '持股', code, _str(p['名稱']), shares,
                 price || '', _num(p['市值']) || '', 'TWD', '']);
    });
    var held = Object.keys(prices).length;

    // ── 現金 ──
    AssetSchema.readObjects(ss.getSheetByName('現金')).forEach(c => {
      var label = _str(c['帳戶']);
      if (!label) return;
      // 記台幣值，跨帳戶才加得起來；原幣留在餘額欄，快照不重複
      rows.push([dateStr, '現金', label, '', '', '', _num(c['台幣值']), 'TWD', '']);
    });

    // ── 實體資產 ──
    var phys = AssetSchema.readObjects(ss.getSheetByName('實體資產'));
    if (phys.length) {
      rows.push([dateStr, '實體', '黃金', '',
                 phys.reduce((s, r) => s + _num(r['數量']), 0), '',
                 phys.reduce((s, r) => s + _num(r['市值']), 0), 'TWD', '']);
    }

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
    var data = sheet.getRange(lastRow - span + 1, 1, span, 6).getValues();

    var prevDate = null;
    for (var i = data.length - 1; i >= 0; i--) {
      var d = _dateKey(data[i][0], tz);
      if (d && d !== todayStr) { prevDate = d; break; }
    }
    if (!prevDate) return null;

    var out = {};
    data.forEach(r => {
      if (_dateKey(r[0], tz) !== prevDate) return;
      if (_str(r[1]) !== '持股') return;
      out[_str(r[2])] = _num(r[5]);
    });
    return Object.keys(out).length ? out : null;
  };

  /** 刪掉某一天既有的列（同日重跑用），回傳刪除筆數 */
  var _removeDate = (sheet, dateStr, tz) => {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;
    var dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

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
    built.rows.forEach(r => { r[8] = status; });

    var summary = {
      ok: true,
      date: dateStr,
      rows: built.rows.length,
      holdings: built.held,
      status: status,
      badPrices: built.badCodes
    };

    if (options.dryRun) {
      summary.preview = built.rows.map(r => r.slice(1, 4).filter(String).join('/') + '=' + r[6]).join(' | ');
      return summary;
    }

    // 同日重跑覆寫：先刪掉當天的列再寫，不會長出兩份
    summary.replaced = _removeDate(sheet, dateStr, tz);
    sheet.getRange(sheet.getLastRow() + 1, 1, built.rows.length, 9).setValues(built.rows);

    if (built.badCodes.length) {
      Logger.warning('DataSync.run', '部分持股抓不到市價', { codes: built.badCodes });
    }
    Logger.info('DataSync.run', '每日資產快照完成', summary);
    return summary;
  };

  /** 只檢查不寫入：回報今天會寫幾列、狀態是什麼 */
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

function setData() {
  try {
    // 快照要記的是當下的指標數字，而指標是重算當下寫死的值 ——
    // 不先重算就會把上一次寫交易時的舊數字當成今天的收盤狀態。
    Position.rebuild();
    DataSync.run();
  } catch (ex) {
    Logger.error('setData', '每日快照失敗', ex && ex.message ? ex.message : String(ex));
  }
}
