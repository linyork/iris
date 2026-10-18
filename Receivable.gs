/**
 * Receivable
 * @description 應收款：借給別人、預期會收回的錢。讀餘額、記借出／收回
 *
 * 「應收款」分頁是流水帳，一筆事件一列：借出 +、收回 −、調整照填的正負號。餘額計入總資產 ——
 * 指標的「應收款」是 SUMIF 公式（metricFormula），主人手打一列就馬上算進去，不必等重算。
 *
 * ⚠️ 借出與收回是**兩張表一起動**：錢離開／回到現金帳戶記在「交易」（提出／存入），債權記在
 *    這裡。只寫一邊的話，總資產會憑空多一筆或少一筆。所以 record() 拿 script lock、先驗完再寫，
 *    第二邊寫失敗就把第一邊撤掉。
 * ⚠️ 手打進表的列（期初補登、調整）不動現金：手打就代表現金那一邊由主人自己處理。
 *    2026-10-18 期初補登時才發現，那兩筆借出在表上的現金裡從來沒扣過 —— 所以另外用
 *    setCashBalance 補扣了一筆調整。不要以為「應收款有了，現金一定已經扣過」。
 *    期初的金額也不寫進程式 —— 程式碼會進 GitHub（見 CLAUDE.md「No real figures in git」）。
 * ⚠️ 不從記帳 App 的 Loans / LoanRecords 同步：App 不算餘額（amount 永遠是 0），舊的一筆貸款
 *    還把每期還款記成「借入」。應收款以這張表為準。
 */
var Receivable = (() => {
  var r = {};

  var _str = (v) => AssetSchema.str(v);
  var _num = (v) => AssetSchema.num(v);
  var _money = (n) => (n < 0 ? '−' : '') + Math.round(Math.abs(n)).toLocaleString('en-US');
  var _round2 = (n) => Math.round(n * 100) / 100;

  r.ACTIONS = ['借出', '收回', '調整'];
  /** 2026-10-18 那次回補寫進每日快照的狀態；undoBackfill 靠它找出要拿掉的列 */
  r.BACKFILLED = '補登應收';

  /** 一列對餘額的影響。跟 metricFormula 的 SUMIF 同一套規則：借出加、收回減、調整照填的號 */
  var SIGN = { '借出': 1, '收回': -1, '調整': 1 };

  /** 口語 → 正式動作（record 只收借出／收回；調整請手改表） */
  var ALIAS = { '借': '借出', '借給': '借出', '借錢': '借出', '還': '收回', '還款': '收回', '還錢': '收回' };

  // ─── 讀 ──────────────────────────────────────────────────────

  /**
   * 「應收款」的每一列 → {date: yyyy-MM-dd, who, action, delta}。
   * 動作不認得的列不算（SUMIF 公式也不算它們），列號放進 skipped。
   * 對方空白歸到「（未填對方）」，而不是丟掉：總數要跟指標的公式對得上。
   */
  r.readRows = (ss) => {
    ss = ss || AssetSchema.open();
    var out = { rows: [], skipped: [] };
    var sh = ss.getSheetByName('應收款');
    if (!sh || sh.getLastRow() < 2) return out;
    var tz = ss.getSpreadsheetTimeZone();
    var map = AssetSchema.headerMap(sh);
    var get = (row, h) => map[h] === undefined ? '' : row[map[h]];
    sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 1)).getValues().forEach((row, i) => {
      if (!row.some(v => v !== '' && v !== null && v !== undefined)) return;
      var action = _str(get(row, '動作'));
      if (!SIGN[action]) { out.skipped.push(i + 2); return; }
      var d = get(row, '日期');
      out.rows.push({
        date: d === '' || d === null || d === undefined ? '' : AssetTools.normalizeDate(d, tz),
        who: _str(get(row, '對方')) || '（未填對方）',
        action: action,
        delta: SIGN[action] * _num(get(row, '金額'))
      });
    });
    return out;
  };

  /**
   * 每個對方的餘額。還清的（餘額 0）也列出來：問「還剩多少」時要答得出 0。
   * @returns {Array<{對方: string, 餘額: number, 最後異動日: string}>} 依餘額由大到小
   */
  r.getReceivables = (ss) => {
    var by = {};
    r.readRows(ss).rows.forEach(x => {
      var o = by[x.who] = by[x.who] || { '對方': x.who, '餘額': 0, '最後異動日': '' };
      o['餘額'] += x.delta;
      if (x.date > o['最後異動日']) o['最後異動日'] = x.date;
    });
    return Object.keys(by).map(k => { by[k]['餘額'] = _round2(by[k]['餘額']); return by[k]; })
      .sort((a, b) => b['餘額'] - a['餘額']);
  };

  /** 應收款合計 */
  r.total = (ss) => _round2(r.getReceivables(ss).reduce((a, x) => a + x['餘額'], 0));

  /**
   * 指標「應收款」的公式。欄位字母讀實際的標題列：主人刪欄、挪欄，SUMIF 也跟著走，
   * 不會靜默加總到隔壁欄（同「指標」其他加總的做法）。
   */
  r.metricFormula = (ss) => {
    var sh = ss.getSheetByName('應收款');
    var A = AssetSchema.liveCol(sh, '動作'), V = AssetSchema.liveCol(sh, '金額');
    var sumif = (act) => 'SUMIF(應收款!$' + A + '$2:$' + A + ',"' + act + '",應收款!$' + V + '$2:$' + V + ')';
    return sumif('借出') + '-' + sumif('收回') + '+' + sumif('調整');
  };

  /** 給儀表板與 Mini App：{total, items: [{name, balance, lastDate}]}，餘額 0 的不列 */
  r.summary = (ss) => {
    var list = r.getReceivables(ss).filter(x => x['餘額'] !== 0);
    return {
      total: _round2(list.reduce((a, x) => a + x['餘額'], 0)),
      items: list.map(x => ({ name: x['對方'], balance: x['餘額'], lastDate: x['最後異動日'] }))
    };
  };

  /** getReceivables 工具的回覆 */
  r.describe = (counterparty) => {
    try {
      var who = _str(counterparty);
      var list = r.getReceivables();
      if (who) list = list.filter(x => x['對方'] === who);
      if (!list.length) {
        return who ? '「應收款」裡沒有「' + who + '」。' : '（目前沒有應收款）';
      }
      var lines = ['【應收款】'];
      list.forEach(x => lines.push('▸ ' + x['對方'] + '：餘額 ' + _money(x['餘額']) +
        (x['最後異動日'] ? '（最後異動 ' + x['最後異動日'] + '）' : '')));
      if (!who) lines.push('合計 ' + _money(list.reduce((a, x) => a + x['餘額'], 0)) + '，已計入總資產');
      return lines.join('\n');
    } catch (ex) {
      Logger.error('Receivable.describe', '讀取應收款失敗', ex);
      return '讀取應收款時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  // ─── 寫 ──────────────────────────────────────────────────────

  /**
   * 借出或收回：「應收款」一列 + 「交易」一列（借出＝從帳戶提出、收回＝存入帳戶），
   * 同一把鎖裡寫完。總資產因此不變 —— 現金和應收款一增一減。
   *
   * @param {object} a
   * @param {string} a.action        借出 / 收回
   * @param {string} a.counterparty  對方，例如「弟弟」
   * @param {number} a.amount        金額（正數）
   * @param {string} a.account       錢從哪個帳戶出、回到哪個帳戶（台幣戶）
   * @param {string} [a.date]        yyyy-MM-dd，預設今天
   * @param {string} [a.note]
   * @returns {string} 給 LLM 轉述的結果
   */
  r.record = (a) => {
    a = a || {};
    var lock = null;
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();

      var action = _str(a.action);
      if (ALIAS[action]) action = ALIAS[action];
      if (action !== '借出' && action !== '收回') {
        return '動作只能是「借出」或「收回」。要調整餘額，請直接在「應收款」表加一列「調整」。';
      }
      var who = _str(a.counterparty);
      var amt = _num(a.amount);
      var account = _str(a.account);
      if (!who) return '這筆要記在誰身上？請先問清楚對方是誰。';
      if (!(amt > 0)) return '金額要是正數。';

      var accounts = AssetSchema.readObjects(ss.getSheetByName('帳戶'))
        .filter(x => _str(x['帳戶']) && _str(x['狀態']) !== '停用');
      var names = accounts.map(x => _str(x['帳戶']));
      if (!account) return '錢是從哪個帳戶出、或回到哪個帳戶？目前有：' + names.join('、');
      var acc = accounts.filter(x => _str(x['帳戶']) === account)[0];
      if (!acc) return '沒有這個帳戶：「' + account + '」。目前有：' + names.join('、');
      // 應收款的金額是台幣；記到外幣戶的話，交易那一列會被當成美金、日圓入帳
      var ccy = _str(acc['幣別']).toUpperCase();
      if (ccy && ccy !== 'TWD') {
        return '應收款以台幣記，「' + account + '」是 ' + ccy + ' 帳戶。請改用台幣帳戶。';
      }

      var dateStr = AssetTools.normalizeDate(a.date, tz);
      if (!dateStr) return '看不懂的日期：' + _str(a.date) + '（請用 yyyy-MM-dd）';

      lock = LockService.getScriptLock();
      if (!lock.tryLock(30 * 1000)) {
        lock = null;
        return '另一個寫入還在處理中，等一下再試一次。';
      }
      var sheet = AssetSchema.ensureTab(ss, '應收款').sheet;

      // 收回超過對方的餘額 → 不寫。多半是金額聽錯，或還有一筆借出沒記
      if (action === '收回') {
        var hit = r.getReceivables(ss).filter(x => x['對方'] === who)[0];
        var bal = hit ? hit['餘額'] : 0;
        if (amt > bal + 0.005) {
          return bal > 0
            ? '這筆收回擋下來了：' + who + ' 目前的應收餘額是 ' + _money(bal) + '，比 ' + _money(amt) +
              ' 少。請確認金額，或是不是還有一筆借出沒記。什麼都沒寫。'
            : '這筆收回擋下來了：「' + who + '」目前沒有應收款，什麼都沒寫。' +
              '（目前有應收款的：' + (r.getReceivables(ss).filter(x => x['餘額'] > 0)
                .map(x => x['對方']).join('、') || '沒有') + '）';
        }
      }

      var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
      var note = _str(a.note);

      // ① 應收款
      var map = AssetSchema.headerMap(sheet);
      var header = map.__header;
      var rRow = sheet.getLastRow() + 1;
      if (sheet.getMaxRows() < rRow) sheet.insertRowsAfter(sheet.getMaxRows(), rRow - sheet.getMaxRows());
      var rec = { '日期': dateStr, '對方': who, '動作': action, '金額': amt, '帳戶': account,
                  '備註': note, '來源': 'iris', '建立時間': stamp };
      sheet.getRange(rRow, 1, 1, header.length).setValues([header.map(h => rec[h] !== undefined ? rec[h] : '')]);
      Utils.noteLedgerWrite('應收款 第 ' + rRow + ' 列 ' + action);

      // ② 交易。寫不進去就把 ① 撤掉
      var tRow;
      try {
        tRow = AssetSchema.appendTrade({
          '日期': dateStr,
          '動作': action === '借出' ? '提出' : '存入',
          '金額': amt,
          '帳戶': account,
          '備註': '應收款' + action + '－' + who + (note ? '：' + note : ''),
          '來源': 'iris',
          '建立時間': stamp
        }, ss);
      } catch (ex) {
        sheet.getRange(rRow, 1, 1, header.length).clearContent();
        Logger.error('Receivable.record', '交易寫入失敗，已撤回應收款第 ' + rRow + ' 列', ex);
        throw ex;
      }
      SpreadsheetApp.flush();
      lock.releaseLock();
      lock = null;

      var rebuilt = Position.rebuild();
      var after = r.getReceivables(ss).filter(x => x['對方'] === who)[0];
      var lines = ['已記錄：' + dateStr + ' ' + action + ' ' + who + ' ' + _money(amt) +
        (action === '借出' ? '，從 ' + account + ' 提出' : '，存入 ' + account) +
        '（應收款第 ' + rRow + ' 列、交易第 ' + tRow + ' 列）'];
      lines.push('▸ ' + who + ' 的應收餘額 ' + _money(after ? after['餘額'] : 0));
      if (rebuilt && rebuilt.ok) {
        var cash = AssetSchema.readObjects(ss.getSheetByName('現金')).filter(x => _str(x['帳戶']) === account)[0];
        if (cash) lines.push('▸ ' + account + ' 餘額 ' + _money(_num(cash['餘額'])));
        lines.push('▸ 總資產不變：現金與應收款一增一減');
        if (rebuilt.warnings && rebuilt.warnings.length) lines.push('⚠️ ' + rebuilt.warnings.join('；'));
      } else {
        lines.push('⚠️ 兩邊都寫進去了，但重算失敗：' + ((rebuilt && rebuilt.reason) || '未知原因') +
          '。現金餘額暫時不準。');
      }
      Logger.info('Receivable.record', '記錄應收款', {
        action: action, who: who, account: account, receivableRow: rRow, tradeRow: tRow
      });
      return lines.join('\n');
    } catch (ex) {
      Logger.error('Receivable.record', '記錄應收款失敗', ex);
      return '記錄應收款時發生錯誤，什麼都沒寫進去：' + (ex && ex.message ? ex.message : String(ex));
    } finally {
      if (lock) lock.releaseLock();
    }
  };

  // ─── 撤回回補（一次性）──────────────────────────────────────
  //
  // 2026-10-18 跑過一次「把應收款回補進每日快照」：規格書說借出那兩天現金已經扣了、走勢有假的
  // 下跌，所以從第一筆借出起每天的總資產加上應收餘額。實際上兩個前提都不成立 —— 表上的一銀
  // 現金戶從來沒扣過這兩筆（銀行裡早就只剩零頭），歷史在那兩天也沒有任何下跌。那筆錢在歷史裡
  // 一直以「現金」的身分算在總資產裡，總額本來就對；回補等於同一筆錢算兩次，走勢上多出兩個
  // 假的上升。現金改在當天用 setCashBalance 補扣，歷史則用這支撤回。
  //
  // ⚠️ 教訓：回補歷史之前，先去資料裡看那個「斷崖」到底在不在。

  /**
   * 拿掉每日快照裡狀態＝補登應收的列，那幾天的 合計／總資產 減回這些列的市值合計 ——
   * 回補的精確反操作，不讀備份，所以之後 18:00 寫進來的列不受影響。
   * 冪等：沒有補登應收的列就什麼都不做。
   *
   * @returns {{ok: boolean, reason?: string, days?: number, rows?: number}}
   */
  r.undoBackfill = () => {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30 * 1000)) return { ok: false, reason: '另一個寫入還在處理中，等一下再試。' };
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();
      var snap = ss.getSheetByName('每日快照');
      if (!snap || snap.getLastRow() < 2) return { ok: false, reason: '「每日快照」是空的。' };
      var map = AssetSchema.headerMap(snap);
      var missing = ['日期', '類型', '鍵', '市值', '狀態'].filter(h => map[h] === undefined);
      if (missing.length) return { ok: false, reason: '「每日快照」少了欄位：' + missing.join('、') };
      var header = map.__header;
      var data = snap.getRange(2, 1, snap.getLastRow() - 1, Math.max(snap.getLastColumn(), 1)).getValues();
      var dayOf = (row) => _str(row[map['日期']]) ? AssetTools.normalizeDate(row[map['日期']], tz) : '';
      var isFilled = (row) => _str(row[map['類型']]) === '應收' && _str(row[map['狀態']]) === r.BACKFILLED;

      var extra = {};
      var removed = 0;
      data.forEach(row => {
        if (!isFilled(row)) return;
        var d = dayOf(row);
        extra[d] = _round2((extra[d] || 0) + _num(row[map['市值']]));
        removed++;
      });
      if (!removed) return { ok: true, days: 0, rows: 0 };

      var out = [];
      data.forEach(row => {
        if (isFilled(row)) return;
        var o = {};
        header.forEach((h, j) => { if (h) o[h] = row[j]; });
        var d = dayOf(row);
        if (extra[d] && _str(row[map['類型']]) === '合計' && _str(row[map['鍵']]) === '總資產') {
          o['市值'] = _round2(_num(o['市值']) - extra[d]);
        }
        out.push(o);
      });
      AssetSchema.writeBlockByName(snap, () => out);
      SpreadsheetApp.flush();
      if (typeof Dashboard !== 'undefined') Dashboard.invalidate();
      var result = { ok: true, days: Object.keys(extra).length, rows: removed };
      Logger.info('Receivable.undoBackfill', '撤回應收款回補', result);
      return result;
    } catch (ex) {
      Logger.error('Receivable.undoBackfill', '撤回失敗', ex);
      return { ok: false, reason: ex && ex.message ? ex.message : String(ex) };
    } finally {
      lock.releaseLock();
    }
  };

  return r;
})();
