/**
 * Snapshot
 * @description 顧問感知層的「備料」模組
 *
 * 收集所有 Sheet 的當下狀態，並預先計算關鍵指標，
 * 產出一份結構化 JSON 給 AdvisorCheck 餵給 LLM 判斷。
 *
 * 不做判斷、不做通知、只做資料整理。
 */
var Snapshot = (() => {
  var snap = {};

  // ─── 工具函式 ──────────────────────────────────────────────

  var _num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    var s = String(v).trim();
    // GOOGLEFINANCE 錯誤值或 loading 狀態
    if (s.startsWith('#') || /^Loading/i.test(s) || s === 'N/A') return 0;
    var n = parseFloat(s.replace(/[,%$]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  var _pct = (curr, base) => {
    if (!base) return 0;
    return (curr - base) / base;
  };

  var _round = (n, digits) => {
    var p = Math.pow(10, digits || 0);
    return Math.round(n * p) / p;
  };

  var _ymd = (d) => Utilities.formatDate(d, 'GMT+8', 'yyyy-MM-dd');

  // ─── 子模組 ────────────────────────────────────────────────

  /**
   * 總資產指標：今日 vs 昨日 vs 上週 vs 上月
   * 資料來源：@所有股票紀錄 B 欄（總價值，setData 寫入）
   */
  snap._totals = (ss) => {
    var sheet = ss.getSheetByName('@所有股票紀錄');
    if (!sheet) return null;

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    var startRow = Math.max(2, lastRow - 40); // 取最近 ~40 筆夠涵蓋一個月
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 2).getValues();

    var rows = data
      .filter(r => r[0] && r[1] !== '' && r[1] !== null)
      .map(r => ({ date: r[0] instanceof Date ? _ymd(r[0]) : String(r[0]), total: _num(r[1]) }))
      .filter(r => r.total > 0);

    if (rows.length === 0) return null;

    var today = rows[rows.length - 1];
    var yesterday = rows.length >= 2 ? rows[rows.length - 2] : null;
    var weekAgo = rows.length >= 6 ? rows[rows.length - 6] : null;     // 約 5 個交易日前
    var monthAgo = rows.length >= 22 ? rows[rows.length - 22] : null;  // 約 21 個交易日前

    return {
      todayDate: today.date,
      today: _round(today.total),
      yesterday: yesterday ? _round(yesterday.total) : null,
      dayChange: yesterday ? _round(today.total - yesterday.total) : null,
      dayChangePct: yesterday ? _round(_pct(today.total, yesterday.total), 4) : null,
      weekChangePct: weekAgo ? _round(_pct(today.total, weekAgo.total), 4) : null,
      monthChangePct: monthAgo ? _round(_pct(today.total, monthAgo.total), 4) : null
    };
  };

  /**
   * 持倉明細：每檔當日漲跌、市值、佔比、累計股利
   * 資料源：
   *   主：所有股票 sheet → 代號/名稱/股數/總成本/當前市價/總股利
   *        marketValue = 股數 × 當前市價
   *   備援：配置 sheet → 當前價值（用代號 join，當 GOOGLEFINANCE 出錯時補）
   */
  snap._holdings = (ss) => {
    var stockSheet = ss.getSheetByName('所有股票');
    var allocSheet = ss.getSheetByName('配置');
    if (!stockSheet) return [];
    var lastRow = stockSheet.getLastRow();
    var lastCol = stockSheet.getLastColumn();
    if (lastRow < 3) return [];

    // ── 「配置」sheet 的當前價值 fallback ──
    var fallbackValue = {};
    if (allocSheet) {
      try {
        var aLastRow = allocSheet.getLastRow();
        var aLastCol = allocSheet.getLastColumn();
        var aHeaders = allocSheet.getRange(1, 1, 1, aLastCol).getValues()[0]
          .map(h => String(h || '').trim());
        var aIdx = (n) => aHeaders.findIndex(h => h === n);
        var iaCode    = aIdx('代號');
        var iaCurrent = aIdx('當前價值');
        if (iaCode >= 0 && iaCurrent >= 0 && aLastRow >= 2) {
          var aData = allocSheet.getRange(2, 1, aLastRow - 1, aLastCol).getValues();
          aData.forEach(r => {
            var code = String(r[iaCode] || '').trim();
            if (!code || code === '0000') return;
            fallbackValue[code] = _num(r[iaCurrent]);
          });
        }
      } catch (e) {
        Logger.warning('Snapshot._holdings', '讀取配置 fallback 失敗', e.message);
      }
    }

    // ── 從「所有股票」讀本表 ──
    var headers = stockSheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(h => String(h || '').trim());
    var data = stockSheet.getRange(3, 1, lastRow - 2, lastCol).getValues();
    var idx = (name) => headers.findIndex(h => h === name);
    var iCode     = idx('代號')   >= 0 ? idx('代號')   : 0;
    var iName     = idx('名稱')   >= 0 ? idx('名稱')   : 1;
    var iShares   = idx('股數')   >= 0 ? idx('股數')   : 4;  // E 欄
    var iCost     = idx('總成本') >= 0 ? idx('總成本') : 5;  // F 欄
    var iPrice    = idx('當前市價') >= 0 ? idx('當前市價') : 6; // G 欄
    var iDividend = idx('總股利') >= 0 ? idx('總股利') : 10; // K 欄

    var rawRows = data
      .filter(r => r[iCode] && String(r[iCode]).trim() !== '')
      .map(r => {
        var code   = String(r[iCode]).trim();
        var shares = _num(r[iShares]);
        var price  = _num(r[iPrice]);
        var costBasis = _num(r[iCost]);
        var marketValue = shares > 0 && price > 0 ? shares * price : 0;
        // 若 GOOGLEFINANCE 故障，用配置 sheet 當 fallback
        var priceMissing = !price && (fallbackValue[code] || 0) > 0;
        if (!marketValue && fallbackValue[code]) marketValue = fallbackValue[code];
        return {
          code: code,
          name: String(r[iName] || '').trim(),
          price: price,
          shares: shares,
          marketValue: marketValue,
          costBasis: costBasis,
          totalDividend: _num(r[iDividend]),
          priceMissing: priceMissing
        };
      });

    var totalMarketValue = rawRows.reduce((s, h) => s + h.marketValue, 0);

    // ── 抓即時漲跌幅 ──
    var codes = rawRows.map(h => h.code);
    var livePrices = {};
    try {
      var raw = StockPrice.getRawPrices(codes);
      raw.forEach(p => { livePrices[p.code] = p; });
    } catch (e) {
      Logger.warning('Snapshot._holdings', '即時股價抓取失敗，僅使用 Sheet 資料', e.message);
    }

    return rawRows.map(h => {
      var live = livePrices[h.code];
      var pnl = h.marketValue && h.costBasis ? h.marketValue - h.costBasis : null;
      var pnlPct = h.costBasis > 0 ? (h.marketValue - h.costBasis) / h.costBasis : null;
      var displayPrice = (live && live.current) ? live.current : h.price;
      var result = {
        code: h.code,
        name: h.name,
        shares: h.shares,
        price: _round(displayPrice, 2),
        marketValue: _round(h.marketValue),
        costBasis: _round(h.costBasis),
        totalDividendReceived: _round(h.totalDividend),
        pnl: pnl !== null ? _round(pnl) : null,
        pnlPct: pnlPct !== null ? _round(pnlPct, 4) : null,
        dayChangePct: live ? _round(live.changePct, 4) : null,
        ratioOfPortfolio: totalMarketValue > 0 ? _round(h.marketValue / totalMarketValue, 4) : 0,
        isClosed: live ? !!live.isClosed : null
      };
      if (h.priceMissing) result.priceMissing = true;  // 提示 LLM 此檔當前市價是用配置 sheet 補的
      return result;
    });
  };

  /**
   * 現金：各帳戶水位（面板 E1:F8）
   */
  snap._cash = (ss) => {
    var sheet = ss.getSheetByName('面板');
    if (!sheet) return null;
    try {
      var labels = sheet.getRange('E1:E8').getValues();
      var vals   = sheet.getRange('F1:F8').getValues();
      var accounts = [];
      var total = 0;
      for (var i = 0; i < 8; i++) {
        var label = String(labels[i][0] || '').trim();
        if (!label) continue;
        var v = _num(vals[i][0]);
        accounts.push({ account: label, amount: _round(v) });
        total += v;
      }
      return { accounts: accounts, total: _round(total) };
    } catch (e) {
      Logger.warning('Snapshot._cash', '讀取現金失敗', e.message);
      return null;
    }
  };

  /**
   * 資產配置：目前實際 vs 目標（配置 sheet）
   * 配置 sheet 結構不一定固定，盡量泛用：讀 headers + rows，過濾空列
   */
  snap._allocation = (ss) => {
    var sheet = ss.getSheetByName('配置');
    if (!sheet) return [];
    try {
      var lastRow = sheet.getLastRow();
      var lastCol = sheet.getLastColumn();
      if (lastRow < 2) return [];
      var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
        .map(h => String(h || '').trim());
      var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

      return data
        .filter(r => r.some(v => v !== '' && v !== null))
        .map(row => {
          var obj = {};
          headers.forEach((h, i) => {
            if (h && row[i] !== '' && row[i] !== null) {
              obj[h] = (typeof row[i] === 'number') ? _round(row[i], 4) : row[i];
            }
          });
          return obj;
        });
    } catch (e) {
      Logger.warning('Snapshot._allocation', '讀取配置失敗', e.message);
      return [];
    }
  };

  /**
   * 股利聚合（@股利）
   *   本月、今年、去年同期、最近 3 筆
   */
  snap._dividends = (ss) => {
    var sheet = ss.getSheetByName('@股利');
    if (!sheet) return null;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues()
      .filter(r => r[0] && r[1] && r[2] !== '' && r[2] !== null)
      .map(r => ({
        date: r[0] instanceof Date ? r[0] : new Date(r[0]),
        code: String(r[1]).trim(),
        amount: _num(r[2])
      }))
      .filter(r => !isNaN(r.date.getTime()) && r.amount > 0);

    if (data.length === 0) return null;

    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth(); // 0-indexed

    var thisMonth = data.filter(r => r.date.getFullYear() === year && r.date.getMonth() === month);
    var thisYear  = data.filter(r => r.date.getFullYear() === year);
    var lastYearSamePeriod = data.filter(r =>
      r.date.getFullYear() === year - 1 && r.date.getMonth() <= month
    );

    var sum = (arr) => arr.reduce((s, r) => s + r.amount, 0);

    return {
      thisMonth: {
        total: _round(sum(thisMonth)),
        count: thisMonth.length,
        items: thisMonth.map(r => ({ date: _ymd(r.date), code: r.code, amount: _round(r.amount) }))
      },
      thisYear: {
        total: _round(sum(thisYear)),
        count: thisYear.length
      },
      lastYearSamePeriod: {
        total: _round(sum(lastYearSamePeriod)),
        count: lastYearSamePeriod.length
      },
      yoyChangePct: sum(lastYearSamePeriod) > 0
        ? _round(_pct(sum(thisYear), sum(lastYearSamePeriod)), 4)
        : null,
      recent: data.slice(-3).reverse().map(r => ({
        date: _ymd(r.date), code: r.code, amount: _round(r.amount)
      }))
    };
  };

  /**
   * 黃金（@固定 + 面板總值）
   * 細節不展開，只給總重量與總市值
   */
  snap._gold = (ss) => {
    var sheet = ss.getSheetByName('@固定');
    if (!sheet) return null;
    try {
      var lastRow = sheet.getLastRow();
      if (lastRow < 1) return null;
      var data = sheet.getRange(1, 1, lastRow, 3).getValues();
      var totalWeight = 0;
      var pieces = 0;
      data.forEach(r => {
        if (String(r[0]).trim() === '黃金' && r[1]) {
          totalWeight += _num(r[1]);
          pieces++;
        }
      });
      return {
        totalWeight: _round(totalWeight, 2),
        pieces: pieces,
        unit: '錢/兩混合（依 @固定 原始登錄）'
      };
    } catch (e) {
      return null;
    }
  };

  // ─── 對外主入口 ────────────────────────────────────────────

  /**
   * 收集完整快照
   * @param {object} [options]
   * @param {boolean} [options.includeAllocation] 是否納入配置（成本較高，預設 true）
   * @returns {object} 結構化財務快照
   */
  snap.collectAll = (options) => {
    options = options || {};
    var ss = SpreadsheetApp.openById(Config.SHEET_ID);
    var now = new Date();

    var result = {
      timestamp: Utilities.formatDate(now, 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
      totals:    snap._totals(ss),
      holdings:  snap._holdings(ss),
      cash:      snap._cash(ss),
      dividends: snap._dividends(ss),
      gold:      snap._gold(ss)
    };

    if (options.includeAllocation !== false) {
      result.allocation = snap._allocation(ss);
    }

    return result;
  };

  /**
   * 短路檢查：若整體看似平靜，回 true 表示可跳過 LLM 呼叫
   * 三個條件全符合才算平靜：
   *   1. 總資產日變動 < 0.5%
   *   2. 無單檔當日漲跌 >= 3%
   *   3. 無持倉佔比異常（>50% 或 <2% 但市值 > 0）
   */
  snap.isQuiet = (data) => {
    if (!data) return false;

    var dayChange = data.totals && data.totals.dayChangePct;
    if (dayChange !== null && dayChange !== undefined && Math.abs(dayChange) >= 0.005) return false;

    var hasHoldingMove = (data.holdings || []).some(h =>
      h.dayChangePct !== null && Math.abs(h.dayChangePct) >= 0.03
    );
    if (hasHoldingMove) return false;

    var hasExtremeRatio = (data.holdings || []).some(h =>
      h.ratioOfPortfolio > 0.5 || (h.ratioOfPortfolio > 0 && h.ratioOfPortfolio < 0.02)
    );
    if (hasExtremeRatio) return false;

    return true;
  };

  return snap;
})();
