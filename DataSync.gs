/**
 * DataSync
 * @description 每日資產快照任務
 *
 * 每天 18:00 由 Trigger 執行 `setData()`，把當日股價與現金部位寫進 `@所有股票紀錄`。
 *
 * ⚠️ 這支檔案唯一的硬性約束：**欄位一律以標題列的文字定位，絕不用算的。**
 *
 * 舊版是這樣推導欄位位置的：
 *
 *     var numStocks   = stockPrices.flat().length;
 *     var sumStartCol = 2 + numStocks + 1;
 *
 * 但 `@所有股票紀錄` 的標題列是手動維護的。只要「所有股票」多一檔（例如新
 * ETF 掛牌），numStocks 就 +1，整排資料右移一欄，而標題列原地不動 —— 從那天
 * 起每一列都錯位，B 欄的 SUM 範圍也跟著偏，且**完全不會報錯**。
 * `GoogleSheet.getHistory()` 是拿標題配值餵給 LLM 的，等於從此餵錯資料。
 *
 * 現在的做法：`syncHeader()` 先讓標題列跟上現況（用 insertColumnBefore，Sheets
 * 會自動修正既有列的公式範圍），再用標題文字把值放進對應欄位。
 *
 * 詳見 CLAUDE.md 的「Daily Snapshot Column Contract」。
 */
var DataSync = (() => {
  var ds = {};

  var RECORD_SHEET = '@所有股票紀錄';
  var C_DATE       = '日期';
  var C_TOTAL      = '總價值';
  var C_STOCK_SUM  = '股票總價值';
  var C_STATUS     = '狀態';

  // 狀態欄的值
  var ST_TRADING = '交易日';
  var ST_CLOSED  = '休市';
  var ST_STALE   = '資料未更新';
  var ST_BADFEED = '報價異常';

  // ─── 工具 ──────────────────────────────────────────────────────

  var _colLetter = (col) => {
    var letter = '';
    while (col > 0) {
      var mod = (col - 1) % 26;
      letter = String.fromCharCode(65 + mod) + letter;
      col = Math.floor((col - 1) / 26);
    }
    return letter;
  };

  var _str = (v) => String(v === null || v === undefined ? '' : v).trim();

  /** GOOGLEFINANCE 失效時會留下 #N/A、Loading… 之類的字串 */
  var _isBadPrice = (v) => {
    if (v === null || v === undefined || v === '') return true;
    if (typeof v === 'number') return !isFinite(v) || v <= 0;
    var s = _str(v);
    if (s.charAt(0) === '#' || /^loading/i.test(s) || s === 'N/A') return true;
    var n = parseFloat(s.replace(/[,$]/g, ''));
    return isNaN(n) || n <= 0;
  };

  /**
   * 「所有股票」row3+ 的持股。
   * 欄位以標題定位；標題找不到才退回舊的固定位置（A/B/G）。
   */
  var _readHoldings = (sheet) => {
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 3) return [];

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(_str);
    var at = (name, fallback) => {
      var i = headers.indexOf(name);
      return i >= 0 ? i : fallback;
    };
    var iCode  = at('代號', 0);
    var iName  = at('名稱', 1);
    var iPrice = at('當前市價', 6);

    return sheet.getRange(3, 1, lastRow - 2, lastCol).getValues()
      .filter(r => _str(r[iCode]) !== '')
      .map(r => {
        var code = _str(r[iCode]);
        return {
          code:  code,
          // 標題列歷來用「名稱」當欄名，沿用以免與既有 950 列對不上
          label: _str(r[iName]) || code,
          price: r[iPrice]
        };
      });
  };

  /** 「面板」E1:F8 的現金帳戶（標籤空白的列直接跳過，不佔欄位） */
  var _readCash = (panel) => {
    var labels = panel.getRange('E1:E8').getValues();
    var values = panel.getRange('F1:F8').getValues();
    var out = [];
    for (var i = 0; i < 8; i++) {
      var label = _str(labels[i][0]);
      if (!label) continue;
      out.push({ label: label, value: values[i][0] });
    }
    return out;
  };

  // ─── 標題列同步 ────────────────────────────────────────────────

  /**
   * 讓 `@所有股票紀錄` 的標題列跟上「所有股票」與「面板」的現況。
   *
   * 規則：
   *   1. 只插入，永不刪除 —— 賣掉的標的其歷史欄位必須留著
   *   2. 新持股插在「股票總價值」之前；新現金帳戶插在「狀態」之前
   *   3. 用 insertColumnBefore，讓 Sheets 自動修正既有列 B 欄的 SUM 範圍
   *
   * @param {Sheet} record
   * @param {Array} holdings  _readHoldings() 的結果
   * @param {Array} cash      _readCash() 的結果
   * @param {object} [options]
   * @param {boolean} [options.dryRun] 只算出「同步後的標題列會長怎樣」，完全不碰試算表
   * @returns {{header: string[], inserted: string[]}}
   */
  ds.syncHeader = (record, holdings, cash, options) => {
    options = options || {};
    var dryRun   = !!options.dryRun;
    var inserted = [];

    // 尾端的空白欄要剪掉：getLastColumn() 會被殘留格式或雜訊撐寬，
    // 不剪的話「狀態」會被補到第 27 欄之類的位置。
    var readHeader = () => {
      var raw = record.getRange(1, 1, 1, Math.max(record.getLastColumn(), 1)).getValues()[0].map(_str);
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      return raw;
    };

    var header = readHeader();

    /**
     * 在 pos（1-based）插入一個新欄位。
     * dryRun 時只在記憶體裡的 header 模擬 —— 插欄會動到 950 列，
     * 「預覽」絕不能真的做這件事。
     */
    var addColumn = (pos, label) => {
      if (dryRun) {
        header.splice(pos - 1, 0, label);
        return;
      }
      if (pos > header.length) {
        record.getRange(1, pos).setValue(label);   // 補在尾端，不需要插欄
      } else {
        record.insertColumnBefore(pos);
        record.getRange(1, pos).setValue(label);
      }
      header = readHeader();
    };

    if (header.indexOf(C_STOCK_SUM) < 0) {
      // 沒有這個錨點就無法安全判斷「哪些欄是股票、哪些是現金」，寧可不寫
      throw new Error(
        '「' + RECORD_SHEET + '」標題列找不到「' + C_STOCK_SUM + '」欄，' +
        '無法安全定位欄位。請先修正標題列再執行。目前標題：' + header.join(' | ')
      );
    }

    // ── 1. 缺少的持股欄，插在「股票總價值」前 ──
    holdings.forEach(h => {
      if (header.indexOf(h.label) >= 0) return;
      var pos = header.indexOf(C_STOCK_SUM) + 1;   // 1-based
      addColumn(pos, h.label);
      inserted.push(h.label + '（持股，第 ' + _colLetter(pos) + ' 欄）');
    });

    // ── 2. 確保「狀態」欄存在且在最後 ──
    if (header.indexOf(C_STATUS) < 0) {
      var tail = header.length + 1;
      addColumn(tail, C_STATUS);
      inserted.push(C_STATUS + '（第 ' + _colLetter(tail) + ' 欄）');
    }

    // ── 3. 缺少的現金帳戶欄，插在「狀態」前 ──
    cash.forEach(c => {
      if (header.indexOf(c.label) >= 0) return;
      var pos = header.indexOf(C_STATUS) + 1;      // 1-based，插在狀態這一格之前
      addColumn(pos, c.label);
      inserted.push(c.label + '（現金，第 ' + _colLetter(pos) + ' 欄）');
    });

    if (inserted.length > 0 && !dryRun) {
      Logger.warning('DataSync.syncHeader', '已擴充快照標題列', { inserted: inserted });
    }

    return { header: header, inserted: inserted };
  };

  // ─── 狀態判定 ──────────────────────────────────────────────────

  /**
   * 判定這一列的資料狀態。
   * 沒有台股行事曆，所以只做誠實的三分法：
   *   休市       — 週六日
   *   資料未更新 — 平日但所有股價與前一列完全相同（國定假日，或抓取整批失敗）
   *   報價異常   — 有股價是 #N/A / Loading / 非正數
   */
  var _decideStatus = (now, priceValues, prevPriceValues, hasBadPrice) => {
    var dow = now.getDay();
    if (dow === 0 || dow === 6) return ST_CLOSED;
    if (hasBadPrice) return ST_BADFEED;
    if (prevPriceValues && prevPriceValues.length === priceValues.length) {
      var same = priceValues.every((v, i) => String(v) === String(prevPriceValues[i]));
      if (same) return ST_STALE;
    }
    return ST_TRADING;
  };

  // ─── 主流程 ────────────────────────────────────────────────────

  /**
   * 寫入當日快照。
   * 同一天重複執行會**覆寫**當日那一列，不會多長一列。
   * @param {object} [options]
   * @param {boolean} [options.dryRun] 只回報要寫什麼，不真的寫
   * @returns {object} 執行結果摘要
   */
  ds.run = (options) => {
    options = options || {};
    var ss     = SpreadsheetApp.openById(Config.SHEET_ID);
    var panel  = ss.getSheetByName('面板');
    var stocks = ss.getSheetByName('所有股票');
    var record = ss.getSheetByName(RECORD_SHEET);

    if (!panel || !stocks || !record) {
      var missing = [!panel && '面板', !stocks && '所有股票', !record && RECORD_SHEET]
        .filter(Boolean).join('、');
      Logger.error('DataSync.run', '找不到必要工作表', { missing: missing });
      return { ok: false, reason: '找不到工作表：' + missing };
    }

    var holdings = _readHoldings(stocks);
    var cash     = _readCash(panel);

    if (holdings.length === 0) {
      Logger.error('DataSync.run', '「所有股票」讀不到任何持股，放棄寫入');
      return { ok: false, reason: '無持股資料' };
    }

    // 報價全滅就不要寫進歷史，寧可缺一天也不要留一整列 0
    var badCount = holdings.filter(h => _isBadPrice(h.price)).length;
    if (badCount === holdings.length) {
      Logger.error('DataSync.run', '所有股價皆無效，放棄寫入', {
        holdings: holdings.map(h => h.code + '=' + h.price)
      });
      return { ok: false, reason: '報價全數無效' };
    }

    var sync   = ds.syncHeader(record, holdings, cash, { dryRun: options.dryRun });
    var header = sync.header;
    var idx    = (name) => header.indexOf(name);   // 0-based

    // ── 組出這一列 ──
    var row = new Array(header.length).fill('');

    var now     = new Date();
    var dateStr = Utilities.formatDate(now, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    row[idx(C_DATE)] = dateStr;

    var priceCols = [];
    holdings.forEach(h => {
      var i = idx(h.label);
      if (i < 0) return;                       // syncHeader 後理論上不會發生
      row[i] = _isBadPrice(h.price) ? '' : h.price;
      priceCols.push(i);
    });

    row[idx(C_STOCK_SUM)] = panel.getRange('B3').getValue();

    cash.forEach(c => {
      var i = idx(c.label);
      if (i >= 0) row[i] = c.value;
    });

    // ── B 欄合計公式：股票總價值 → 狀態前一欄 ──
    var targetRow = _resolveTargetRow(record, header, dateStr, ss.getSpreadsheetTimeZone());
    var sumFrom   = _colLetter(idx(C_STOCK_SUM) + 1);
    var sumTo     = _colLetter(idx(C_STATUS));      // 狀態的前一欄 = idx(C_STATUS) 的 1-based 值
    row[idx(C_TOTAL)] = '=SUM(' + sumFrom + targetRow.row + ':' + sumTo + targetRow.row + ')';

    // ── 狀態 ──
    // dryRun 且標題列是模擬出來的時候，模擬欄位與試算表實際欄位已經對不上，
    // 拿實際列去比會比到隔壁欄。這種情況直接放棄「資料未更新」的判定。
    var canComparePrev = targetRow.prevRow && !(options.dryRun && sync.inserted.length > 0);
    var prevPrices = canComparePrev
      ? priceCols.map(i => record.getRange(targetRow.prevRow, i + 1).getValue())
      : null;
    row[idx(C_STATUS)] = _decideStatus(
      now,
      priceCols.map(i => row[i]),
      prevPrices,
      badCount > 0
    );

    var summary = {
      ok: true,
      date: dateStr,
      row: targetRow.row,
      mode: targetRow.overwrite ? 'overwrite' : 'append',
      status: row[idx(C_STATUS)],
      holdings: holdings.length,
      cashAccounts: cash.length,
      headerInserted: sync.inserted,
      badPrices: badCount
    };

    if (options.dryRun) {
      summary.preview = header.map((h, i) => h + '=' + row[i]).join(' | ');
      return summary;
    }

    record.getRange(targetRow.row, 1, 1, row.length).setValues([row]);

    if (badCount > 0) {
      Logger.warning('DataSync.run', '部分股價無效，該欄留空', {
        date: dateStr,
        bad: holdings.filter(h => _isBadPrice(h.price)).map(h => h.code)
      });
    }
    Logger.info('DataSync.run', '每日資產快照完成', summary);
    return summary;
  };

  /**
   * 決定要寫哪一列：當日已存在就覆寫該列，否則接在最後一列之後。
   * @returns {{row:number, prevRow:number|null, overwrite:boolean}}
   */
  var _resolveTargetRow = (record, header, dateStr, tz) => {
    var dateCol = header.indexOf(C_DATE) + 1;
    var lastRow = record.getLastRow();
    if (lastRow < 2) return { row: 2, prevRow: null, overwrite: false };

    // 日期欄可能存成 Date 物件，也可能是 yyyy-MM-dd / yyyy/M/d 字串，統一正規化
    var norm = (v) => {
      if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      var s = _str(v);
      var m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      if (!m) return s;
      var pad = (x) => (x.length === 1 ? '0' + x : x);
      return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    };

    var last = norm(record.getRange(lastRow, dateCol).getValue());
    if (last === dateStr) {
      return { row: lastRow, prevRow: lastRow > 2 ? lastRow - 1 : null, overwrite: true };
    }
    return { row: lastRow + 1, prevRow: lastRow, overwrite: false };
  };

  // ─── 手動診斷（在 GAS 編輯器直接執行）─────────────────────────

  /**
   * 只檢查不寫入：回報標題列與現況是否對得上。
   * 加新標的之前先跑這個，就能知道會插到哪一欄。
   */
  ds.verify = () => {
    var ss     = SpreadsheetApp.openById(Config.SHEET_ID);
    var panel  = ss.getSheetByName('面板');
    var stocks = ss.getSheetByName('所有股票');
    var record = ss.getSheetByName(RECORD_SHEET);
    if (!panel || !stocks || !record) return '找不到必要工作表';

    var holdings = _readHoldings(stocks);
    var cash     = _readCash(panel);
    var header   = record.getRange(1, 1, 1, record.getLastColumn()).getValues()[0].map(_str);

    var missingH = holdings.filter(h => header.indexOf(h.label) < 0).map(h => h.code + ' ' + h.label);
    var missingC = cash.filter(c => header.indexOf(c.label) < 0).map(c => c.label);
    var badPrice = holdings.filter(h => _isBadPrice(h.price)).map(h => h.code + '=' + h.price);

    var lines = [
      '【快照欄位檢查】',
      '標題列（' + header.length + ' 欄）：' + header.join(' | '),
      '持股 ' + holdings.length + ' 檔、現金帳戶 ' + cash.length + ' 個',
      '',
      missingH.length ? '▸ 標題列缺少持股欄：' + missingH.join('、') + '（下次執行會自動插入）'
                      : '▸ 持股欄位齊全',
      missingC.length ? '▸ 標題列缺少現金欄：' + missingC.join('、') + '（下次執行會自動插入）'
                      : '▸ 現金欄位齊全',
      header.indexOf(C_STATUS) < 0 ? '▸ 尚無「狀態」欄（下次執行會自動補在最後）'
                                   : '▸ 「狀態」欄在第 ' + _colLetter(header.indexOf(C_STATUS) + 1) + ' 欄',
      badPrice.length ? '▸ ⚠️ 目前報價異常：' + badPrice.join('、') : '▸ 報價正常'
    ];
    return lines.join('\n');
  };

  return ds;
})();

// ─── Trigger 進入點 ───────────────────────────────────────────────
// 18:00 的 Trigger 是以函式名稱 `setData` 註冊的，改名等於讓排程失效。

function setData() {
  try {
    DataSync.run();
  } catch (ex) {
    Logger.error('setData', '每日快照失敗', ex && ex.message ? ex.message : String(ex));
  }
}
