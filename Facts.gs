/**
 * Facts
 * @description 由程式算好、直接注入 prompt 的關鍵數字
 *
 * 為什麼要有這個：LLM 在散文裡做算術是已知的高風險行為。它會把兩個數字加起來、
 * 把損益除以成本算報酬率、把外幣乘一個它以為的匯率 —— 而且算錯的時候語氣跟算對時
 * 一模一樣。這個區塊把那些數字先算好放進去，模型只要照抄，就沒有算錯的機會。
 *
 * 順便省一輪：問「我總資產多少」原本要跑一次 ReAct（呼叫工具 → 回灌 → 再生成），
 * 那是十幾到數十秒。數字已經在 prompt 裡的話，模型第一輪就能回答。
 *
 * ⚠️ **刻意只收「不用打外部 API」的數字。** 逐檔持倉不在這裡 —— `Snapshot._holdings`
 * 會打 TWSE 取即時漲跌，那是每一則訊息都要付的成本，連「謝謝」都要付。逐檔資料留給
 * `getHoldings` 工具，需要的時候才拿。這裡讀的三張表（指標／現金／每日快照）都是純讀表。
 *
 * ⚠️ 這個區塊與 `Prompt.SYSTEM_PROMPT` 的「資產數字一律重新呼叫工具取得」**不衝突**，
 * 但那條規則必須寫清楚差別：禁止的是引用**對話歷史裡的舊數字**，而這裡的數字是
 * 這一輪現算的。兩者混為一談的話，模型會為了守規則而放著眼前正確的數字不用。
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
        if (totals.dayChange !== null && totals.dayChange !== undefined) {
          lines.push('　較前一筆快照：' + money(totals.dayChange) + '（' + pct(totals.dayChangePct) + '）');
        }
        if (totals.weekChangePct !== null && totals.weekChangePct !== undefined) {
          lines.push('　近一週：' + pct(totals.weekChangePct) + '　近一月：' + pct(totals.monthChangePct));
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
        lines.push('現值殖利率：' + pct(m.currentYield) + '　成本殖利率：' + pct(m.costYield));
        lines.push('佔比 —— 股票 ' + pct(m.stockRatio) +
          '／現金 ' + pct(m.cashRatio) + '／實體 ' + pct(m.physicalRatio));

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
