/**
 * GoogleSheet
 * @description Google Sheets 資料存取層
 *
 * 預期試算表結構：
 *   env              — B2: DEBUG_MODE (true/false)、B3: AI_PROVIDER
 *   consolelog       — [timestamp, level, tag, message, details]
 *   chat             — [userId, role, message, timestamp]
 *
 * ⚠️ 本檔直接讀寫的只有上面那幾張系統分頁。資產類的讀取
 *    （getHoldings / getDashboard / getHistory / getDividendHistory）是格式化層：
 *    資料一律向 Snapshot 與 AssetSchema 拿，不自己讀資產分頁。
 */
var GoogleSheet = (() => {
  var gs = {};

  var _ssCache = null;
  var getSheet = () => {
    if (_ssCache) return _ssCache;
    _ssCache = SpreadsheetApp.openById(Config.SHEET_ID);
    return _ssCache;
  };

  // ─── Logging ───────────────────────────────────────────────────

  gs.setLog = (level, tag, message, details) => {
    try {
      var sheet = getSheet().getSheetByName('consolelog');
      if (!sheet) return;
      var timestamp = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
      sheet.appendRow([timestamp, level, tag, String(message), String(details || '')]);
    } catch (e) { /* 靜默失敗 */ }
  };

  // ─── Chat History ──────────────────────────────────────────────

  /**
   * 取得指定使用者的對話歷史（最新 N 筆）
   * @returns {Array<{userId, role, message, timestamp}>}
   */
  gs.getChatHistory = (userId, limit) => {
    try {
      var sheet = getSheet().getSheetByName('chat');
      if (!sheet) return [];
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      var data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
      var rows = data.filter(r => r[0] === userId);
      return rows.slice(-limit).map(r => ({
        userId:    r[0],
        role:      r[1],
        message:   r[2],
        timestamp: r[3]
      }));
    } catch (ex) {
      Logger.error('GoogleSheet.getChatHistory', '讀取對話歷史失敗', ex);
      return [];
    }
  };

  /**
   * 儲存一筆對話訊息
   * @param {string} userId
   * @param {string} role   - 'user' | 'assistant'
   * @param {string} message
   */
  gs.saveChatMessage = (userId, role, message) => {
    try {
      var sheet = getSheet().getSheetByName('chat');
      if (!sheet) return;
      var timestamp = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
      sheet.appendRow([userId, role, message, timestamp]);
    } catch (ex) {
      Logger.error('GoogleSheet.saveChatMessage', '儲存訊息失敗', ex);
    }
  };

  // ─── Dividend ─────────────────────────────────────────────────

  /**
   * 讀取股利歷史紀錄
   * @param {number} [year] - 指定年份（可選，預設全部）
   * @returns {string} 格式化統計文字
   */
  gs.getDividendHistory = (year) => {
    try {
      var ss = Snapshot._open();
      var rows = AssetSchema.readTrades(ss)
        .filter(r => String(r['動作'] || '').trim() === '股利')
        .map(r => ({
          date: r['日期'] instanceof Date ? r['日期'] : new Date(String(r['日期'])),
          code: String(r['代號'] || '').trim(),
          amount: Number(String(r['金額']).replace(/[,$]/g, '')) || 0
        }))
        .filter(r => r.date && !isNaN(r.date.getTime()) && r.amount > 0);

      if (rows.length === 0) return '（尚無股利紀錄）';
      if (year) rows = rows.filter(r => r.date.getFullYear() === Number(year));
      if (rows.length === 0) return '（' + year + ' 年沒有股利紀錄）';

      var byYear = {}, byCode = {};
      rows.forEach(r => {
        var y = r.date.getFullYear();
        byYear[y] = (byYear[y] || 0) + r.amount;
        byCode[r.code] = (byCode[r.code] || 0) + r.amount;
      });

      var out = [];
      var total = rows.reduce((s, r) => s + r.amount, 0);
      out.push('股利合計 ' + Math.round(total).toLocaleString() + '（' + rows.length + ' 筆）');

      out.push('【依年度】');
      Object.keys(byYear).sort().forEach(y => {
        out.push('  ' + y + ': ' + Math.round(byYear[y]).toLocaleString());
      });

      out.push('【依標的】');
      Object.keys(byCode)
        .sort((a, b) => byCode[b] - byCode[a])
        .forEach(c => out.push('  ' + c + ': ' + Math.round(byCode[c]).toLocaleString()));

      out.push('【最近 5 筆】');
      rows.sort((a, b) => a.date - b.date).slice(-5).reverse().forEach(r => {
        out.push('  ' + Utilities.formatDate(r.date, 'GMT+8', 'yyyy-MM-dd') +
          ' ' + r.code + ' ' + Math.round(r.amount).toLocaleString());
      });

      return out.join('\n');
    } catch (ex) {
      Logger.error('GoogleSheet.getDividendHistory', '讀取股利紀錄失敗', ex);
      return '讀取股利紀錄時發生錯誤：' + ex.message;
    }
  };


  // ─── Portfolio Tools ──────────────────────────────────────────

  /**
   * 持倉明細（給 LLM 讀的文字）。走 Snapshot._holdings，不自己讀表。
   *
   * ⚠️ 開頭必須有【資料時點】。這裡的數字時效各不相同：股數與成本凍結於上次重算、
   *    市價是試算表活公式、當日漲跌來自 TWSE 延遲報價，其中有些價可能是備援補的死值。
   *    不標明的話模型只能當成同一時刻的快照來讀。
   *    時點來自 _metrics().lastRebuild 與 .warnings，不是新算的。
   */
  gs.getHoldings = () => {
    try {
      var ss = Snapshot._open();
      var rows = Snapshot._holdings(ss);
      if (!rows || rows.length === 0) return '（尚無持倉資料）';

      var metrics = Snapshot._metrics(ss) || {};

      var fmt = (n) => (n === null || n === undefined) ? '—' : Math.round(n).toLocaleString();
      var pct = (n) => (n === null || n === undefined) ? '—' : (n * 100).toFixed(2) + '%';

      var totalValue = rows.reduce((s, r) => s + (r.marketValue || 0), 0);
      var totalCost  = rows.reduce((s, r) => s + (r.costBasis || 0), 0);
      var totalDiv   = rows.reduce((s, r) => s + (r.totalDividendReceived || 0), 0);

      var lines = rows.map(r => {
        var parts = [
          '股數: ' + fmt(r.shares),
          '市價: ' + r.price,
          '市值: ' + fmt(r.marketValue),
          '成本: ' + fmt(r.costBasis),
          '損益: ' + fmt(r.pnl) + '（' + pct(r.pnlPct) + '）',
          '累計股利: ' + fmt(r.totalDividendReceived),
          // ⚠️ 分母要寫出來。這個比例是「佔股票市值」，不是「佔總資產」——
          //    只寫「佔比」的話，模型會拿它跟事實區塊裡的「股票／現金／實體佔總資產」
          //    放在一起講，兩個不同分母的百分比並排，讀的人無從察覺。
          //    2026-08-09 實測：009826 被講成「32.22%」，那是佔股票市值，
          //    佔總資產其實是 20.6%。
          '佔股票市值: ' + pct(r.ratioOfPortfolio)
        ];
        // 「今天漲跌」只有在真的拿得到當日成交價時才講。取不到就明講取不到 ——
        // 舊版會印「今日: 0.00%」，那個 0 是昨收減昨收算出來的，模型無從分辨
        // 它是「今天平盤」還是「沒有資料」，於是每到盤後就會告訴主人全部平盤。
        if (r.dayChangePct !== null && r.dayChangePct !== undefined) {
          parts.push('今日: ' + pct(r.dayChangePct));
        } else if (r.isClosed) {
          parts.push('今日: 取不到當日成交價（非交易時段或該檔今日無成交），不是平盤');
        }
        if (r.realizedPnl) parts.push('已實現損益: ' + fmt(r.realizedPnl));
        if (r.priceMissing) parts.push('⚠️ 市價抓不到，市值不可信');
        return r.code + ' ' + r.name + '\n  ' + parts.join(' | ');
      });

      lines.push('【合計】\n  市值: ' + fmt(totalValue) +
        ' | 成本: ' + fmt(totalCost) +
        ' | 未實現損益: ' + fmt(totalValue - totalCost) +
        '（' + (totalCost > 0 ? pct((totalValue - totalCost) / totalCost) : '—') + '）' +
        ' | 累計股利: ' + fmt(totalDiv));

      // 時點放最前面，讓模型在讀到任何數字之前就知道它們各是什麼時候的
      var asOf = ['【資料時點】'];
      asOf.push('  股數／成本／累計股利：上一次重算' +
        (metrics.lastRebuild ? '（' + metrics.lastRebuild + '）' : '（時間不詳）'));
      asOf.push('  市價／市值：試算表的 GOOGLEFINANCE 公式，更新時機不固定，不保證是此刻的價');
      asOf.push('  當日漲跌：TWSE 即時報價，延遲約 20 分鐘；非交易時段取不到，會標明');
      if (metrics.warnings && metrics.warnings.length) {
        // 備援補價、懸空的賣出都寫在這裡。`getDashboard` 印得出來，以前這支印不出來，
        // 於是「這個價是補的死值」這件事只有問總覽的人看得到。
        asOf.push('  ⚠️ 待修正：' + metrics.warnings.join('；'));
      }

      return asOf.join('\n') + '\n\n' + lines.join('\n\n');
    } catch (ex) {
      Logger.error('GoogleSheet.getHoldings', '讀取持倉失敗', ex);
      return '讀取持倉時發生錯誤：' + ex.message;
    }
  };

  /**
   * 總覽儀表板：指標（直式 key-value）＋ 各帳戶現金 ＋ 配置三個維度
   */
  gs.getDashboard = () => {
    try {
      var ss = Snapshot._open();
      var out = [];

      var panel = AssetSchema.readObjects(ss.getSheetByName('指標'));
      if (panel.length) {
        out.push('【資產總覽】');
        panel.forEach(r => {
          var k = String(r['指標'] || '').trim();
          if (!k) return;
          // 指標表用「—— 標題 ——」當分隔列，值是空的
          if (/^——/.test(k)) { out.push(k); return; }
          var v = r['數值'];
          if (v === '' || v === null || v === undefined) return;
          var note = String(r['說明'] || '').trim();
          out.push('  ' + k + ': ' + v + (note ? '（' + note + '）' : ''));
        });
      }

      var cash = Snapshot._cash(ss);
      if (cash) {
        out.push('【各帳戶現金（已換算台幣）】');
        cash.accounts.forEach(a => out.push('  ' + a.account + ': ' + a.amount.toLocaleString()));
        out.push('  合計: ' + cash.total.toLocaleString());
      }

      var alloc = AssetSchema.readObjects(ss.getSheetByName('配置'));
      if (alloc.length) {
        out.push('【資產配置】');
        alloc.forEach(r => {
          var pairs = Object.keys(r)
            .filter(k => r[k] !== '' && r[k] !== null && r[k] !== undefined)
            .map(k => k + ': ' + r[k])
            .join(' | ');
          if (pairs) out.push('  ' + pairs);
        });
      }

      return out.join('\n') || '（無資料）';
    } catch (ex) {
      Logger.error('GoogleSheet.getDashboard', '讀取儀表板失敗', ex);
      return '讀取儀表板時發生錯誤：' + ex.message;
    }
  };

  /**
   * 最近 N 天的總資產走勢（每日快照的合計列）
   *
   * 舊版把每一檔的當日股價都塞進回覆，動輒上百行；這裡只給總資產與股票市值，
   * 單一標的的歷史價格不是 LLM 回答「最近漲跌」需要的東西。
   */
  gs.getHistory = (days) => {
    try {
      days = Math.min(days || 30, 365);
      var ss = Snapshot._open();
      var series = Snapshot.totalSeries(days, ss);
      if (!series.length) return '（尚無歷史紀錄）';

      var first = series[0], last = series[series.length - 1];
      var head = '最近 ' + series.length + ' 筆總資產紀錄（' +
        first.date + ' → ' + last.date + '）：';

      // ⚠️ `status` 只在**不是正常交易日**時才有值（休市／資料未更新／報價異常）。
      //    以前這裡只印日期與金額，把它丟掉了 —— 於是一段平掉的曲線，模型無從分辨
      //    是放假、是抓價失敗、還是真的沒有變動，只能猜，而猜出來的講得跟事實一樣。
      //    這與「拿不到當日成交價卻回 0%」是同一種病：資訊在下層算好了，排版時掉了。
      var body = series.map(r =>
        r.date + ': ' + Math.round(r.total).toLocaleString() + (r.status ? '（' + r.status + '）' : ''));
      if (body.length > 40) {
        body = body.slice(0, 10).concat(['... 中間省略 ' + (body.length - 20) + ' 筆 ...'])
                   .concat(body.slice(-10));
      }

      var change = last.total - first.total;
      var pct = first.total > 0 ? (change / first.total * 100).toFixed(2) + '%' : '—';
      var out = head + '\n' + body.join('\n') +
        '\n區間變化: ' + Math.round(change).toLocaleString() + '（' + pct + '）';

      // 中間被省略的那段也可能有異常日，所以統計要算**整個序列**，不能只看印出來的行
      var abnormal = {};
      series.forEach(r => { if (r.status) abnormal[r.status] = (abnormal[r.status] || 0) + 1; });
      var kinds = Object.keys(abnormal);
      if (kinds.length) {
        out += '\n⚠️ 其中 ' + kinds.map(k => abnormal[k] + ' 天' + k).join('、') +
          '。「資料未更新」與「報價異常」那幾天的數字不可信，' +
          '計算波動或漲跌統計前要先排除，不要當成「那天沒有變動」。';
      }
      // 端點本身就是異常日的話，區間變化是拿一個不可信的數字當基準算出來的
      if (first.status || last.status) {
        out += '\n⚠️ 區間' + (first.status ? '起點（' + first.date + '：' + first.status + '）' : '') +
          (first.status && last.status ? '與' : '') +
          (last.status ? '終點（' + last.date + '：' + last.status + '）' : '') +
          '不是正常交易日，上面的「區間變化」以此為基準，請一併說明。';
      }
      return out;
    } catch (ex) {
      Logger.error('GoogleSheet.getHistory', '讀取歷史紀錄失敗', ex);
      return '讀取歷史紀錄時發生錯誤：' + ex.message;
    }
  };


  return gs;
})();
