/**
 * AssetMigrate
 * @description 把舊「股票」試算表的資料搬進新的「資產管理」試算表
 *
 * 只讀舊表，不寫舊表。可以重複執行 —— 每次會先清掉自己上次寫的
 * `來源 = migration` 列，所以不會疊出重複資料。
 *
 * ⚠️ 兩個誠實的限制，別把遷移後的數字當成完整歷史：
 *
 * 1. **沒有原始成交明細。** 舊表的「總成本」是手打的終值，不是一筆筆買進累積
 *    出來的。所以每檔只能記一列 `期初` 建倉：股數是現在的股數，單價是
 *    總成本 ÷ 股數，日期是遷移日。這代表 XIRR 從遷移日起算，不是你真實的
 *    持有全期報酬。哪天匯得出國泰證券的歷史成交明細，把那些 `期初` 列換掉，
 *    XIRR 才會變成真的。
 *
 * 2. **每日快照沒有歷史股數。** 舊表每天只存「收盤價」，不存當天各檔的股數，
 *    所以歷史列只能填單價，數量與市值留空。總資產與股票市值那兩個合計值是
 *    有的（舊表 B 欄與 K 欄），走勢圖不受影響。
 */
var AssetMigrate = (() => {
  var m = {};

  var MIGRATION_SOURCE = 'migration';

  var _num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = String(v).trim();
    if (s.charAt(0) === '#') return 0;
    var n = parseFloat(s.replace(/[,$%]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  var _str = (v) => String(v === null || v === undefined ? '' : v).trim();

  /** 日期正規化成 yyyy-MM-dd；認不出來回空字串 */
  var _dateStr = (v, tz) => {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    var s = _str(v);
    var m2 = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (!m2) return '';
    var pad = (x) => (x.length === 1 ? '0' + x : x);
    return m2[1] + '-' + pad(m2[2]) + '-' + pad(m2[3]);
  };

  /** 既有遷移期初列的日期（取最早的一個），沒有則回空字串 */
  var _existingEpoch = (trades, tz) => {
    var ds = trades
      .filter(t => _str(t['來源']) === MIGRATION_SOURCE && _str(t['動作']) === '期初')
      .map(t => _dateStr(t['日期'], tz))
      .filter(Boolean)
      .sort();
    return ds.length ? ds[0] : '';
  };

  /** 從帳戶名稱推幣別：「(美)」→ USD、「(日)」→ JPY，其餘台幣 */
  var _currencyOf = (label) => {
    if (/\(美\)|USD|美元/.test(label)) return 'USD';
    if (/\(日\)|JPY|日圓|日幣/.test(label)) return 'JPY';
    if (/\(歐\)|EUR|歐元/.test(label)) return 'EUR';
    return 'TWD';
  };

  var _typeOf = (label) => {
    if (/證券|券商/.test(label)) return '證券';
    if (_currencyOf(label) !== 'TWD') return '外幣';
    return '現金';
  };

  // ─── 讀舊表 ────────────────────────────────────────────────────

  m.readLegacy = () => {
    var ss = SpreadsheetApp.openById(AssetSchema.LEGACY_SHEET_ID);
    var need = ['所有股票', '配置', '面板', '@固定', '@股利', '@所有股票紀錄'];
    var missing = need.filter(n => !ss.getSheetByName(n));
    if (missing.length) throw new Error('舊試算表缺少分頁：' + missing.join('、'));

    // ── 所有股票 row3+ ──
    var stockSheet = ss.getSheetByName('所有股票');
    var sHeader = stockSheet.getRange(1, 1, 1, stockSheet.getLastColumn()).getValues()[0].map(_str);
    var sIdx = (n, f) => { var i = sHeader.indexOf(n); return i >= 0 ? i : f; };
    var holdings = stockSheet
      .getRange(3, 1, Math.max(stockSheet.getLastRow() - 2, 0), stockSheet.getLastColumn())
      .getValues()
      .filter(r => _str(r[sIdx('代號', 0)]) !== '')
      .map(r => ({
        code:     _str(r[sIdx('代號', 0)]),
        name:     _str(r[sIdx('名稱', 1)]),
        plan:     _str(r[sIdx('計畫', 2)]),
        shares:   _num(r[sIdx('股數', 4)]),
        cost:     _num(r[sIdx('總成本', 5)]),
        dividend: _num(r[sIdx('總股利', 10)])
      }));

    // ── 配置 row3+：代號 → 區域 / 類型 ──
    var allocSheet = ss.getSheetByName('配置');
    var classify = {};
    allocSheet.getRange(3, 1, Math.max(allocSheet.getLastRow() - 2, 0), 7).getValues()
      .forEach(r => {
        var code = _str(r[0]);
        if (!code || code === '0000') return;
        classify[code] = { region: _str(r[5]), kind: _str(r[6]) };   // F=VT(台/美/歐/日), G=指/息
      });

    // ── 面板 E1:H8：帳戶 / 黃金 ──
    var panel = ss.getSheetByName('面板');
    var pe = panel.getRange('E1:H8').getValues();
    var accounts = [], gold = null;
    for (var i = 0; i < 8; i++) {
      var label = _str(pe[i][0]);
      if (!label) continue;
      var twd = _num(pe[i][1]);          // F：台幣值
      var qty = _num(pe[i][2]);          // G：原幣金額或重量
      if (/黃金|金塊/.test(label)) { gold = { totalWeight: qty, twd: twd }; continue; }
      var cur = _currencyOf(label);
      accounts.push({
        name: label,
        type: _typeOf(label),
        currency: cur,
        // 台幣帳戶的 G 欄可能留著無關的舊數字，只有外幣帳戶才採信原幣值
        balance: cur === 'TWD' ? twd : (qty || twd)
      });
    }

    // ── @固定：黃金明細 ──
    var fixedSheet = ss.getSheetByName('@固定');
    var physical = fixedSheet.getRange(1, 1, Math.max(fixedSheet.getLastRow(), 1), 3).getValues()
      .filter(r => _str(r[0]) !== '')
      .map(r => ({ category: _str(r[0]), qty: _num(r[1]), name: _str(r[2]) || _str(r[0]) }));

    // ── @股利 ──
    var divSheet = ss.getSheetByName('@股利');
    var dividends = divSheet.getRange(2, 1, Math.max(divSheet.getLastRow() - 1, 0), 3).getValues()
      .filter(r => r[0] && _str(r[1]) && _num(r[2]) > 0)
      .map(r => ({ date: r[0], code: _str(r[1]), amount: _num(r[2]) }));

    // ── @所有股票紀錄 ──
    var recSheet = ss.getSheetByName('@所有股票紀錄');
    var recHeader = recSheet.getRange(1, 1, 1, recSheet.getLastColumn()).getValues()[0].map(_str);
    var recRows = recSheet.getRange(2, 1, Math.max(recSheet.getLastRow() - 1, 0), recSheet.getLastColumn())
      .getValues()
      .filter(r => r[0]);

    return {
      holdings: holdings, classify: classify, accounts: accounts, gold: gold,
      physical: physical, dividends: dividends,
      snapshot: { header: recHeader, rows: recRows }
    };
  };

  // ─── 遷移 ──────────────────────────────────────────────────────

  /**
   * @param {object} [options]
   * @param {boolean} [options.skipSnapshot] 跳過 950 天快照（想先看主檔對不對時很好用）
   * @param {boolean} [options.force] 已經有真實交易時仍強制重跑（預設會擋，見下）
   */
  m.run = (options) => {
    options = options || {};
    var legacy = m.readLegacy();
    var ss = AssetSchema.open();
    var today = new Date();
    var tz = ss.getSpreadsheetTimeZone();
    var todayStr = Utilities.formatDate(today, tz, 'yyyy-MM-dd');
    var stamp = Utilities.formatDate(today, tz, 'yyyy-MM-dd HH:mm:ss');

    var counts = {};

    // ── 期初日：定下來就不再變 ─────────────────────────────────
    //
    // 期初列同時是成本基礎的起點與 XIRR 的起算日。重跑遷移時若把它改成「今天」，
    // 它就可能排到你已經記錄的真實交易**之後** —— replay 會判定那些賣出
    // 「當下無持股」而整筆跳過。所以已經有期初列就沿用原本的日期。
    var existingTrades = AssetSchema.readObjects(ss.getSheetByName('交易'));
    var epochStr = _existingEpoch(existingTrades, tz) || todayStr;

    // 已經有非遷移的真實交易、而期初日又比它們晚 —— 這種狀態沒有正確解，擋下來
    var userDates = existingTrades
      .filter(t => _str(t['來源']) !== MIGRATION_SOURCE)
      .map(t => _dateStr(t['日期'], tz))
      .filter(Boolean)
      .sort();
    if (userDates.length && epochStr > userDates[0] && !options.force) {
      throw new Error(
        '「交易」裡已有 ' + userDates.length + ' 筆非遷移交易，最早一筆是 ' + userDates[0] +
        '，早於期初日 ' + epochStr + '。重跑遷移會讓那些交易發生在建倉之前（賣出會被當成無持股跳過）。' +
        '請先確認要不要保留它們；確定要照做請執行 AssetMigrate.run({force:true})。'
      );
    }
    counts['期初日'] = epochStr;

    // ── 標的 ──
    var instRows = legacy.holdings.map(h => {
      var c = legacy.classify[h.code] || {};
      return [h.code, h.name, 'TPE', 'TWD', 'GOOGLEFINANCE',
              c.region || '', c.kind || '', '', '持有中',
              h.plan ? '舊表計畫：' + h.plan : ''];
    });

    // 舊表的 @股利 裡有已經出清、但當年確實領過息的標的（例如 2412、2881、00687B）。
    // 舊表的「總股利」是 SUMIF 到「所有股票」上的，這些配息因此從沒被算進去。
    // 這裡把它們補成 狀態=已出清 的標的，累計股利才會是真的。
    var held = {};
    legacy.holdings.forEach(h => { held[h.code] = true; });
    var retired = [];
    legacy.dividends.forEach(d => {
      if (held[d.code] || retired.indexOf(d.code) >= 0) return;
      retired.push(d.code);
    });
    retired.sort().forEach(code => {
      instRows.push([code, code, 'TPE', 'TWD', 'GOOGLEFINANCE', '', '', '', '已出清',
                     '舊表僅剩股利紀錄，名稱與分類請自行補上']);
    });
    counts['已出清標的'] = retired.length;
    _replaceByKey(ss.getSheetByName('標的'), instRows, 10, 0);
    counts['標的'] = instRows.length;

    // ── 帳戶 ──
    var acctRows = legacy.accounts.map(a => [
      a.name, a.type, a.currency, '', a.balance, epochStr, '啟用',
      '期初餘額由舊表面板遷移'
    ]);
    _replaceByKey(ss.getSheetByName('帳戶'), acctRows, 8, 0);
    counts['帳戶'] = acctRows.length;

    // ── 實體資產（黃金）──
    var goldPriceFormula = '=IFERROR(GOOGLEFINANCE("CURRENCY:XAUTWD")/31.1035,"")';
    var physRows = legacy.physical.map((x, n) => {
      var r = n + 2;
      return [
        x.name, x.category, x.qty, '公克', '', '', 'GOOGLEFINANCE:XAUTWD',
        goldPriceFormula,
        '=IF($C' + r + '="",0,$C' + r + '*N($H' + r + '))',
        '=IF($E' + r + '="",0,$C' + r + '*$E' + r + ')',
        '=$I' + r + '-$J' + r,
        '⚠️ 單位成本未知，請補上買入均價才能算損益'
      ];
    });
    AssetSchema.writeBlock(ss.getSheetByName('實體資產'), physRows, 12);
    counts['實體資產'] = physRows.length;

    // ── 交易：期初建倉 + 歷史股利 ──
    // 兩者的「帳戶」都留空，因為帳戶期初餘額已經是遷移當下的實際數字。
    var tradeRows = [];

    legacy.holdings.forEach(h => {
      if (h.shares <= 0) return;
      tradeRows.push([
        epochStr, '期初', h.code, h.name, h.shares, h.cost / h.shares, 0, 0, '',
        '', 'TWD', '', '投資',
        '期初部位（舊表遷移，非真實買進日）', MIGRATION_SOURCE, stamp
      ]);
    });

    legacy.dividends.forEach(d => {
      tradeRows.push([
        d.date instanceof Date ? Utilities.formatDate(d.date, tz, 'yyyy-MM-dd') : _str(d.date),
        '股利', d.code, '', '', '', '', '', d.amount,
        '', 'TWD', '', '投資',
        '舊表股利紀錄', MIGRATION_SOURCE, stamp
      ]);
    });

    _replaceBySource(ss.getSheetByName('交易'), tradeRows, 16);
    counts['交易'] = tradeRows.length;

    // ── 每日快照 ──
    if (!options.skipSnapshot) {
      var snapRows = m._buildSnapshotRows(legacy, tz);
      _replaceByStatus(ss.getSheetByName('每日快照'), snapRows, 9, '遷移');
      counts['每日快照'] = snapRows.length;
    } else {
      counts['每日快照'] = '略過';
    }

    // 交易表列數變多了，公式要重填
    AssetSchema.applyTradeFormulas(ss);
    SpreadsheetApp.flush();

    Logger.info('AssetMigrate.run', '遷移完成', counts);
    return { ok: true, counts: counts, note: '接著執行 rebuildPositions() 重算持倉' };
  };

  /**
   * 把舊的寬表快照攤平成長表。
   * 舊表沒有歷史股數，所以持股列只有單價，數量與市值留空 —— 這是資料本身的
   * 限制，不要用當日股數回推，那會做出假的歷史市值。
   */
  m._buildSnapshotRows = (legacy, tz) => {
    var header = legacy.snapshot.header;
    var idxDate  = header.indexOf('日期');
    var idxTotal = header.indexOf('總價值');
    var idxStock = header.indexOf('股票總價值');
    if (idxDate < 0 || idxTotal < 0 || idxStock < 0) {
      throw new Error('舊快照表標題列異常，找不到 日期／總價值／股票總價值');
    }

    // 名稱 → 代號（舊表快照的欄名用的是「名稱」）
    var codeByName = {};
    legacy.holdings.forEach(h => { codeByName[h.name] = h.code; });

    var stockCols = [];   // 日期與總價值之後、股票總價值之前
    for (var c = idxTotal + 1; c < idxStock; c++) {
      if (header[c]) stockCols.push({ col: c, name: header[c], code: codeByName[header[c]] || header[c] });
    }
    var cashCols = [];    // 股票總價值之後
    for (var c2 = idxStock + 1; c2 < header.length; c2++) {
      if (header[c2] && header[c2] !== '狀態') cashCols.push({ col: c2, name: header[c2] });
    }

    var rows = [];
    legacy.snapshot.rows.forEach(r => {
      var d = r[idxDate];
      var dateStr = d instanceof Date ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : _str(d);
      if (!dateStr) return;

      rows.push([dateStr, '合計', '總資產', '', '', '', _num(r[idxTotal]), 'TWD', '遷移']);
      rows.push([dateStr, '合計', '股票市值', '', '', '', _num(r[idxStock]), 'TWD', '遷移']);

      stockCols.forEach(sc => {
        var price = _num(r[sc.col]);
        if (!price) return;
        rows.push([dateStr, '持股', sc.code, sc.name, '', price, '', 'TWD', '遷移']);
      });

      cashCols.forEach(cc => {
        var v = _num(r[cc.col]);
        if (!v) return;
        var kind = /黃金|金塊/.test(cc.name) ? '實體' : '現金';
        rows.push([dateStr, kind, cc.name, '', '', '', v, 'TWD', '遷移']);
      });
    });

    return rows;
  };

  // ─── 寫入輔助：只覆蓋自己寫過的列 ─────────────────────────────

  /** 依第 keyCol 欄的鍵值覆蓋：既有的同鍵列更新，新的接在後面 */
  var _replaceByKey = (sheet, rows, width, keyCol) => {
    var lastRow = sheet.getLastRow();
    var existing = lastRow >= 2
      ? sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), width)).getValues()
      : [];
    var keyed = {};
    existing.forEach((r, i) => { if (_str(r[keyCol])) keyed[_str(r[keyCol])] = i + 2; });

    var appended = [];
    rows.forEach(row => {
      var k = _str(row[keyCol]);
      if (keyed[k]) sheet.getRange(keyed[k], 1, 1, width).setValues([row]);
      else appended.push(row);
    });
    if (appended.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, width).setValues(appended);
    }
  };

  /** 刪掉所有 來源 = migration 的列，再整批寫入（重跑遷移不會疊加） */
  var _replaceBySource = (sheet, rows, width) => {
    var map = AssetSchema.headerMap(sheet);
    var srcIdx = map['來源'];
    var lastRow = sheet.getLastRow();
    if (srcIdx !== undefined && lastRow >= 2) {
      var vals = sheet.getRange(2, srcIdx + 1, lastRow - 1, 1).getValues();
      for (var i = vals.length - 1; i >= 0; i--) {
        if (_str(vals[i][0]) === MIGRATION_SOURCE) sheet.deleteRow(i + 2);
      }
    }
    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
    }
  };

  /** 同上，但依「狀態」欄辨識，並分批寫入（快照量大） */
  var _replaceByStatus = (sheet, rows, width, status) => {
    var map = AssetSchema.headerMap(sheet);
    var stIdx = map['狀態'];
    var lastRow = sheet.getLastRow();
    if (stIdx !== undefined && lastRow >= 2) {
      var vals = sheet.getRange(2, stIdx + 1, lastRow - 1, 1).getValues();
      // 遷移列一定在最前面且連續，整段刪比逐列刪快好幾個數量級
      var first = -1, count = 0;
      for (var i = 0; i < vals.length; i++) {
        if (_str(vals[i][0]) === status) { if (first < 0) first = i + 2; count++; }
        else if (first >= 0) break;
      }
      if (count > 0) sheet.deleteRows(first, count);
    }
    var start = sheet.getLastRow() + 1;
    var CHUNK = 5000;
    for (var j = 0; j < rows.length; j += CHUNK) {
      var slice = rows.slice(j, j + CHUNK);
      sheet.getRange(start + j, 1, slice.length, width).setValues(slice);
    }
  };

  // ─── 對帳 ──────────────────────────────────────────────────────

  /**
   * 比對新舊試算表的關鍵數字。遷移完 + 重算完之後跑這個。
   * 容差 1 元（浮點與四捨五入）。
   */
  m.verify = () => {
    var legacy = m.readLegacy();
    var ss = AssetSchema.open();
    var positions = AssetSchema.readObjects(ss.getSheetByName('持倉'));
    var cash      = AssetSchema.readObjects(ss.getSheetByName('現金'));

    var byCode = {};
    positions.forEach(x => { byCode[_str(x['代號'])] = x; });

    var lines = ['【新舊對帳】', ''];
    var bad = 0;
    var cmp = (label, oldV, newV, tol) => {
      var ok = Math.abs(oldV - newV) <= (tol === undefined ? 1 : tol);
      if (!ok) bad++;
      lines.push((ok ? '  ✓ ' : '  ✗ ') + label +
        '：舊 ' + Math.round(oldV).toLocaleString() +
        ' / 新 ' + Math.round(newV).toLocaleString() +
        (ok ? '' : '　差 ' + Math.round(newV - oldV).toLocaleString()));
    };

    lines.push('▸ 持倉');
    legacy.holdings.forEach(h => {
      var np = byCode[h.code];
      if (!np) { bad++; lines.push('  ✗ ' + h.code + '：新表找不到這檔'); return; }
      cmp(h.code + ' 股數', h.shares, _num(np['股數']), 0.001);
      cmp(h.code + ' 成本', h.cost, _num(np['總成本']));
      cmp(h.code + ' 累計股利', h.dividend, _num(np['累計股利']));
    });

    lines.push('');
    lines.push('▸ 現金帳戶');
    var cashByName = {};
    cash.forEach(c => { cashByName[_str(c['帳戶'])] = c; });
    legacy.accounts.forEach(a => {
      var nc = cashByName[a.name];
      if (!nc) { bad++; lines.push('  ✗ ' + a.name + '：新表找不到'); return; }
      cmp(a.name + '（' + a.currency + '）', a.balance, _num(nc['餘額']), 0.01);
    });

    lines.push('');
    lines.push('▸ 股利筆數：舊 ' + legacy.dividends.length +
      ' / 新（交易表 migration 股利）' + _countMigratedDividends(ss));
    lines.push('▸ 每日快照：舊 ' + legacy.snapshot.rows.length + ' 天');

    lines.push('');
    lines.push(bad === 0 ? '全部對得起來 ✓' : '⚠️ 有 ' + bad + ' 項對不起來，先別切換');
    return lines.join('\n');
  };

  var _countMigratedDividends = (ss) => {
    var trades = AssetSchema.readObjects(ss.getSheetByName('交易'));
    return trades.filter(t => _str(t['來源']) === MIGRATION_SOURCE && _str(t['動作']) === '股利').length;
  };

  return m;
})();

// ─── GAS 編輯器進入點 ─────────────────────────────────────────────

/** 步驟 2：從舊試算表搬資料（可重複執行，不會疊加） */
function migrateLegacyData() {
  var r = AssetMigrate.run();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

/** 步驟 2b：只搬主檔與交易，跳過 950 天快照（想先確認結構時用） */
function migrateLegacyDataQuick() {
  var r = AssetMigrate.run({ skipSnapshot: true });
  console.log(JSON.stringify(r, null, 2));
  return r;
}

/** 步驟 4：新舊對帳 */
function verifyAssetSheet() {
  var report = AssetMigrate.verify();
  console.log(report);
  return report;
}
