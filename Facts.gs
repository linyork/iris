/**
 * Facts
 * @description 由程式算好、直接注入 prompt 的關鍵數字
 *
 * 把關鍵數字先算好放進 prompt，模型只要照抄。兩個目的：
 *   1. LLM 在散文裡做算術會錯，而且錯的時候語氣跟對的時候一樣。
 *   2. 省一輪 ReAct——「我總資產多少」不必再呼叫工具。
 *
 * ⚠️ 只收不用打外部 API 的數字。逐檔持倉不在這裡（Snapshot._holdings 會打 TWSE，
 *    而這個區塊每一則訊息都要組一次，連「謝謝」都要付）。逐檔資料留給 getHoldings。
 * ⚠️ 與 SYSTEM_PROMPT 的「資產數字一律重新取得」不衝突：那條禁止的是引用
 *    對話歷史裡的舊數字，這裡的數字是本輪現算的。提示詞必須寫清楚差別，
 *    否則模型會為了守規則而放著眼前正確的數字不用。
 */
var Facts = (() => {
  var facts = {};

  var _num = (v) => AssetSchema.num(v);

  var money = (n) => (n === null || n === undefined) ? '—' : Math.round(n).toLocaleString();
  var pct   = (n) => (n === null || n === undefined) ? '—' : (n * 100).toFixed(2) + '%';

  /**
   * 組出注入用的事實區塊
   * @param {object} [ss] 已開啟的試算表（省一次 open）
   * @returns {string} 區塊文字；任何一步失敗都回空字串，不讓它擋住回覆
   */
  facts.build = (ss) => {
    try {
      ss = ss || Snapshot._open();

      var m      = Snapshot._metrics(ss);
      var cash   = Snapshot._cash(ss);
      var totals = Snapshot._totals(ss);
      if (!m && !cash && !totals) return '';

      var lines = ['[系統計算的事實]'];
      lines.push('以下數字由程式從試算表算出，**必須原樣引用**：不要自己加總、不要自己算' +
        '百分比、不要換算幣別。需要這裡沒有的數字（例如逐檔持倉）再呼叫工具。');

      if (m && m.lastRebuild) lines.push('資料時點：' + m.lastRebuild + '（上一次重算）');

      if (totals) {
        lines.push('總資產：' + money(totals.today) + '（' + totals.todayDate + '）');
        // ⚠️ 三個變動都要把**基準日期**寫出來。快照一天寫一次，而 18:00 那班被砍掉、
        //    或整天抓不到價，那天就沒有列 —— 「近一週」實際上可能是近兩週。
        //    Snapshot 現在按日期找基準，但差幾天仍然只有它知道；不印出來的話，
        //    模型只能照著「近一週」講，而那句話有時候是錯的。
        var since = (d) => d ? '（基準 ' + d + '）' : '';
        if (totals.dayChange !== null && totals.dayChange !== undefined) {
          lines.push('　較前一筆快照' + since(totals.yesterdayDate) + '：' +
            money(totals.dayChange) + '（' + pct(totals.dayChangePct) + '）');
        }
        if (totals.weekChangePct !== null && totals.weekChangePct !== undefined) {
          lines.push('　近一週' + since(totals.weekBaseDate) + '：' + pct(totals.weekChangePct));
        }
        if (totals.monthChangePct !== null && totals.monthChangePct !== undefined) {
          lines.push('　近一月' + since(totals.monthBaseDate) + '：' + pct(totals.monthChangePct));
        }
      }

      if (cash) lines.push('現金合計（已換算台幣）：' + money(cash.total) +
        '，共 ' + cash.accounts.length + ' 個帳戶');

      if (m) {
        var kv = [
          ['股票投入成本', money(m.stockCost)],
          ['未實現損益',   money(m.unrealized) + '（' + pct(m.unrealizedPct) + '）'],
          ['已實現損益',   money(m.realized)],
          ['累計股利',     money(m.dividendTotal)],
          ['淨損益',       money(m.netPnl)]
        ];
        kv.forEach(p => lines.push(p[0] + '：' + p[1]));

        // XIRR 算不出來的時候，**原因**比空值重要 —— 說明欄是 Position 寫的，
        // 前端曾經各自猜成「現金流跨度不足」，而三個原因裡那只佔一個。
        lines.push('XIRR（年化）：' + (m.xirr === null ? '尚無法計算' : pct(m.xirr)) +
          (m.xirrNote ? '（' + m.xirrNote + '）' : ''));
        // ⚠️ 這兩個殖利率是**全部持股合計**，不是任何單一類別。
        //    2026-08-09 實測：模型把 2.56% 拿去跟主人「息型 ETF 殖利率跌破 3.5%」
        //    那條規矩並排，兩個不同母體的數字放在一起，看起來就像可以比。
        //    分母寫在數字旁邊，比事後叫它小心有效。
        lines.push('現值殖利率：' + pct(m.currentYield) + '　成本殖利率：' + pct(m.costYield) +
          '（全部持股合計；沒有分類別的殖利率，不要拿它跟單一類別的門檻比）');
        lines.push('佔總資產 —— 股票 ' + pct(m.stockRatio) +
          '／現金 ' + pct(m.cashRatio) + '／實體 ' + pct(m.physicalRatio) +
          '（逐檔的佔比在 getHoldings，那個分母是股票市值，兩者不可混用）');

        if (m.warnings && m.warnings.length) {
          lines.push('⚠️ 待修正：' + m.warnings.join('；') +
            '　→ 有這一行時，回覆要主動說明相關數字可能不準。');
        }
      }

      return lines.join('\n');
    } catch (ex) {
      // 事實區塊只是加分，拿不到就算了 —— 絕不能讓它擋住整則回覆
      Logger.warning('Facts.build', '組事實區塊失敗（已略過）', ex && ex.message ? ex.message : String(ex));
      return '';
    }
  };

  return facts;
})();
