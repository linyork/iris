/**
 * Position
 * @description 從「交易」重算持倉、已實現損益、現金、配置、指標
 *
 * 把交易依日期重放，維護每檔的（股數, 總成本），賣出時按加權平均沖銷
 * （與台灣券商對帳單一致）：
 *     沖銷成本 = n × (總成本 / 股數)
 *     已實現損益 = 賣出淨額 − 沖銷成本
 *
 * 不用試算表公式的原因：加權平均是路徑相依的，SUMIF 這類彙總函式表達不出來。
 *
 * ⚠️ 會整段覆寫「持倉」「已實現損益」「現金」「配置」「指標」，
 *    最後由 Panel.render() 重畫「面板」。那幾張表不可手改。
 */
var Position = (() => {
  var p = {};

  // ⚠️ 包成箭頭函式而非直接指派：GAS 不保證檔案載入順序
  var _num = (v) => AssetSchema.num(v);
  var _str = (v) => AssetSchema.str(v);

  var _date = (v) => {
    if (v instanceof Date) return v;
    var s = _str(v);
    if (!s) return null;
    var m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  var _round = (n, digits) => {
    var f = Math.pow(10, digits || 0);
    return Math.round((n + Number.EPSILON) * f) / f;
  };

  // 不用 Utilities.formatDate 以避免綁時區：這些值本來就是試算表的本地日。
  // ⚠️ 用鴨子型別而非 instanceof Date：跨 realm 時 instanceof 會是 false，
  //    日期會靜靜變成空字串。
  var _ymd = (d) => {
    if (!d || typeof d.getFullYear !== 'function') return '';
    var p2 = (n) => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  };

  /**
   * 市價公式：`IFERROR(GOOGLEFINANCE, IFERROR(TWSE STOCK_DAY_AVG, ""))`。
   * 只有 TPE 市場有第二層，該端點只認上市代號。
   *
   * ⚠️ 正規表示式開頭的 `.*` 用來抓最後一筆。STOCK_DAY_AVG 回整個月、由舊到新，
   *    少了它會抓到月初的收盤價。RE2 沒有反向比對，貪婪前綴是唯一辦法。
   * ⚠️ 用 `[^0-9]*` 而非寫死引號：IMPORTDATA 把 JSON 當 CSV 解析，
   *    日期與價格之間的分隔字元不固定。
   * ⚠️ 內層 `IFERROR(..., "")` 不可移除。$I 以 `$H=""` 判斷有沒有報到價，
   *    備援失敗時必須是空字串而非錯誤值，否則 SUM($I$2:$I) 一起壞。
   * ⚠️ 已知缺口：GOOGLEFINANCE 回字串 `Loading...` 時備援不會啟動（那不是錯誤值），
   *    $C*$H 會變 #VALUE!。修法是包一層 IF(ISNUMBER(gf), gf, twse)，
   *    代價是公式長度翻倍；目前選擇可讀性。總資產變 #VALUE! 時再加回來。
   * ⚠️ 本機測試只驗公式長相，無法求值（IMPORTDATA 需連外網）。
   */
  var _priceFormula = (market, r) => {
    var gf = 'GOOGLEFINANCE("' + market + ':"&$A' + r + ',"price")';
    if (market !== 'TPE') return '=IFERROR(' + gf + ',"")';
    var url = '"https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_AVG?date="' +
              '&TEXT(TODAY(),"yyyyMMdd")&"&stockNo="&$A' + r;
    var twse =
      'IFERROR(VALUE(REGEXEXTRACT(CONCATENATE(IMPORTDATA(' + url + ')),' +
      '".*\\d{3}/\\d{2}/\\d{2}[^0-9]*([0-9.]+)")),"")';
    return '=IFERROR(' + gf + ',' + twse + ')';
  };

  /**
   * 第三層報價：公式的兩層都失敗時，由 GAS 自己抓並把數字寫進 H。
   *
   * 前兩層（GOOGLEFINANCE 與 IMPORTDATA）都是試算表側的外部函式，
   * 受同一份文件層級的配額管制，會一起失效 —— 疊在同一層等於沒有備援。
   * 這一層走 StockPrice 的 UrlFetchApp（伺服器端請求），不受該配額影響。
   *
   * ⚠️ 寫入的是死值不是公式，不會自我更正。可接受是因為每次 rebuild() 都會先用
   *    writeBlock 把公式整片重寫，下次重算會再給 GOOGLEFINANCE 一次機會。
   *    留空白更糟：$I 會歸零，總資產、佔比、每日快照全部跟著錯。
   * ⚠️ MIS 端點只認上市（tse_），非 TPE 標的不送出。
   *
   * @returns {{filled: Array<{code, price}>, stillMissing: Array<string>}}
   */
  p._fillMissingPrices = (ss, instByCode) => {
    var out = { filled: [], stillMissing: [] };
    if (typeof StockPrice === 'undefined' || typeof UrlFetchApp === 'undefined') return out;
    try {
      var sheet = ss.getSheetByName('持倉');
      if (!sheet) return out;
      var last = sheet.getLastRow();
      if (last < 2) return out;

      // 直接讀範圍而非 readObjects：這裡需要實際列號，而 readObjects 會跳過空白列
      var values = sheet.getRange(2, 1, last - 1, 8).getValues();   // A..H
      var want = [];
      values.forEach((row, i) => {
        var code   = _str(row[0]);
        var shares = _num(row[2]);
        var price  = row[7];
        if (!code || shares <= 0) return;
        if (price !== '' && price !== null && _num(price) > 0) return;
        var market = _str((instByCode[code] || {})['市場']) || 'TPE';
        if (market !== 'TPE') { out.stillMissing.push(code); return; }
        want.push({ code: code, row: i + 2 });
      });
      if (!want.length) return out;

      Logger.warning('Position._fillMissingPrices', '公式抓不到價，改用 TWSE MIS 端點',
        { codes: want.map(w => w.code) });

      var quotes = StockPrice.getRawPrices(want.map(w => w.code));
      var byCode = {};
      quotes.forEach(q => { if (q && q.code) byCode[String(q.code)] = q; });

      want.forEach(w => {
        var q = byCode[w.code];
        if (q && q.current > 0) {
          sheet.getRange(w.row, 8).setValue(q.current);
          out.filled.push({ code: w.code, price: q.current });
        } else {
          out.stillMissing.push(w.code);
        }
      });
      if (out.filled.length) SpreadsheetApp.flush();   // $I 要跟著重算
      Logger.info('Position._fillMissingPrices', '備援報價寫入完成', out);
    } catch (ex) {
      Logger.error('Position._fillMissingPrices', '備援報價失敗', ex);
    }
    return out;
  };

  // ─── 交易重放 ──────────────────────────────────────────────────

  /**
   * 依日期重放交易，算出每檔的持倉狀態與每一筆賣出的沖銷結果。
   * @param {Array<object>} trades 交易表的物件陣列
   * @returns {{positions: object, realized: Array, dividends: object}}
   */
  p.replay = (trades) => {
    var sorted = trades
      .map((t, i) => ({ t: t, i: i, d: _date(t['日期']) }))
      .filter(x => x.d && _str(x.t['動作']))
      // 同一天的交易保持輸入順序：先買後賣與先賣後買的均價不同。
      // 唯一的例外是「期初」—— 它的語義是「那天開始時就有的部位」，必須排在
      // 同日其他交易之前。重跑遷移會把期初列刪掉重新接到表尾，若照輸入順序，
      // 當天記過的賣出就會排到建倉之前，被判定成「無持股」而整筆消失。
      .sort((a, b) => (a.d - b.d) ||
        ((_str(a.t['動作']) === '期初' ? 0 : 1) - (_str(b.t['動作']) === '期初' ? 0 : 1)) ||
        (a.i - b.i))
      .map(x => x.t);

    var positions = {};   // code → { shares, cost, dividend, realized }
    var realized  = [];
    // 被夾住或跳過的交易。這些**不能只寫進 consolelog**：交易列的「現金流」
    // 公式用的是使用者填的原始股數，程式這邊卻夾到了實際持股 —— 兩邊會對不起來
    // （持倉正確、現金卻多入帳）。所以要一路往上冒到 rebuild 的結果與面板。
    var warnings  = [];

    var slot = (code) => {
      if (!positions[code]) positions[code] = { shares: 0, cost: 0, dividend: 0, realized: 0 };
      return positions[code];
    };

    sorted.forEach(t => {
      var action = _str(t['動作']);
      var code   = _str(t['代號']);
      var shares = _num(t['股數']);
      var price  = _num(t['單價']);
      var fee    = _num(t['手續費']);
      var tax    = _num(t['交易稅']);

      // 「期初」＝遷移建倉，持倉與成本照算，差別只在它不動現金（見 AssetSchema.ACTIONS）
      if (action === '買進' || action === '期初') {
        if (!code || shares <= 0) return;
        var pos = slot(code);
        pos.shares += shares;
        pos.cost   += shares * price + fee;   // 手續費計入成本，與券商成本認列一致
        return;
      }

      if (action === '賣出') {
        if (!code || shares <= 0) return;
        var ps = slot(code);
        if (ps.shares <= 0) {
          warnings.push(_str(t['日期']) + ' ' + code + ' 賣出 ' + shares +
            ' 股，但當下無持股，該筆已跳過（現金流仍照這列算，請修正這列）');
          Logger.error('Position.replay', '賣出時無持股，該筆跳過', { code: code, shares: shares });
          return;
        }
        var sellQty = Math.min(shares, ps.shares);
        if (sellQty < shares) {
          warnings.push(_str(t['日期']) + ' ' + code + ' 賣出 ' + shares +
            ' 股超過持股 ' + ps.shares + ' 股，已以持股數為準（現金流仍按 ' + shares +
            ' 股入帳，兩邊會對不起來，請修正這列）');
          Logger.error('Position.replay', '賣出股數超過持股，以持股數為準', {
            code: code, requested: shares, held: ps.shares
          });
        }
        var avg      = ps.cost / ps.shares;
        var costOut  = avg * sellQty;
        var proceeds = sellQty * price - fee - tax;

        realized.push({
          date: t['日期'], code: code, name: _str(t['名稱']),
          shares: sellQty, price: price, proceeds: proceeds,
          costOut: costOut, pnl: proceeds - costOut,
          rate: costOut > 0 ? (proceeds - costOut) / costOut : 0,
          avgBefore: avg
        });

        ps.shares  -= sellQty;
        ps.cost    -= costOut;
        ps.realized += proceeds - costOut;
        if (ps.shares <= 1e-9) { ps.shares = 0; ps.cost = 0; }   // 出清歸零，避免浮點殘渣
        return;
      }

      if (action === '股利') {
        if (!code) return;
        slot(code).dividend += _num(t['金額']);
      }
    });

    return { positions: positions, realized: realized, warnings: warnings };
  };

  // ─── XIRR ──────────────────────────────────────────────────────

  // 年化一段太短的期間毫無意義：5 天賺 0.7% 年化就是 107%，市場多動一天就翻倍。
  // 未滿這個天數時「數值」留空，說明欄改寫未年化的期間報酬 —— 那個數字現在就是真的。
  p.XIRR_MIN_DAYS = 90;

  /**
   * XIRR 的開帳市值：早於錨定日的最後一天，「每日快照」記的股票市值。
   *
   * 為什麼是**早於**而不是當天：錨定日（遷移日）當天通常已經有真實買賣，而快照
   * 是當天 18:00 收盤後寫的，已經含進那些交易。拿當天的快照當開帳，那幾筆就會
   * 被算兩次 —— 一次在開帳餘額裡，一次又當成流量。前一天的收盤市值才乾淨對應
   * 期初列的持股。
   *
   * 讀不到就回 null，由呼叫端把 XIRR 留空並說明原因；這裡不猜、也不用成本代替
   * （用成本就退回原本那個 10¹⁵ 的坑）。
   *
   * @param {object} ss
   * @param {Date} anchorDate 期初列的日期
   * @returns {{date: Date, value: number}|null}
   */
  p._openingValue = (ss, anchorDate) => {
    try {
      var sheet = ss.getSheetByName('每日快照');
      if (!sheet || !anchorDate) return null;
      var best = null;
      AssetSchema.readObjects(sheet).forEach(r => {
        if (_str(r['類型']) !== '合計' || _str(r['鍵']) !== '股票市值') return;
        var d = _date(r['日期']);
        if (!d || d >= anchorDate) return;
        var v = _num(r['市值']);
        if (v <= 0) return;
        if (!best || d > best.date) best = { date: d, value: v };
      });
      return best;
    } catch (e) {
      Logger.warning('Position._openingValue', '讀不到每日快照的開帳市值', e.message);
      return null;
    }
  };

  /**
   * 用 Newton-Raphson 解年化報酬率，收斂失敗才退回二分法。
   * @param {Array<{date: Date, amount: number}>} flows 投入為負、回收為正
   * @returns {number|null}
   */
  p.xirr = (flows) => {
    if (!flows || flows.length < 2) return null;
    var pos = flows.some(f => f.amount > 0);
    var neg = flows.some(f => f.amount < 0);
    if (!pos || !neg) return null;              // 全同號無解

    var t0 = flows[0].date.getTime();
    var yr = (d) => (d.getTime() - t0) / (365 * 24 * 3600 * 1000);
    var npv = (r) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, yr(f.date)), 0);

    var rate = 0.1;
    for (var i = 0; i < 60; i++) {
      var v = npv(rate);
      if (Math.abs(v) < 1e-6) return _round(rate, 6);
      var d = (npv(rate + 1e-6) - v) / 1e-6;
      if (!isFinite(d) || Math.abs(d) < 1e-12) break;
      var next = rate - v / d;
      if (!isFinite(next) || next <= -0.9999) break;
      if (Math.abs(next - rate) < 1e-10) return _round(next, 6);
      rate = next;
    }

    var lo = -0.9999, hi = 10;
    if (npv(lo) * npv(hi) > 0) return null;
    for (var j = 0; j < 200; j++) {
      var mid = (lo + hi) / 2;
      if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
    }
    return _round((lo + hi) / 2, 6);
  };

  // ─── 重算主流程 ────────────────────────────────────────────────

  /**
   * 重算全部計算層分頁。
   * @param {object} [options]
   * @param {boolean} [options.dryRun] 只回傳計算結果，不寫入
   */
  p.rebuild = (options) => {
    options = options || {};
    var ss = AssetSchema.open();

    var need = ['交易', '標的', '帳戶', '實體資產', '持倉', '已實現損益', '現金', '配置', '指標', '面板'];
    var missing = need.filter(n => !ss.getSheetByName(n));
    if (missing.length) {
      var msg = '缺少分頁：' + missing.join('、') + '，請先執行 setupAssetSheet()';
      Logger.error('Position.rebuild', msg);
      return { ok: false, reason: msg };
    }

    var instSheet   = ss.getSheetByName('標的');
    // 作廢的列不進重放，也不進 XIRR 與「交易筆數」—— readTrades 預設就濾掉了
    var trades      = AssetSchema.readTrades(ss);
    var instruments = AssetSchema.readObjects(instSheet);
    var accounts    = AssetSchema.readObjects(ss.getSheetByName('帳戶'));

    var replayed = p.replay(trades);

    // ── 持倉 ──────────────────────────────────────────────────
    // A~G 由程式算；H 之後放公式，讓市價/市值跟著 GOOGLEFINANCE 即時變動。
    var instByCode = {};
    instruments.forEach(i => { instByCode[_str(i['代號'])] = i; });

    // 目標配置% 指回「標的」而不是抄成死值：那一欄是人手維護的，抄過來的話
    // 改完目標要等下一次 rebuild，偏離才會跟著動。
    //
    // 欄索引讀**活的標題列**，不是 TABS —— 公式住在試算表裡，就得對得上試算表
    // 實際的欄序。寫死一個數字的話，在它左邊插一欄就會靜默抓到隔壁欄（現在那裡
    // 是「類型」，文字被讀成 0），每一檔的目標都變 0 而且不報錯。
    // 真的找不到這一欄才退回 TABS 的位置：VLOOKUP 會抓到空白讀成 0，
    // 比組出 $A:$ 這種爛範圍讓整欄噴錯好。
    var _targetIdx = AssetSchema.headerMap(instSheet)['目標配置%'];
    if (_targetIdx === undefined || _targetIdx < 0) {
      _targetIdx = AssetSchema.expected('標的').indexOf('目標配置%');
      Logger.error('Position.rebuild', '「標的」找不到 目標配置% 欄，退回 TABS 的位置');
    }
    _targetIdx += 1;                                   // VLOOKUP 的欄索引是 1-based
    var _targetRef = '標的!$A:$' + AssetSchema.colLetter(_targetIdx);

    var codes = Object.keys(replayed.positions)
      .filter(c => {
        var st = replayed.positions[c];
        return st.shares > 0 || st.realized !== 0 || st.dividend !== 0;
      })
      .sort();

    var posRows = codes.map((code, n) => {
      var st  = replayed.positions[code];
      var ins = instByCode[code] || {};
      var r   = n + 2;                                  // 實際列號
      var market = _str(ins['市場']) || 'TPE';
      var avg = st.shares > 0 ? st.cost / st.shares : 0;

      return [
        code,
        _str(ins['名稱']),
        _round(st.shares, 4),
        _round(st.cost, 2),
        _round(avg, 4),
        _round(st.dividend, 2),
        _round(st.realized, 2),
        // 市價：出清的標的不抓價，省 GOOGLEFINANCE 配額也避免 #N/A
        st.shares > 0 ? _priceFormula(market, r) : '',
        '=IF(OR($C' + r + '=0,$H' + r + '=""),0,$C' + r + '*$H' + r + ')',
        '=$I' + r + '-$D' + r,
        '=IF($D' + r + '=0,0,$J' + r + '/$D' + r + ')',
        '=$D' + r + '-$F' + r,
        '=IF($L' + r + '=0,0,($I' + r + '-$L' + r + ')/$L' + r + ')',
        '=IF(SUM($I$2:$I)=0,0,$I' + r + '/SUM($I$2:$I))',
        _str(ins['區域']),
        _str(ins['類型']),
        '=IFERROR(VLOOKUP($A' + r + ',' + _targetRef + ',' + _targetIdx + ',FALSE),0)',
        "=IFERROR($I" + r + "/VLOOKUP(\"總資產\",指標!$A:$B,2,FALSE),0)",
        '=$R' + r + '-$Q' + r
      ];
    });

    // ── 已實現損益 ────────────────────────────────────────────
    var realRows = replayed.realized.map(x => [
      x.date, x.code, x.name,
      _round(x.shares, 4), _round(x.price, 4), _round(x.proceeds, 2),
      _round(x.costOut, 2), _round(x.pnl, 2), _round(x.rate, 6), _round(x.avgBefore, 4)
    ]);

    // ── 現金 ──────────────────────────────────────────────────
    var cashRows = accounts
      .filter(a => _str(a['帳戶']) && _str(a['狀態']) !== '停用')
      .map((a, n) => {
        var r   = n + 2;
        var cur = _str(a['幣別']) || 'TWD';
        return [
          _str(a['帳戶']), _str(a['類型']), cur,
          _num(a['期初餘額']),
          '=SUMIF(交易!$L:$L,$A' + r + ',交易!$J:$J)',
          '=$D' + r + '+$E' + r,
          cur === 'TWD' ? 1 : '=IFERROR(GOOGLEFINANCE("CURRENCY:' + cur + 'TWD"),1)',
          '=$F' + r + '*$G' + r
        ];
      });

    if (options.dryRun) {
      return {
        ok: true, dryRun: true,
        positions: posRows.length, realized: realRows.length, cash: cashRows.length,
        warnings: replayed.warnings,
        detail: codes.map(c => ({
          code: c,
          shares: _round(replayed.positions[c].shares, 4),
          cost: _round(replayed.positions[c].cost, 2),
          avg: replayed.positions[c].shares > 0
            ? _round(replayed.positions[c].cost / replayed.positions[c].shares, 4) : 0,
          dividend: _round(replayed.positions[c].dividend, 2),
          realized: _round(replayed.positions[c].realized, 2)
        }))
      };
    }

    AssetSchema.writeBlock(ss.getSheetByName('持倉'), posRows, 19);
    AssetSchema.writeBlock(ss.getSheetByName('已實現損益'), realRows, 10);
    AssetSchema.writeBlock(ss.getSheetByName('現金'), cashRows, 8);

    SpreadsheetApp.flush();   // 指標要讀上面幾張表算完的值

    // 公式兩層都沒抓到價的，這裡用 GAS 自己的請求補上；補完再 flush 一次，
    // 下面的指標才讀得到更新後的市值
    var priceFix = p._fillMissingPrices(ss, instByCode);

    // ⚠️ 這一句一定要在 _writePanelAndAllocation 之前 —— 「指標」最上面的
    // 「⚠️ 待修正」列就是從 replayed.warnings 生出來的，寫完之後才 push 就只剩
    // 回覆看得到，儀表板的警示條完全不知情
    if (priceFix.filled.length) {
      replayed.warnings.push(
        priceFix.filled.map(x => x.code).join('、') +
        ' 的市價 GOOGLEFINANCE 抓不到，已改用 TWSE 即時 API 補上（寫進去的是死值，' +
        '不會自己更新；下次重算會再試一次公式）');
    }

    var summary = p._writePanelAndAllocation(ss, trades, replayed);

    // 面板純粹是公式排版，只有「畫幾列」會變 —— 擺在最後重畫，
    // 這樣持倉多一檔或出清一檔，版面就跟著對上。
    Panel.render(ss);

    // 資料剛動過，儀表板與 Mini App 的快取就過期了。不清的話，記完一筆交易
    // 最久要等 15 分鐘才看得到 —— 而使用者記完通常馬上就會去看。
    if (typeof Dashboard !== 'undefined') Dashboard.invalidate();

    var result = {
      ok: true,
      positions: posRows.length,
      realized: realRows.length,
      cashAccounts: cashRows.length,
      trades: trades.length,
      totalAssets: summary.totalAssets,
      xirr: summary.xirr
    };
    if (priceFix.filled.length) result.priceFallback = priceFix.filled.map(x => x.code + '@' + x.price);
    if (replayed.warnings.length) result.warnings = replayed.warnings;
    Logger.info('Position.rebuild', '重算完成', result);
    return result;
  };

  /**
   * 產生「指標」與「配置」。
   * 這兩張要等持倉的公式算完（市值），所以獨立成一段、在 flush 之後跑。
   */
  p._writePanelAndAllocation = (ss, trades, replayed) => {
    var posSheet = ss.getSheetByName('持倉');
    var positions = AssetSchema.readObjects(posSheet);
    var cash      = AssetSchema.readObjects(ss.getSheetByName('現金'));
    var physical  = AssetSchema.readObjects(ss.getSheetByName('實體資產'));

    var sum = (arr, key) => arr.reduce((a, x) => a + _num(x[key]), 0);

    var stockValue    = sum(positions, '市值');
    var stockCost     = positions.reduce((a, x) => a + (_num(x['股數']) > 0 ? _num(x['總成本']) : 0), 0);
    var cashValue     = sum(cash, '台幣值');
    var physicalValue = sum(physical, '市值');
    var physicalCost  = sum(physical, '成本');
    var totalDividend = sum(positions, '累計股利');
    var totalRealized = sum(positions, '已實現損益');
    var totalAssets   = stockValue + cashValue + physicalValue;

    // ── 缺價守門 ──────────────────────────────────────────────
    //
    // 有股數卻讀到市值 0 = 那一刻報價還沒回來（GOOGLEFINANCE 對剛掛牌的標的
    // 可能整天都沒有資料；`SpreadsheetApp.flush()` 也不等外部函式算完）。
    // 這種時候**下面每一個彙總都是錯的**，而且錯得沒有跡象 —— 2026-08-04 就是
    // 這樣把 009826 的 302 萬市值當成 0 寫進指標，儀表板顯示單日 −20%。
    //
    // 頭四個數字改用公式（見下）之後會自己修正，但 JS 這邊算出來的
    // 未實現損益／報酬率／XIRR／配置仍然是死值，所以要把這件事講出來。
    var noPrice = positions.filter(x => _num(x['股數']) > 0 && _num(x['市值']) <= 0);
    if (noPrice.length) {
      var codes = noPrice.map(x => _str(x['代號'])).join('、');
      replayed.warnings.push(
        codes + ' 有持股但抓不到市價，本次的未實現損益／報酬率／配置都少算了這幾檔。' +
        '總資產與股票市值是公式、報價回來會自己更正；其餘數字請等下一次重算'
      );
      Logger.error('Position.rebuild', '有持股讀不到市價', { codes: codes });
    }

    // ── XIRR ──────────────────────────────────────────────────
    //
    // ⚠️ 「期初」不是買進，是**開帳餘額**，這一行區別就是這個數字有沒有意義。
    //
    // 舊版把期初列當成買進，用**成本**當第一筆負現金流。可是那個成本是好幾年
    // 累積下來的，日期卻是遷移日 —— 等於宣稱「遷移日花 700 萬買，四天後值 951
    // 萬」。一輩子的獲利被壓進幾天裡年化，真正的解落在 r ≈ 2×10¹⁵，遠在
    // `p.xirr` 的搜尋上限（hi = 10）之外，於是回 null，而說明欄還寫著
    // 「現金流跨度不足」——  跨度不是問題，錨點才是。
    //
    // 正確做法是拿**錨定日的市值**當開帳：一輩子的獲利留在開帳餘額裡（它本來
    // 就該在那），XIRR 量的是「自 Iris 開始完整記帳以來」的資金加權報酬。
    // 開帳市值只有「每日快照」有，所以往前找**早於錨定日**的最後一天；那天
    // 收盤的市值恰好對應期初列的持股，之後的每一筆買賣才是流量。
    //
    // 沒有期初列（整本都是真實交易）就不需要錨點，全部照舊當流量算。
    var anchor = trades
      .filter(t => _str(t['動作']) === '期初')
      .map(t => _date(t['日期']))
      .filter(d => d)
      .sort((a, b) => a - b)[0] || null;

    var opening = anchor ? p._openingValue(ss, anchor) : null;
    var xirrBlocked = anchor && !opening
      ? '找不到早於期初日（' + _ymd(anchor) + '）的每日快照，開帳市值無從取得'
      : '';

    var flows = [];
    if (opening) flows.push({ date: opening.date, amount: -opening.value });

    trades.forEach(t => {
      var action = _str(t['動作']);
      var d = _date(t['日期']);
      if (!d) return;
      // 期初已由開帳市值取代；錨點當天（含）以前的一切也都已經包在那個市值裡
      if (action === '期初') return;
      if (opening && d <= opening.date) return;
      if (action === '買進') {
        flows.push({ date: d, amount: -(_num(t['股數']) * _num(t['單價']) + _num(t['手續費'])) });
      } else if (action === '賣出') {
        flows.push({ date: d, amount: _num(t['股數']) * _num(t['單價']) - _num(t['手續費']) - _num(t['交易稅']) });
      } else if (action === '股利') {
        flows.push({ date: d, amount: _num(t['金額']) });
      }
    });
    flows.sort((a, b) => a.date - b.date);
    if (flows.length) flows.push({ date: new Date(), amount: stockValue });

    var xirr     = xirrBlocked ? null : p.xirr(flows);
    var spanDays = flows.length > 1
      ? Math.round((flows[flows.length - 1].date - flows[0].date) / 86400000) : 0;

    // 期間太短就不年化 —— 但期間報酬本身是真的，寫進說明欄
    var xirrNote;
    if (xirrBlocked) {
      xirrNote = xirrBlocked + '，暫時算不出來';
    } else if (xirr === null) {
      xirrNote = '現金流無解（全部同號或找不到報酬率），等有跨期買賣後才算得出來';
    } else if (spanDays < p.XIRR_MIN_DAYS) {
      var periodPct = Math.pow(1 + xirr, spanDays / 365) - 1;
      xirrNote = '起算日 ' + _ymd(flows[0].date) + ' 至今僅 ' + spanDays + ' 天，' +
        '年化沒有意義（期間報酬 ' + (periodPct >= 0 ? '+' : '') +
        (periodPct * 100).toFixed(2) + '%）；滿 ' + p.XIRR_MIN_DAYS + ' 天後才顯示';
      xirr = null;
    } else {
      xirrNote = '含時間加權的年化報酬率，自 ' + _ymd(flows[0].date) +
        ' 的開帳市值起算' + (anchor ? '（遷移前的損益已含在開帳餘額裡，不計入報酬）' : '');
    }

    // ── 殖利率：近 12 個月實際領到的股利 ÷ 現在的市值／成本 ──
    //
    // ⚠️ 分子只算**現在還持有**的標的。已出清的部位（2412、00687B…）過去一年
    //    照樣發過錢，但它們不在分母裡 —— 拿走掉的東西發的錢除以留著的東西的
    //    成本，比率會虛高，而且是往好看的方向虛高。
    //
    // 遷移進來的股利**要算**：那是有真實日期的歷史配息（可回溯到 2023），
    // 正是這兩個指標唯一不需要回補就能用的原因。與 XIRR 的排除規則相反，
    // 因為這裡量的是「這些資產一年吐多少現金」，不是「錨點之後的流量」。
    var heldCodes = {};
    positions.forEach(x => { if (_num(x['股數']) > 0) heldCodes[_str(x['代號'])] = true; });
    var ttmFrom = new Date();
    ttmFrom.setDate(ttmFrom.getDate() - 365);
    var ttmDividend = trades.reduce((a, t) => {
      if (_str(t['動作']) !== '股利') return a;
      if (!heldCodes[_str(t['代號'])]) return a;
      var d = _date(t['日期']);
      return (d && d >= ttmFrom) ? a + _num(t['金額']) : a;
    }, 0);
    var yieldNote = '近 12 個月配息 ' + Math.round(ttmDividend).toLocaleString() +
      '（僅計現有持股，已出清標的不算）';

    var pct = (n, d) => (d ? n / d : 0);

    // 有被夾住的交易就頂在最上面。指標是 key-value、靠 VLOOKUP 取值，
    // 插在最前面不會動到任何既有參照（持倉的「佔總資產%」就是這樣抓總資產的）。
    var warnRows = (replayed.warnings || []).map((w, i) => [
      '⚠️ 待修正 ' + (i + 1), '', w
    ]);

    // ⚠️ 這四格刻意是**公式**，不是重算當下的死值。
    //
    // 它們是整份資料的頭條數字：`Snapshot._totals` 拿總資產當「今天」、`DataSync`
    // 把它寫進每日快照、`持倉!R` 用 VLOOKUP 抓它算佔比、儀表板與 Mini App 都顯示它。
    // 寫成死值的話，重算那一刻只要有一檔報價沒回來，這個錯誤就會被凍住直到下次重算
    // ——2026-08-04 就是這樣讓儀表板顯示單日 −20%。
    //
    // 寫成公式之後，報價回來的下一秒它自己就對了，不需要任何人跑 rebuild。
    // 其餘各列仍是死值：它們牽涉加權平均成本這類路徑相依的計算，公式表達不出來。
    var panelRows = warnRows.concat([
      ['總資產',       '=SUM(持倉!$I$2:$I)+SUM(現金!$H$2:$H)+SUM(實體資產!$I$2:$I)',
                       '股票市值 + 現金 + 實體資產'],
      ['股票市值',     '=SUM(持倉!$I$2:$I)',      '持倉表市值合計'],
      ['現金',         '=SUM(現金!$H$2:$H)',      '各帳戶餘額換算台幣'],
      ['實體資產',     '=SUM(實體資產!$I$2:$I)',  '黃金等'],
      ['—— 投資績效 ——', '', ''],
      ['股票投入成本', _round(stockCost),     '目前仍持有部位的成本'],
      ['未實現損益',   _round(stockValue - stockCost), '市值 − 投入成本'],
      ['未實現報酬率', _round(pct(stockValue - stockCost, stockCost), 4), ''],
      ['已實現損益',   _round(totalRealized), '賣出沖銷後的實際損益'],
      ['累計股利',     _round(totalDividend), ''],
      ['淨損益',       _round(stockValue - stockCost + totalRealized + totalDividend),
                       '未實現 + 已實現 + 股利'],
      ['XIRR（年化）', xirr === null ? '' : xirr, xirrNote],
      // 分子相同、分母不同：現值＝今天用市價重買一次的配息率（比得動別的標的），
      // 成本＝當初投進去的那筆錢現在吐多少。兩者的比值恆等於 1 + 未實現報酬率。
      // 存 6 位小數（跟 XIRR 一致），不是 4 —— 殖利率本來就是 0.0x 量級，
      // 砍到 4 位等於只剩兩位有效數字，兩個指標的比值也就對不回市值÷成本了
      ['現值殖利率', stockValue > 0 ? _round(ttmDividend / stockValue, 6) : '',
        yieldNote + ' ÷ 現在市值'],
      ['成本殖利率', stockCost > 0 ? _round(ttmDividend / stockCost, 6) : '',
        yieldNote + ' ÷ 投入成本'],
      ['—— 實體資產 ——', '', ''],
      ['實體資產成本', _round(physicalCost),  ''],
      ['實體資產損益', _round(physicalValue - physicalCost), ''],
      ['—— 配置 ——', '', ''],
      ['股票佔比',     _round(pct(stockValue, totalAssets), 4), ''],
      ['現金佔比',     _round(pct(cashValue, totalAssets), 4), ''],
      ['實體佔比',     _round(pct(physicalValue, totalAssets), 4), ''],
      ['—— 更新 ——', '', ''],
      ['最後重算',     Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'), ''],
      ['交易筆數',     trades.length, ''],
      ['持倉檔數',     positions.filter(x => _num(x['股數']) > 0).length, '']
    ]);
    // ⚠️ 寫之前要把「數值」欄的**格式**也清掉，不能只清內容。
    //
    // `writeBlock` 用的是 `clearContent()` —— 數字沒了，儲存格格式還在。
    // 2026-08-09 的實況：B 欄某一格不知何時被 Sheets 判定成時間格式，之後每次
    // 重算寫進去的「實體佔比 0.0706」都顯示成 `1899-12-30 1:41:40`（0.0706 天 =
    // 1 小時 41 分 40 秒），而讀回來是 Date 物件、`AssetSchema.num()` 給 0。
    // 於是 `Facts` 每天告訴主人「實體 0.00%」，實際上是 7% 的一百萬。
    // 唯一的線索是三個佔比加起來只有 92.94%，而沒有人會去加那三個數字。
    //
    // ⚠️ 只清「指標」的 B 欄，不要整張清。`持倉` 的代號欄是刻意設成純文字的
    //    （台股代號的前導零，見 AssetSchema 的 textColumns），整張 clearFormat
    //    會把那道保護一起洗掉，換來另一個更難查的 bug。
    var metricSheet = ss.getSheetByName('指標');
    try {
      metricSheet.getRange(2, 2, Math.max(metricSheet.getMaxRows() - 1, 1), 1).clearFormat();
    } catch (e) {
      Logger.warning('Position._writePanelAndAllocation', '清指標數值欄格式失敗', e.message);
    }
    AssetSchema.writeBlock(metricSheet, panelRows, 3);

    // ── 配置：大類 / 區域 / 類型 三個維度 ──
    var held = positions.filter(x => _num(x['股數']) > 0);
    var allocRows = [];

    var pushGroup = (dim, label, cost, value, target) => {
      var actual = pct(value, totalAssets);
      allocRows.push([
        dim, label, _round(cost), _round(value), _round(actual, 4),
        target === null ? '' : _round(target, 4),
        target === null ? '' : _round(actual - target, 4),
        target === null ? '' : _round((actual - target) * totalAssets)
      ]);
    };

    pushGroup('大類', '股票', stockCost, stockValue, null);
    pushGroup('大類', '現金', cashValue, cashValue, null);
    pushGroup('大類', '實體', physicalCost, physicalValue, null);

    [['區域', '區域'], ['類型', '類型']].forEach(([dim, key]) => {
      var groups = {};
      held.forEach(x => {
        var g = _str(x[key]) || '未分類';
        if (!groups[g]) groups[g] = { cost: 0, value: 0, target: 0 };
        groups[g].cost   += _num(x['總成本']);
        groups[g].value  += _num(x['市值']);
        groups[g].target += _num(x['目標配置%']);
      });
      Object.keys(groups).sort().forEach(g => {
        pushGroup(dim, g, groups[g].cost, groups[g].value,
          groups[g].target > 0 ? groups[g].target : null);
      });
    });

    AssetSchema.writeBlock(ss.getSheetByName('配置'), allocRows, 8);

    return { totalAssets: _round(totalAssets), xirr: xirr };
  };

  return p;
})();

// ─── GAS 編輯器進入點 ─────────────────────────────────────────────
