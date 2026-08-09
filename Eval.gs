/**
 * Eval
 * @description 固定題組 + 可自動判定的性質，讓「改 prompt」不再憑感覺
 *
 * 拆成兩半，這是整個設計的重點：
 *
 *   判定（`Eval.CHECKS`）—— 純函式，吃「回覆文字 + 這一輪的脈絡」回 {ok, why}。
 *                          不打 LLM、不讀試算表，所以測得起來（見 T37）。
 *   執行（`Eval.runBatch`）—— 真的跑一次 `ChatBot.reply`，那才需要 LLM。
 *
 * ⚠️ **判定的是性質，不是字串。** 期望值不可以寫「應該回答 142萬」——那種題目
 *    第二天就過期，而且逼著人去對答案而不是對行為。要問的是「有沒有講時點」
 *    「數字是不是都來自工具或事實區塊」「是非題有沒有先答是否」。
 *
 * ⚠️ **一次只跑幾題。** GAS 單次執行 6 分鐘，而一題可能要跑完整個 ReAct 迴圈。
 *    `runBatch` 每次挑「還沒跑過或最舊」的幾題，把結果寫回去，下次接著跑 ——
 *    所以它可以重複執行直到整組跑完，不需要一次撐完。
 */
var Eval = (() => {
  var ev = {};

  var SHEET_NAME = 'eval_set';
  var HEADERS = ['編號', '問題', '期望性質', '最後執行', '回覆', '判定', '未通過'];

  // ─── 可自動判定的性質 ────────────────────────────────────────

  /** 從文字裡抓出所有數字，正規化成純數值字串（去掉千分位） */
  var _numbersIn = (s) => {
    var out = [];
    (String(s || '').match(/-?[\d][\d,]*(\.\d+)?/g) || []).forEach(raw => {
      var n = Number(String(raw).replace(/,/g, ''));
      if (!isNaN(n)) out.push({ raw: raw, n: n });
    });
    return out;
  };

  /**
   * 回覆裡的數字，是不是都能在脈絡（事實區塊 + 工具回傳）裡找到？
   *
   * 這是最有價值也最容易誤判的一條，所以放寬的地方要講清楚：
   * - 「142萬」是人設**要求**的寫法，所以 n 與 n×10000 都算命中
   * - 4 位數以下不檢查：年份、百分比、股數、列號、日期都落在這裡，
   *   而它們多半是轉述而不是編造。真正會出事的是金額級距的數字。
   * - 小數點後的位數不比對（四捨五入是允許的），只比整數部分
   */
  var _numbersGrounded = (reply, ctx) => {
    var hay = String(ctx && ctx.context || '');
    var haystackNums = _numbersIn(hay).map(x => Math.round(x.n));
    var bad = [];
    _numbersIn(reply).forEach(x => {
      if (Math.abs(x.n) < 10000) return;
      var v = Math.round(x.n);
      if (haystackNums.indexOf(v) >= 0) return;
      if (haystackNums.indexOf(v * 10000) >= 0) return;   // 「142萬」
      if (haystackNums.indexOf(Math.round(v / 10000)) >= 0) return;
      bad.push(x.raw);
    });
    return bad.length
      ? { ok: false, why: '這些數字在事實區塊與工具回傳裡都找不到：' + bad.join('、') }
      : { ok: true, why: '' };
  };

  ev.CHECKS = {
    /** 不可以有 Markdown —— LINE / Telegram 不渲染，會變成字面星號 */
    noMarkdown: (reply) => {
      var hits = [];
      if (/\*\*[^*\n]+\*\*/.test(reply)) hits.push('粗體');
      if (/^#{1,6}\s/m.test(reply))      hits.push('標題');
      if (/^\s*\|.*\|/m.test(reply))     hits.push('表格');
      if (/^\s*---+\s*$/m.test(reply))   hits.push('分隔線');
      return hits.length ? { ok: false, why: '出現 Markdown：' + hits.join('、') }
                         : { ok: true, why: '' };
    },

    /**
     * 是非題要先答是或否，不要把一個「對」寫成三段。
     *
     * ⚠️ 「先講結論：不算太高」要算通過 —— 答案就在第一行，只是前面有個標籤。
     *    2026-08-09 的基準線上這條誤殺了 Q03：模型做對了，判定說它沒做。
     *    **判定函式誤殺比漏殺更糟**：漏殺只是少發現一個問題，誤殺會讓人去「修」
     *    一個本來就對的行為。
     */
    yesNoFirst: (reply) => {
      var head = (String(reply).split('\n').filter(l => l.trim())[0] || '').trim();
      // 剝掉「先講結論：」「結論：」「▸ 」這類前綴再看
      var body = head.replace(/^[▸◆\-*\s]*(先講)?結論[：:]\s*/, '').replace(/^\*+/, '');
      return /^(是|否|對|不|有|沒有|可以|不行|會|不會|還好|算是)/.test(body)
        ? { ok: true, why: '' }
        : { ok: false, why: '第一行沒有先給是／否：' + head.slice(0, 30) };
    },

    /** 報數字要講時點 */
    hasAsOf: (reply) => {
      return /\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|重算|時點|收盤|非交易時段|快照/.test(reply)
        ? { ok: true, why: '' }
        : { ok: false, why: '報了數字卻沒有任何時點說明' };
    },

    /** 唯讀問題不准說「已記錄」 */
    noWriteClaim: (reply) => {
      return Utils.claimsWriteDone(reply)
        ? { ok: false, why: '唯讀問題卻宣稱寫入了' }
        : { ok: true, why: '' };
    },

    /** 簡單查詢不要長篇大論 */
    concise: (reply) => {
      var lines = String(reply).split('\n').filter(l => l.trim()).length;
      return lines <= 12 ? { ok: true, why: '' }
                         : { ok: false, why: '太長了：' + lines + ' 行' };
    },

    /** 數字要有出處 */
    numbersGrounded: _numbersGrounded,

    /**
     * 該引用主人立的規矩時要引用。
     *
     * ⚠️ 主人與 Iris 之間「你／您」混用，而且引用的講法很多種：
     *    「您的長期配置原則」「你原本就有預留」「照你訂的紀律」「你設定的策略」。
     *    2026-08-09 的基準線上這條誤殺了 Q03 與 Q05 —— 兩則都確實引用了偏好，
     *    只是沒用我當初想到的那三種寫法。**規則寫得太窄，等於在考模型會不會照樣造句。**
     */
    citesStanding: (reply) => {
      var s = String(reply);
      var hit = /\[(決策|目標|偏好)\]/.test(s) ||
        /(你|您)(自己)?(設|訂|說|定)(過|的|了)/.test(s) ||
        /(你|您)的.{0,6}(原則|策略|紀律|目標|計畫|配置|偏好)/.test(s) ||
        /(你|您)原本(就)?(有|預留|打算)/.test(s) ||
        /照(你|您)(自己)?(的|訂)/.test(s) ||
        /上次(我|你|您)/.test(s);
      return hit ? { ok: true, why: '' }
                 : { ok: false, why: '沒有引用主人設過的決策／目標' };
    }
  };

  /** 預設題組。改 prompt 之後跑這組看逐題差異。 */
  ev.DEFAULT_SET = [
    ['Q01', '我總資產多少？',                 'noMarkdown,hasAsOf,numbersGrounded,concise,noWriteClaim'],
    ['Q02', '現在可以加碼嗎？',               'noMarkdown,yesNoFirst,noWriteClaim'],
    ['Q03', '我的現金比例是不是太高了？',      'noMarkdown,yesNoFirst,citesStanding,noWriteClaim'],
    ['Q04', '幫我看一下持倉狀況',             'noMarkdown,hasAsOf,numbersGrounded,noWriteClaim'],
    ['Q05', '最近虧很多，我是不是該停損？',    'noMarkdown,citesStanding,noWriteClaim'],
    ['Q06', '我上個月買了什麼？',             'noMarkdown,noWriteClaim'],
    ['Q07', '謝謝',                          'noMarkdown,concise,noWriteClaim'],
    ['Q08', '我有哪些帳戶？',                 'noMarkdown,noWriteClaim'],
    ['Q09', '今年股利收多少？',               'noMarkdown,numbersGrounded,noWriteClaim'],
    ['Q10', '我的資產這週表現如何？',          'noMarkdown,hasAsOf,numbersGrounded,noWriteClaim']
  ];

  // ─── 判定一則回覆 ────────────────────────────────────────────

  /**
   * @param {string} reply    ChatBot 的回覆
   * @param {string} expects  逗號分隔的性質名稱
   * @param {object} [ctx]    {context: '事實區塊與工具回傳的合併文字'}
   * @returns {{pass: boolean, failed: Array<string>, detail: string}}
   */
  ev.judge = (reply, expects, ctx) => {
    var names = String(expects || '').split(',').map(s => s.trim()).filter(s => s);
    var failed = [], detail = [];
    names.forEach(name => {
      var fn = ev.CHECKS[name];
      if (!fn) { failed.push(name + '(未知性質)'); return; }
      var r = fn(String(reply || ''), ctx || {});
      if (!r.ok) { failed.push(name); detail.push(name + '：' + r.why); }
    });
    return { pass: failed.length === 0, failed: failed, detail: detail.join('\n') };
  };

  // ─── 執行 ────────────────────────────────────────────────────

  var _sheet = (create) => {
    var ss = SpreadsheetApp.openById(Config.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (sheet || !create) return sheet;
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    ev.DEFAULT_SET.forEach(r => sheet.appendRow([r[0], r[1], r[2], '', '', '', '']));
    Logger.info('Eval._sheet', '建立 eval_set 並寫入預設題組', ev.DEFAULT_SET.length + ' 題');
    return sheet;
  };

  /**
   * 跑一批題目（沒跑過的優先，其次最舊的）
   *
   * ⚠️ 預設只跑 3 題。一題可能跑完整個 ReAct 迴圈，GAS 只有 6 分鐘 ——
   *    重複執行直到整組都有新的「最後執行」時間即可。
   *
   * @param {number} [limit] 這次跑幾題，預設 3
   * @returns {Array<object>} 這次跑過的題目結果
   */
  ev.runBatch = (limit) => {
    limit = limit || 3;
    var sheet = _sheet(true);
    if (!sheet) return [];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    var rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    var order = rows.map((r, i) => ({ r: r, at: i + 2, ran: String(r[3] || '') }))
      .filter(x => x.r[1])
      .sort((a, b) => (a.ran || '').localeCompare(b.ran || ''))
      .slice(0, limit);

    var out = [];
    order.forEach(item => {
      // 每一題都留餘裕：跑不完寧可少跑幾題，也不要被 GAS 砍在半路而什麼都沒寫回去
      if (Utils.execTimeLeftMs() < 90000) {
        Logger.warning('Eval.runBatch', '時間不足，這批提前結束', '剩餘=' + Utils.execTimeLeftMs());
        return;
      }

      var question = String(item.r[1]);
      var expects  = String(item.r[2]);
      var reply = '', ctx = '';
      try {
        var probe = ev._ask(question, String(item.r[0] || item.at));
        reply = probe.reply;
        ctx   = probe.context;
      } catch (exq) {
        reply = '（執行失敗）' + (exq && exq.message ? exq.message : String(exq));
      }

      var verdict = ev.judge(reply, expects, { context: ctx });
      sheet.getRange(item.at, 4, 1, 4).setValues([[
        Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss'),
        reply.slice(0, 2000),
        verdict.pass ? 'PASS' : 'FAIL',
        verdict.detail.slice(0, 500)
      ]]);
      out.push({ id: item.r[0], pass: verdict.pass, failed: verdict.failed });
    });

    Logger.info('Eval.runBatch', '評估批次完成', out);
    return out;
  };

  /**
   * 問一題，回覆與這一輪的脈絡都拿回來。
   *
   * 脈絡是 `numbersGrounded` 要用的：要判斷「這個數字有沒有出處」，就得知道
   * 這一輪到底給了模型哪些數字。事實區塊自己組一次即可（它是純讀取）。
   */
  ev._ask = (question, id) => {
    // ⚠️ 脈絡必須包含**這一輪工具回傳的內容**，否則 numbersGrounded 會把「忠實轉述
    //    工具給的數字」誤判成「憑空捏造」。2026-08-09 的基準線上它誤殺了三題
    //    （Q04 的股數 300,000、Q09 的股利 165,622、Q10 的逐日總資產）——
    //    那些數字全部來自 getHoldings / getDividendHistory / getHistory，全是對的。
    //
    //    所以在這裡暫時包住 Tools.execute 把回傳收集起來。包在 Eval 裡而不是改
    //    ChatBot：正式路徑不需要為了被評估而多背一個參數。
    var toolOutput = [];
    var realExecute = Tools.execute;
    Tools.execute = function (name, args) {
      var r = realExecute(name, args);
      try { toolOutput.push(String(r && r.text !== undefined ? r.text : r)); } catch (e) { /* 收集失敗不影響評估 */ }
      return r;
    };
    try {
      return ev._askInner(question, id, toolOutput);
    } finally {
      Tools.execute = realExecute;   // 一定要還原，否則之後每一則對話都掛著這層包裝
    }
  };

  ev._askInner = (question, id, toolOutput) => {
    var event = {
      // ⚠️ 每一題用不同的 userId。對話歷史是按 userId 讀的，共用一個的話第 2 題
      //    會看到第 1 題的問答 —— 結果就變成跟執行順序有關，同一組題目跑兩次
      //    可能得到不同判定，那就失去當基準線的意義了。
      //
      // ⚠️ platform 刻意不是 'TELEGRAM'：那會讓 indicateTyping 真的去打 Bot API，
      //    把「正在輸入」推給主人。評估是背景作業，不該在他的對話框裡冒泡。
      platform: 'EVAL', replyToken: 'eval', sourceId: 'eval',
      source: { type: 'user', userId: 'EVAL:' + (id || 'X') },
      message: { type: 'text', text: question, id: 'eval' },
      isMaster: true
    };
    var context = Facts.build() + '\n' + GoogleSheet.knowledgeForPrompt(question);
    var reply = ChatBot.reply(event);
    // 工具回傳接在後面 —— 模型看得到的數字，判定也要看得到
    return {
      reply: String(reply || ''),
      context: context + '\n' + (toolOutput || []).join('\n')
    };
  };

  return ev;
})();
