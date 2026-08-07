/**
 * Snapshot
 * @description 顧問感知層的「備料」模組
 *
 * 收集所有 Sheet 的當下狀態，並預先計算關鍵指標，
 * 產出一份結構化 JSON 給 AdvisorCheck 餵給 LLM 判斷。
 *
 * 不做判斷、不做通知、只做資料整理。
 *
 * ⚠️ **資料來源已改為新的「資產管理」表**（指令碼屬性 `SHEET_ID`）。
 * 對外的輸出形狀刻意一個欄位都沒動 —— Dashboard、MiniApp、AdvisorCheck
 * 全都吃這裡的結果，形狀不變它們就不用改。要改欄位的話那三個要一起看。
 *
 * 舊表 → 新表的對應：
 *   所有股票（寬表）      → 持倉
 *   面板 E1:F8（固定格）  → 現金
 *   @所有股票紀錄（寬表） → 每日快照（長表，類型=合計 且 鍵=總資產）
 *   @股利                 → 交易（動作=股利）
 *   @固定                 → 實體資產
 */
var Snapshot = (() => {
  var snap = {};

  /** 資料一律讀「資產管理」表。走 AssetSchema.open() 才會經過 SHEET_ID 的守門。 */
  snap._open = () => AssetSchema.open();

  // ─── 工具函式 ──────────────────────────────────────────────
  //
  // 儲存格取值一律走 AssetSchema.str / .num（見那裡的註解）。包成區域別名只是
  // 讓下面的程式短一點；用箭頭函式而不是直接指派，是因為 GAS 的檔案載入順序
  // 沒有保證，指派會在 AssetSchema 還沒定義時就爆掉。
  var _str = (v) => AssetSchema.str(v);
  var _num = (v) => AssetSchema.num(v);

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
   * 每日快照裡的「總資產」逐日序列（由舊到新）
   * 長表結構：日期 | 類型 | 鍵 | 名稱 | 數量 | 單價 | 市值 | 幣別 | 狀態
   */
  var _totalHistory = (ss, limit) => {
    var sheet = ss.getSheetByName('每日快照');
    if (!sheet) return [];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    // 一天 18 列左右，往回抓足夠的量就好，不要整張讀
    var span = Math.min(lastRow - 1, (limit || 40) * 40);
    var startRow = Math.max(2, lastRow - span + 1);
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 9).getValues();

    return data
      .filter(r => r[0] && _str(r[1]) === '合計' && _str(r[2]) === '總資產')
      .map(r => {
        var o = {
          date:  r[0] instanceof Date ? _ymd(r[0]) : _str(r[0]),
          total: _num(r[6])
        };
        // 狀態只在「不是正常交易日」時才帶出去（休市／資料未更新／報價異常）。
        // 一年 365 個 "交易日" 字串會白白吃掉 Dashboard 那 90KB 的快取額度，
        // 而會影響判讀的本來就只有異常的那幾天 —— 平的那一段是假日還是抓取失敗。
        var st = _str(r[8]);
        if (st && st !== '交易日') o.status = st;
        return o;
      })
      .filter(r => r.total > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  };

  /**
   * 總資產指標：今日 vs 昨日 vs 上週 vs 上月
   *
   * 「今天」取的是`指標`的即時總資產，不是快照的最後一列 —— 快照一天只寫一次，
   * 盤中拿它當今天會落後一整天；歷史比較才用快照。
   */
  snap._totals = (ss) => {
    var rows = _totalHistory(ss, 40);

    // 指標表的總資產是即時算出來的（持倉市值 + 現金 + 實體資產）
    var live = null;
    try {
      var panel = AssetSchema.readObjects(ss.getSheetByName('指標'));
      var hit = panel.filter(x => _str(x['指標']) === '總資產')[0];
      if (hit) live = _num(hit['數值']);
    } catch (e) { /* 讀不到就退回快照 */ }

    var todayStr = _ymd(new Date());
    if (live > 0) {
      // 同一天的快照列換成即時值，避免今天被算兩次
      if (rows.length && rows[rows.length - 1].date === todayStr) rows.pop();
      rows.push({ date: todayStr, total: live });
    }

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
   *
   * 來源改成「持倉」—— 那張表本身就是 Position.rebuild() 從交易推導出來的，
   * 股數、成本、累計股利、已實現損益都是算好的，不必再自己拼。
   * 市價與市值是表上的 GOOGLEFINANCE 公式；抓不到時市值會是 0，標記 priceMissing
   * 讓 LLM 知道這檔的數字不可信，而不是默默當成歸零。
   *
   * 當日漲跌幅仍然走 StockPrice（TWSE 即時報價），試算表公式沒有這個欄位。
   */
  snap._holdings = (ss) => {
    var sheet = ss.getSheetByName('持倉');
    if (!sheet) return [];

    var rows = AssetSchema.readObjects(sheet)
      .filter(r => _num(r['股數']) > 0)
      .map(r => {
        var marketValue = _num(r['市值']);
        return {
          code: _str(r['代號']),
          name: _str(r['名稱']),
          shares: _num(r['股數']),
          price: _num(r['市價']),
          marketValue: marketValue,
          costBasis: _num(r['總成本']),
          totalDividend: _num(r['累計股利']),
          realized: _num(r['已實現損益']),
          priceMissing: marketValue <= 0
        };
      });

    if (rows.length === 0) return [];

    var totalMarketValue = rows.reduce((s, h) => s + h.marketValue, 0);

    // ── 抓即時漲跌幅 ──
    var livePrices = {};
    try {
      StockPrice.getRawPrices(rows.map(h => h.code)).forEach(p => { livePrices[p.code] = p; });
    } catch (e) {
      Logger.warning('Snapshot._holdings', '即時股價抓取失敗，僅使用 Sheet 資料', e.message);
    }

    return rows.map(h => {
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
      // 新表獨有：已實現損益（舊表推導不出來，所以舊版沒有這個欄位）
      if (h.realized) result.realizedPnl = _round(h.realized);
      if (h.priceMissing) result.priceMissing = true;
      return result;
    });
  };

  /**
   * 現金：各帳戶水位（現金表，外幣已換算台幣）
   */
  snap._cash = (ss) => {
    var sheet = ss.getSheetByName('現金');
    if (!sheet) return null;
    try {
      var accounts = [], total = 0;
      AssetSchema.readObjects(sheet).forEach(r => {
        var label = _str(r['帳戶']);
        if (!label) return;
        // 台幣值 = 餘額 × 匯率，外幣帳戶才不會被當成台幣直接加總
        var v = _num(r['台幣值']);
        accounts.push({ account: label, amount: _round(v) });
        total += v;
      });
      if (accounts.length === 0) return null;
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
   * 股利聚合（交易表裡動作＝股利的列）
   *   本月、今年、去年同期、最近 3 筆
   */
  snap._dividends = (ss) => {
    if (!ss.getSheetByName('交易')) return null;

    var data = AssetSchema.readTrades(ss)
      .filter(r => _str(r['動作']) === '股利')
      .map(r => ({
        date: r['日期'] instanceof Date ? r['日期'] : new Date(_str(r['日期'])),
        code: _str(r['代號']),
        amount: _num(r['金額'])
      }))
      .filter(r => r.date && !isNaN(r.date.getTime()) && r.amount > 0)
      .sort((a, b) => a.date - b.date);

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
   * 投資績效指標（讀「指標」那張 key-value 表）
   *
   * `Position.rebuild()` 早就把未實現／已實現／累計股利／淨損益／XIRR 都算好寫在那裡了，
   * 只是沒有人把它接出來 —— 儀表板因此只講得出「有多少」，講不出「賺多少」。
   *
   * ⚠️ 一併帶出最上面的「⚠️ 待修正」列。那是 `Position.replay` 的警告（懸空的賣出、
   * 抓不到市價的檔）唯一的出口；少了它，畫面會把少算過的數字照樣畫成圖，一聲不吭。
   *
   * 分隔列（`—— 投資績效 ——` 這種）與空字串都會被濾掉：XIRR 算不出來時寫的是空字串，
   * 直接 _num 會變成 0，看起來像「年化報酬率 0%」而不是「還算不出來」。
   *
   * 刻意不併進 `collectAll()`：那份會整包序列化進 LLM prompt，形狀一改就得同時看
   * AdvisorCheck 與三份報告，不是這裡該順手做的事。
   */
  snap._metrics = (ss) => {
    var sheet = ss.getSheetByName('指標');
    if (!sheet) return null;
    try {
      var kv = {}, note = {}, warnings = [];
      AssetSchema.readObjects(sheet).forEach(r => {
        var k = _str(r['指標']);
        if (!k) return;
        if (k.indexOf('⚠️') === 0) {
          var w = _str(r['說明']);
          if (w) warnings.push(w);
          return;
        }
        if (k.indexOf('——') === 0) return;      // 分隔列
        kv[k] = r['數值'];
        note[k] = _str(r['說明']);
      });

      // 空字串 = 算不出來，要傳 null 而不是 0
      var n = (key) => {
        var v = kv[key];
        if (v === '' || v === null || v === undefined) return null;
        return _num(v);
      };

      return {
        stockCost:     n('股票投入成本'),
        unrealized:    n('未實現損益'),
        unrealizedPct: n('未實現報酬率'),
        realized:      n('已實現損益'),
        dividendTotal: n('累計股利'),
        netPnl:        n('淨損益'),
        xirr:          n('XIRR（年化）'),
        // 兩個頁面以前各自寫死「現金流跨度不足」，而那句話多半是錯的（真正的
        // 原因有三種）。原因只有 Position 算得出來，就讓它寫進說明欄一路傳上來。
        xirrNote:      note['XIRR（年化）'] || '',
        currentYield:  n('現值殖利率'),
        costYield:     n('成本殖利率'),
        stockRatio:    n('股票佔比'),
        cashRatio:     n('現金佔比'),
        physicalRatio: n('實體佔比'),
        tradeCount:    n('交易筆數'),
        positionCount: n('持倉檔數'),
        lastRebuild:   _str(kv['最後重算']),
        warnings:      warnings
      };
    } catch (e) {
      Logger.warning('Snapshot._metrics', '讀取指標失敗', e.message);
      return null;
    }
  };

  /**
   * 實體資產（黃金）：總重量、件數、市值
   */
  snap._gold = (ss) => {
    var sheet = ss.getSheetByName('實體資產');
    if (!sheet) return null;
    try {
      var rows = AssetSchema.readObjects(sheet).filter(r => _str(r['類別']) === '黃金');
      if (rows.length === 0) return null;
      return {
        totalWeight: _round(rows.reduce((s, r) => s + _num(r['數量']), 0), 2),
        pieces: rows.length,
        unit: _str(rows[0]['單位']) || '公克',
        marketValue: _round(rows.reduce((s, r) => s + _num(r['市值']), 0))
      };
    } catch (e) {
      return null;
    }
  };


  // ─── Dashboard 專用（不進 collectAll）────────────────────────
  //
  // 以下兩個函式只給網頁儀表板畫圖用，刻意不併入 collectAll()：
  // collectAll 的結果會整份序列化進 LLM prompt，灌一年份的逐日序列
  // 只會吃掉 context 又對判斷沒幫助。

  /**
   * 總資產逐日序列（每日快照：類型=合計、鍵=總資產）
   * @param {number} [days]  最近幾天（預設 365）
   * @param {object} [ss]    可傳入已開啟的試算表以省一次 open
   * @returns {Array<{date: string, total: number}>} 由舊到新
   */
  snap.totalSeries = (days, ss) => {
    try {
      ss = ss || snap._open();
      days = Math.min(days || 365, 3650);
      var rows = _totalHistory(ss, days);
      return rows.slice(Math.max(0, rows.length - days));
    } catch (e) {
      Logger.warning('Snapshot.totalSeries', '讀取總資產序列失敗', e.message);
      return [];
    }
  };

  /**
   * 股利的年度與月份分佈（交易表裡動作=股利的列）
   * @param {object} [ss]
   * @returns {{byYear: Array<{year, total, count}>, currentYear: number, byMonth: Array<number>}}
   *          byMonth 為當年 1~12 月合計，固定長度 12
   */
  snap.dividendSeries = (ss) => {
    var empty = { byYear: [], currentYear: new Date().getFullYear(), byMonth: [] };
    try {
      ss = ss || snap._open();
      if (!ss.getSheetByName('交易')) return empty;

      var rows = AssetSchema.readTrades(ss)
        .filter(r => String(r['動作'] || '').trim() === '股利')
        .map(r => ({
          date:   r['日期'] instanceof Date ? r['日期'] : new Date(String(r['日期'])),
          amount: _num(r['金額'])
        }))
        .filter(r => r.date && !isNaN(r.date.getTime()) && r.amount > 0);

      if (rows.length === 0) return empty;

      var yearMap = {};
      rows.forEach(r => {
        var y = r.date.getFullYear();
        if (!yearMap[y]) yearMap[y] = { year: y, total: 0, count: 0 };
        yearMap[y].total += r.amount;
        yearMap[y].count++;
      });

      var currentYear = new Date().getFullYear();
      var byMonth = new Array(12).fill(0);
      rows.forEach(r => {
        if (r.date.getFullYear() === currentYear) byMonth[r.date.getMonth()] += r.amount;
      });

      return {
        byYear: Object.keys(yearMap)
          .map(y => ({
            year:  yearMap[y].year,
            total: _round(yearMap[y].total),
            count: yearMap[y].count
          }))
          .sort((a, b) => a.year - b.year),
        currentYear: currentYear,
        byMonth: byMonth.map(v => _round(v))
      };
    } catch (e) {
      Logger.warning('Snapshot.dividendSeries', '讀取股利序列失敗', e.message);
      return empty;
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
    var ss = snap._open();
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
