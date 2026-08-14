/**
 * Snapshot
 * @description 資產狀態的結構化讀取層 —— 「現在手上是什麼」只從這裡出去
 *
 * 讀「資產管理」表的當下狀態、算好關鍵指標，產出結構化 JSON。
 * 不做判斷、不做通知、不做排版。
 *
 * ⚠️ 四個消費端吃同一份輸出，改欄位形狀要四個一起看：
 *   Dashboard.getPayload → DashboardPage.html / MiniAppPage.html
 *   GoogleSheet.getHoldings / getDashboard / getHistory（格式化給 LLM）
 *   AdvisorCheck（collectAll，整包序列化進 prompt）
 */
var Snapshot = (() => {
  var snap = {};

  /** 資料一律讀「資產管理」表。走 AssetSchema.open() 才會經過 SHEET_ID 的守門。 */
  snap._open = () => AssetSchema.open();

  // ⚠️ 包成箭頭函式而非直接指派：GAS 不保證檔案載入順序
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

  // ⚠️ 不可用 instanceof Date：跨 realm 會是 false，然後落到 _num() 拿到 0,
  //    正是這個檢查要防的事。用鴨子型別。
  var _isDate = (v) => !!v && typeof v.getTime === 'function' && !isNaN(v.getTime());

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
        // 狀態只在非正常交易日時帶出（休市／資料未更新／報價異常）。
        // 一年 365 個 "交易日" 字串會吃掉 Dashboard 的 90KB 快取額度。
        var st = _str(r[8]);
        if (st && st !== '交易日') o.status = st;
        return o;
      })
      .filter(r => r.total > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  };

  /**
   * 這幾種狀態的那一天不能拿來當比較基準（狀態的定義見 DataSync）：
   *   報價異常   — 有持股抓不到市價，總資產是短計的
   *   資料未更新 — 每一檔都和前一次快照一模一樣，可能是國定假日，也可能是整批抓價失敗
   * 「休市」不在內：週末的收盤價本來就是週五那一筆，拿它當基準是對的。
   * 這份名單與 GoogleSheet.getHistory 對主人講的那句話一致 —— 那裡已經說了
   * 這兩種「不可信，算波動或漲跌前要先排除」，這裡是同一條規則的執行面。
   */
  var UNTRUSTED_STATUS = { '報價異常': true, '資料未更新': true };

  /**
   * 'yyyy-MM-dd' 加減天數，純字串運算。
   * ⚠️ 不走 Utilities.formatDate：那要指定時區，而這些日期本來就是試算表的本地日，
   *    繞一趟時區只會多一個對不齊的機會。用 UTC 當算盤，進出都是同一種字串。
   */
  var _shiftYmd = (ymd, days) => {
    var m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    d.setUTCDate(d.getUTCDate() + days);
    var p2 = (n) => (n < 10 ? '0' : '') + n;
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  };

  /**
   * 往回找一筆可以當基準的快照：日期距離 today 至少 days 天，且那天的狀態可信。
   * days = 0 就是「前一筆可信的快照」。
   *
   * ⚠️ 不可以改回「往回數 N 列」。那等於假設每一個交易日都剛好留下一筆快照，
   *    而 18:00 那班被 GAS 砍掉、或整天抓不到價，那天就沒有列 —— 於是「近一週」
   *    會靜靜地變成近兩週，而數字照樣印得跟真的一樣。這正是這個專案一再遇到的
   *    那種病：下層算得出差別，排版時掉了，模型只能照著講。
   *    所以基準的**日期**要一路帶到 Facts，讓它講得出來自己在跟哪一天比。
   */
  var _baseline = (rows, todayDate, days) => {
    var cutStr = _shiftYmd(todayDate, -days);
    for (var i = rows.length - 2; i >= 0; i--) {
      if (cutStr && rows[i].date > cutStr) continue;        // 還太近
      if (UNTRUSTED_STATUS[rows[i].status]) continue;       // 那天的數字不可信
      return rows[i];
    }
    return null;
  };

  /**
   * 總資產指標：今日 vs 前一筆 vs 一週前 vs 一月前。
   * 「今天」取「指標」的即時總資產而非快照最後一列 —— 快照一天只寫一次，
   * 盤中拿它當今天會落後一整天。
   *
   * 三個基準都是**按日期**往回找的，而且會跳過不可信的那幾天，
   * 各自的實際日期也一併回傳（yesterdayDate / weekBaseDate / monthBaseDate）。
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

    var today     = rows[rows.length - 1];
    var yesterday = _baseline(rows, today.date, 0);    // 前一筆可信的快照
    var weekAgo   = _baseline(rows, today.date, 7);
    var monthAgo  = _baseline(rows, today.date, 30);

    return {
      todayDate: today.date,
      today: _round(today.total),
      yesterday: yesterday ? _round(yesterday.total) : null,
      // 基準的日期要跟著比例一起出去。少了它，「近一週」在快照有缺口時
      // 會是近兩週，而讀的人（與模型）沒有任何辦法察覺。
      yesterdayDate: yesterday ? yesterday.date : null,
      weekBaseDate:  weekAgo ? weekAgo.date : null,
      monthBaseDate: monthAgo ? monthAgo.date : null,
      dayChange: yesterday ? _round(today.total - yesterday.total) : null,
      dayChangePct: yesterday ? _round(_pct(today.total, yesterday.total), 4) : null,
      weekChangePct: weekAgo ? _round(_pct(today.total, weekAgo.total), 4) : null,
      monthChangePct: monthAgo ? _round(_pct(today.total, monthAgo.total), 4) : null
    };
  };

  /**
   * 持倉明細：每檔當日漲跌、市值、佔比、累計股利。
   * 來源是「持倉」表（Position.rebuild() 推導出來的）。市價與市值是表上的
   * GOOGLEFINANCE 公式，抓不到時市值為 0 並標記 priceMissing。
   * 當日漲跌走 StockPrice（TWSE 即時報價），試算表公式沒有這個欄位。
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
      // ⚠️ 只在盤中用 MIS 的即時價。非交易時段它的 current 是昨收，
      //    而表上的 GOOGLEFINANCE 值多半已是今日收盤，且與同列市值同源。
      var liveUsable   = live && live.current > 0 && !live.isClosed;
      var displayPrice = liveUsable ? live.current : (h.price || (live ? live.current : 0));
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
        // ⚠️ 不可寫成 `live ? _round(live.changePct, 4) : null`：_round(null) 是 0，
        //    「不知道」會變成「今天平盤」。要檢查值，不是檢查物件。
        dayChangePct: (live && live.changePct !== null && live.changePct !== undefined)
          ? _round(live.changePct, 4) : null,
        ratioOfPortfolio: totalMarketValue > 0 ? _round(h.marketValue / totalMarketValue, 4) : 0,
        isClosed: live ? !!live.isClosed : null
      };
      // 出清過才有，沒有就整個欄位不出現（前端一律 `|| 0`）
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
          // ⚠️ 分母要跟著比例一起送出去。這張表的「實際%」有兩種基準（大類是
          // 總資產、區域／類型是股票市值，見 Position 的 pushGroup），兩個 0..1
          // 的數字擺在一起，模型分不出來就會拿去跟「股票佔總資產」互相比較 ——
          // 2026-08-09 就發生過同一種事（把佔股票市值的 32.22% 當成佔總資產）。
          // 表上不加欄位是刻意的：這是給讀的人用的標籤，不是要存的資料。
          if (obj['維度']) obj['基準'] = obj['維度'] === '大類' ? '佔總資產' : '佔股票市值';
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

      // 空字串 = 算不出來，回 null 而不是 0。
      // ⚠️ Date 也要回 null：比例欄若被 Sheets 誤判成時間格式（0.0706 → 1:41:40），
      //    讀回來是 Date，而 AssetSchema.num(Date) 是 0 —— 格式壞掉會偽裝成真的 0%。
      //    寫入端每次重算前會清格式（見 Position），這裡是第二道防線。
      var n = (key) => {
        var v = kv[key];
        if (v === '' || v === null || v === undefined) return null;
        if (_isDate(v)) {
          Logger.warning('Snapshot._metrics', '指標的數值被誤判成日期格式', key);
          return null;
        }
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
        // Sheets 常把這個時間字串吃成 Date，而 _str(Date) 會吐出 JS 的 toString，
        // 那會原封不動進 prompt 與 getHoldings 的【資料時點】。
        lastRebuild:   _isDate(kv['最後重算'])
          ? Utilities.formatDate(kv['最後重算'], 'GMT+8', 'yyyy-MM-dd HH:mm:ss')
          : _str(kv['最後重算']),
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
   *
   * ⚠️ 條件 2 在**唯一的呼叫端（19:00 的 advisorCheckEvening）幾乎永遠成立**，
   *    因為那時候收盤了，MIS 給不出當日成交價，`dayChangePct` 全是 null。
   *    以前它們是 0，看起來像「每檔都平盤」，一樣過不了門檻 —— 差別只在現在是
   *    誠實的「不知道」。要讓這條真的有作用，得改的是**排程時間或資料來源**
   *    （例如改讀當日快照的漲跌），不是把 null 當成 0。
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
