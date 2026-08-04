/**
 * Position
 * @description 從「交易」重算持倉、已實現損益、現金、配置、指標
 *
 * 這是整套帳的計算核心。跑法：把交易依日期重放一次，維護每檔的
 * （股數, 總成本）狀態，賣出時按**加權平均**沖銷 —— 與台灣券商對帳單一致。
 *
 *     賣出 n 股：沖銷成本 = n × (總成本 / 股數)
 *                已實現損益 = 賣出淨額 − 沖銷成本
 *                剩餘總成本 = 總成本 − 沖銷成本
 *
 * 為什麼不用試算表公式：加權平均是**路徑相依**的 —— 第 3 筆賣出的均價取決於
 * 前 2 筆買賣的順序。SUMIF 那類彙總函式表達不出來，硬做要靠陣列公式遞迴，
 * 難讀又難除錯。逐筆重放只有幾十行，而且順便把已實現損益一起算出來。
 *
 * ⚠️ 這支會**整段覆寫**「持倉」「已實現損益」「現金」「配置」「指標」，
 *    最後再請 `Panel.render()` 重畫「面板」。那幾張表不要手改。
 */
var Position = (() => {
  var p = {};

  var _num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = String(v).trim();
    if (s.charAt(0) === '#' || /^loading/i.test(s)) return 0;
    var n = parseFloat(s.replace(/[,$%]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  var _str = (v) => String(v === null || v === undefined ? '' : v).trim();

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

  /**
   * 市價公式。GOOGLEFINANCE 抓不到時（額度用完、標的剛掛牌、Google 那邊短暫沒資料）
   * 退到 TWSE 官方的 STOCK_DAY_AVG 端點硬解析收盤價。只在 TPE 市場退這一步 ——
   * 這支端點只認得上市代號，非 TPE 標的退了也是白retry。
   *
   * ⚠️ REGEXEXTRACT 抓的是**這個月第一筆**符合的日期列。STOCK_DAY_AVG 回傳的是整月
   *    資料、由舊到新排序，第一筆是月初、不是最新收盤 —— 這是抄現成公式時要注意的地方，
   *    沒驗證過真的抓到今天的價格，用之前先自己對一次盤中報價。
   * ⚠️ 外層一定要包一個 IFERROR(...,"") 收尾：這欄空字串是 $I 判斷「有沒有報到價」的
   *    依據（=IF(OR($C=0,$H=""),0,$C*$H)），沒收尾的話，TWSE 那段一旦解析失敗就會是
   *    #N/A / #VALUE! 錯誤值，不等於 ""，會讓 $I 連帶壞掉，一路串到 SUM($I$2:$I)、
   *    面板總資產全部變成錯誤。
   */
  var _priceFormula = (market, r) => {
    var gf = 'GOOGLEFINANCE("' + market + ':"&$A' + r + ',"price")';
    if (market !== 'TPE') return '=IFERROR(' + gf + ',"")';
    var twse =
      'IFERROR(VALUE(REGEXEXTRACT(CONCATENATE(IMPORTDATA(' +
      '"https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_AVG?date="&TEXT(TODAY(),"yyyyMMdd")&"&stockNo="&$A' + r + ')),' +
      '"\\d{3}/\\d{2}/\\d{2}\\""([0-9.]+)")),"")';
    return '=IFERROR(' + gf + ',' + twse + ')';
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

    var trades      = AssetSchema.readObjects(ss.getSheetByName('交易'));
    var instruments = AssetSchema.readObjects(ss.getSheetByName('標的'));
    var accounts    = AssetSchema.readObjects(ss.getSheetByName('帳戶'));

    var replayed = p.replay(trades);

    // ── 持倉 ──────────────────────────────────────────────────
    // A~G 由程式算；H 之後放公式，讓市價/市值跟著 GOOGLEFINANCE 即時變動。
    var instByCode = {};
    instruments.forEach(i => { instByCode[_str(i['代號'])] = i; });

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
        _num(ins['目標配置%']),
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

    var summary = p._writePanelAndAllocation(ss, trades, replayed);

    // 面板純粹是公式排版，只有「畫幾列」會變 —— 擺在最後重畫，
    // 這樣持倉多一檔或出清一檔，版面就跟著對上。
    Panel.render(ss);

    var result = {
      ok: true,
      positions: posRows.length,
      realized: realRows.length,
      cashAccounts: cashRows.length,
      trades: trades.length,
      totalAssets: summary.totalAssets,
      xirr: summary.xirr
    };
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

    // ── XIRR：只看投資相關現金流，最後補一筆「今天全部變現」 ──
    //
    // ⚠️ 遷移進來的歷史股利要排除。期初建倉的日期是遷移日，若把遷移日「之前」
    //    的股利算進去，就會出現一堆沒有對應投入的正現金流，XIRR 會噴出天文數字。
    //    也就是說 XIRR 是「從遷移日起算」的年化報酬，不是你真實持有全期的。
    //    等哪天回補了券商歷史成交明細，這個數字才會變成真的。
    var flows = [];
    trades.forEach(t => {
      var action = _str(t['動作']);
      var d = _date(t['日期']);
      if (!d) return;
      var migrated = _str(t['來源']) === 'migration';
      if (action === '買進' || action === '期初') {
        flows.push({ date: d, amount: -(_num(t['股數']) * _num(t['單價']) + _num(t['手續費'])) });
      } else if (action === '賣出') {
        flows.push({ date: d, amount: _num(t['股數']) * _num(t['單價']) - _num(t['手續費']) - _num(t['交易稅']) });
      } else if (action === '股利' && !migrated) {
        flows.push({ date: d, amount: _num(t['金額']) });
      }
    });
    flows.sort((a, b) => a.date - b.date);
    if (flows.length) flows.push({ date: new Date(), amount: stockValue });
    var xirr = p.xirr(flows);

    var pct = (n, d) => (d ? n / d : 0);

    // 有被夾住的交易就頂在最上面。指標是 key-value、靠 VLOOKUP 取值，
    // 插在最前面不會動到任何既有參照（持倉的「佔總資產%」就是這樣抓總資產的）。
    var warnRows = (replayed.warnings || []).map((w, i) => [
      '⚠️ 待修正 ' + (i + 1), '', w
    ]);

    var panelRows = warnRows.concat([
      ['總資產',       _round(totalAssets),   '股票市值 + 現金 + 實體資產'],
      ['股票市值',     _round(stockValue),    '持倉表市值合計'],
      ['現金',         _round(cashValue),     '各帳戶餘額換算台幣'],
      ['實體資產',     _round(physicalValue), '黃金等'],
      ['—— 投資績效 ——', '', ''],
      ['股票投入成本', _round(stockCost),     '目前仍持有部位的成本'],
      ['未實現損益',   _round(stockValue - stockCost), '市值 − 投入成本'],
      ['未實現報酬率', _round(pct(stockValue - stockCost, stockCost), 4), ''],
      ['已實現損益',   _round(totalRealized), '賣出沖銷後的實際損益'],
      ['累計股利',     _round(totalDividend), ''],
      ['淨損益',       _round(stockValue - stockCost + totalRealized + totalDividend),
                       '未實現 + 已實現 + 股利'],
      ['XIRR（年化）', xirr === null ? '' : xirr,
        xirr === null
          ? '現金流時間跨度不足（或全部同號），等有跨期交易後才算得出來'
          : '含時間加權的年化報酬率，自期初建倉日起算'],
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
    AssetSchema.writeBlock(ss.getSheetByName('指標'), panelRows, 3);

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
