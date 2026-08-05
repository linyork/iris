/**
 * AssetTools
 * @description 「資產管理」新表的用例層 —— Iris 的工具會呼叫這裡
 *
 * 讀寫兩面都在新表了：寫入走這裡，讀取走 Snapshot（getHoldings / getDashboard / …）。
 *
 * 設計上刻意讓「說一句話」對應「append 一列」：
 *   「今天賣掉 3000 股 0056，49.5，手續費 21」→ 交易表加一列 → Position.rebuild()
 * 持倉、成本、已實現損益、現金餘額全都是那一列的推導結果，不需要另外改任何格子。
 */
var AssetTools = (() => {
  var t = {};

  // 儲存格取值走 AssetSchema.str / .num（見那裡的註解）
  var _str = (v) => AssetSchema.str(v);
  var _num = (v) => AssetSchema.num(v);
  var _money = (n) => Math.round(_num(n)).toLocaleString();
  // 外幣帳戶的餘額會有小數，四捨五入到整數會讓「校正成 X」的回報看起來沒對上
  var _amt = (n) => (Math.round(_num(n) * 100) / 100).toLocaleString();

  /**
   * 各動作的必填欄位。
   * 期初與調整都不開放（見 AssetSchema.ACTIONS）：期初是遷移建倉用的，
   * 調整的差額只能由 setCashBalance 算，不能由呼叫端自己填。
   */
  var REQUIRED = {
    '買進': ['symbol', 'shares', 'price'],
    '賣出': ['symbol', 'shares', 'price'],
    '股利': ['symbol', 'amount'],
    '存入': ['amount'],
    '提出': ['amount'],
    '費用': ['amount'],
    '利息': ['amount'],
    '轉出': ['amount', 'account'],
    '轉入': ['amount', 'account']
  };

  /** 口語同義詞 → 正式動作 */
  var ALIAS = {
    '買': '買進', '買入': '買進', '加碼': '買進', '申購': '買進',
    '賣': '賣出', '賣掉': '賣出', '出清': '賣出', '減碼': '賣出',
    '配息': '股利', '除息': '股利', '股息': '股利',
    '存': '存入', '匯入': '存入', '入金': '存入',
    '提': '提出', '提領': '提出', '出金': '提出',
    '手續費': '費用', '支出': '費用'
  };

  var _normalizeDate = (v, tz) => {
    if (!v) return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    var s = _str(v);
    var m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (!m) return '';
    var pad = (x) => (x.length === 1 ? '0' + x : x);
    return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  };

  /**
   * 記一筆交易到「交易」表，然後重算持倉。
   *
   * @param {object} a
   * @param {string} a.action  買進/賣出/股利/存入/提出/費用/利息/轉出/轉入
   * @param {string} [a.symbol] 代號（買賣與股利必填）
   * @param {number} [a.shares] 股數
   * @param {number} [a.price]  單價
   * @param {number} [a.fee]    手續費
   * @param {number} [a.tax]    交易稅
   * @param {number} [a.amount] 金額（股利與現金類動作用）
   * @param {string} [a.account] 帳戶名稱
   * @param {string} [a.date]   日期，預設今天
   * @param {string} [a.note]   備註
   * @returns {string} 給 LLM 轉述用的結果文字
   */
  t.recordTrade = (a) => {
    a = a || {};
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();

      // ── 動作 ──
      var action = _str(a.action);
      if (ALIAS[action]) action = ALIAS[action];
      if (action === '期初') {
        return '「期初」是遷移建倉專用的動作，不能用來記日常交易。' +
               '要補historical部位請改用 買進，並填上真實的買進日期。';
      }
      if (action === '調整') {
        return '「調整」不能直接記 —— 差額要由程式重讀帳戶餘額算出來。' +
               '主人講的如果是校正後的餘額（「某某戶現在是 X」），請改用 setCashBalance；' +
               '如果是實際的存提，請用 存入 / 提出。';
      }
      if (!REQUIRED[action]) {
        return '不認識的動作：「' + _str(a.action) + '」。' +
               '可用的有：' + Object.keys(REQUIRED).join('、');
      }

      // ── 必填欄位 ──
      var val = {
        symbol:  _str(a.symbol),
        shares:  _num(a.shares),
        price:   _num(a.price),
        fee:     _num(a.fee),
        tax:     _num(a.tax),
        amount:  _num(a.amount),
        account: _str(a.account)
      };
      var missing = REQUIRED[action].filter(k => (k === 'symbol' || k === 'account')
        ? !val[k] : !(val[k] > 0));
      if (missing.length) {
        var label = { symbol: '代號', shares: '股數', price: '單價', amount: '金額', account: '帳戶' };
        return action + ' 缺少必要資訊：' + missing.map(k => label[k]).join('、') + '。請先問清楚再記。';
      }

      var dateStr = _normalizeDate(a.date, tz);
      if (!dateStr) return '看不懂的日期：' + _str(a.date) + '（請用 yyyy-MM-dd）';

      // ── 標的 ──
      // 代號一律當文字處理，台股的前導零不能掉（0056 變成 56 就查不到報價了）
      var instSheet = ss.getSheetByName('標的');
      var instruments = AssetSchema.readObjects(instSheet);
      var known = instruments.map(x => _str(x['代號']));
      var autoAdded = false;

      if (val.symbol) {
        if (known.indexOf(val.symbol) < 0) {
          if (action !== '買進') {
            return '「標的」表裡沒有 ' + val.symbol + ' —— ' + action +
                   '之前它必須已經存在。目前有：' + known.join('、') +
                   '。如果這是新標的，請先記一筆買進。';
          }
          // 新買進的標的自動登記；分類留空等主人補
          instSheet.getRange(instSheet.getLastRow() + 1, 1, 1, 10).setValues([[
            val.symbol, val.symbol, 'TPE', 'TWD', 'GOOGLEFINANCE', '', '', '', '持有中',
            '由 Iris 於 ' + dateStr + ' 首次買進時自動建立，名稱與區域/類型請補上'
          ]]);
          autoAdded = true;
        }
      }

      // ── 帳戶 ──
      var accounts = AssetSchema.readObjects(ss.getSheetByName('帳戶'))
        .filter(x => _str(x['帳戶']) && _str(x['狀態']) !== '停用');
      var names = accounts.map(x => _str(x['帳戶']));

      if (val.account) {
        if (names.indexOf(val.account) < 0) {
          return '沒有這個帳戶：「' + val.account + '」。目前有：' + names.join('、');
        }
      } else if (action === '買進' || action === '賣出' || action === '股利') {
        // 只有一個證券戶時就不必每次問；多於一個就必須講清楚
        var brokers = accounts.filter(x => _str(x['類型']) === '證券').map(x => _str(x['帳戶']));
        if (brokers.length === 1) {
          val.account = brokers[0];
        } else {
          return action + ' 要記在哪個帳戶？目前有：' + names.join('、');
        }
      } else {
        return action + ' 要記在哪個帳戶？目前有：' + names.join('、');
      }

      // 幣別跟著帳戶走。餘額是 SUMIF 出來的、不看這一欄，所以寫死 TWD 不會讓
      // 餘額算錯 —— 但外幣戶的每一列都會在說謊，之後任何想按幣別分群的讀者都會踩到。
      var accRow = accounts.filter(x => _str(x['帳戶']) === val.account)[0];
      var currency = (accRow && _str(accRow['幣別'])) || 'TWD';

      // ── 寫入 ──
      // ⚠️ 一定要走 appendTrade：它會補上「現金流」公式，少了那欄這筆錢永遠
      //    不會進到任何帳戶餘額（見 AssetSchema 的註解）。
      var row = AssetSchema.appendTrade({
        '日期': dateStr,
        '動作': action,
        '代號': val.symbol,
        '股數': val.shares || '',
        '單價': val.price || '',
        '手續費': val.fee || 0,
        '交易稅': val.tax || 0,
        '金額': val.amount || '',
        '幣別': currency,
        '帳戶': val.account,
        '分類': (action === '買進' || action === '賣出' || action === '股利') ? '投資' : '其他',
        '備註': _str(a.note),
        '來源': 'iris',
        '建立時間': Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
      }, ss);

      var rebuilt = Position.rebuild();

      // ── 組回覆 ──
      var lines = [];
      lines.push('已記錄第 ' + row + ' 列：' + dateStr + ' ' + action +
        (val.symbol ? ' ' + val.symbol : '') +
        (val.shares ? ' ' + _money(val.shares) + ' 股' : '') +
        (val.price ? ' @' + val.price : '') +
        (val.amount ? ' $' + _money(val.amount) : '') +
        (val.fee ? '，手續費 ' + _money(val.fee) : '') +
        (val.tax ? '，交易稅 ' + _money(val.tax) : '') +
        ' → ' + val.account);

      if (autoAdded) {
        lines.push('▸ ' + val.symbol + ' 是新標的，已自動加進「標的」表（名稱與區域/類型待補）');
      }

      if (rebuilt && rebuilt.ok) {
        var pos = AssetSchema.readObjects(ss.getSheetByName('持倉'))
          .filter(x => _str(x['代號']) === val.symbol)[0];
        if (pos) {
          lines.push('▸ ' + val.symbol + '：' + _money(pos['股數']) + ' 股' +
            '，均價 ' + (Math.round(_num(pos['平均成本']) * 100) / 100) +
            '，累計股利 ' + _money(pos['累計股利']) +
            (_num(pos['已實現損益']) !== 0 ? '，已實現損益 ' + _money(pos['已實現損益']) : ''));
        }
        var cash = AssetSchema.readObjects(ss.getSheetByName('現金'))
          .filter(x => _str(x['帳戶']) === val.account)[0];
        if (cash) lines.push('▸ ' + val.account + ' 餘額 ' + _money(cash['餘額']) + ' ' + _str(cash['幣別']));

        if (rebuilt.warnings && rebuilt.warnings.length) {
          lines.push('⚠️ ' + rebuilt.warnings.join('；'));
        }
      } else {
        lines.push('⚠️ 交易已寫入，但重算持倉失敗：' +
          (rebuilt && rebuilt.reason ? rebuilt.reason : '未知原因') + '。數字暫時不準。');
      }

      Logger.info('AssetTools.recordTrade', '記錄交易', {
        row: row, date: dateStr, action: action, symbol: val.symbol,
        account: val.account, rebuilt: rebuilt && rebuilt.ok
      });
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.recordTrade', '記錄失敗', ex);
      return '記錄交易時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  /**
   * 把某個現金帳戶的餘額校正成指定的數字。
   *
   * 「現金」表是 `Position.rebuild()` 整段覆寫出來的（餘額 = 帳戶期初 + SUMIF 現金流），
   * 手改那一格活不過下一次重算；改「帳戶」的期初餘額則是竄改歷史起點，跟期初日期
   * 對不起來又不留痕跡。所以**絕對值只活在對話裡，帳本記的仍然是一列差額**：
   *
   *     差額 = 指定餘額 − 現在餘額 → 交易表一列「調整」→ Position.rebuild()
   *
   * ⚠️ 這個減法一定要在這裡做，不能讓 LLM 自己算好差額再去叫 recordTrade：
   *    模型手上的數字來自 `Snapshot._cash`，那是**台幣值**，這裡比的卻是「現金」
   *    表的原幣餘額 —— 外幣戶會整整差一個匯率，而且兩邊都不會報錯。
   *
   * @param {object} a
   * @param {string} a.account 帳戶名稱，需與「帳戶」表完全一致
   * @param {number} a.balance 校正後的餘額，**該帳戶的原幣**（外幣戶就填美金／日圓）
   * @param {string} [a.note]  原因，寫進備註
   * @param {string} [a.date]  日期，預設今天
   * @returns {string} 給 LLM 轉述用的結果文字
   */
  t.setCashBalance = (a) => {
    a = a || {};
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();

      // ── 帳戶 ──
      var accounts = AssetSchema.readObjects(ss.getSheetByName('帳戶'))
        .filter(x => _str(x['帳戶']) && _str(x['狀態']) !== '停用');
      var names = accounts.map(x => _str(x['帳戶']));

      var account = _str(a.account);
      if (!account) return '要校正哪一個帳戶的餘額？目前有：' + names.join('、');

      var accRow = accounts.filter(x => _str(x['帳戶']) === account)[0];
      if (!accRow) return '沒有這個帳戶：「' + account + '」。目前有：' + names.join('、');
      var currency = _str(accRow['幣別']) || 'TWD';

      // ── 目標餘額 ──
      // 0 是合法的（把一個戶頭清空），所以不能用 !a.balance 判斷有沒有給
      if (a.balance === undefined || a.balance === null || _str(a.balance) === '') {
        return account + ' 要校正成多少？請給我校正後的餘額（' + currency + '，這個帳戶的原幣，不是台幣值）。';
      }
      var target = _num(a.balance);
      if (target === 0 && !/^-?[\d.,\s]+$/.test(_str(a.balance))) {
        return '看不懂的金額：' + _str(a.balance);
      }

      var dateStr = _normalizeDate(a.date, tz);
      if (!dateStr) return '看不懂的日期：' + _str(a.date) + '（請用 yyyy-MM-dd）';

      // ── 現在的餘額 ──
      // 讀「現金」的餘額欄（原幣），不是台幣值那一欄
      var cashSheet = ss.getSheetByName('現金');
      var cashRow = cashSheet ? AssetSchema.readObjects(cashSheet)
        .filter(x => _str(x['帳戶']) === account)[0] : null;
      if (!cashRow) {
        return '「現金」表裡還沒有 ' + account + ' 這一列 —— 請先重算一次（/refresh）再試。';
      }
      var current = _num(cashRow['餘額']);
      var delta = Math.round((target - current) * 100) / 100;
      if (delta === 0) {
        return account + ' 現在就是 ' + _amt(current) + ' ' + currency + '，不用校正。';
      }

      // ── 寫入 ──
      var reason = _str(a.note);
      var row = AssetSchema.appendTrade({
        '日期': dateStr,
        '動作': '調整',
        '金額': delta,
        '幣別': currency,
        '帳戶': account,
        '分類': '校正',
        '備註': '餘額校正：' + _amt(current) + ' → ' + _amt(target) +
                (reason ? '（' + reason + '）' : ''),
        '來源': 'iris',
        '建立時間': Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
      }, ss);

      var rebuilt = Position.rebuild();

      // ── 組回覆 ──
      var lines = [];
      lines.push('已記錄第 ' + row + ' 列：' + dateStr + ' 調整 ' + account + ' ' +
        (delta > 0 ? '+' : '') + _amt(delta) + ' ' + currency +
        '（' + _amt(current) + ' → ' + _amt(target) + '）' +
        (reason ? '，原因：' + reason : ''));

      if (rebuilt && rebuilt.ok) {
        var after = AssetSchema.readObjects(ss.getSheetByName('現金'))
          .filter(x => _str(x['帳戶']) === account)[0];
        if (after) {
          lines.push('▸ ' + account + ' 餘額 ' + _amt(after['餘額']) + ' ' + _str(after['幣別']));
        }
        if (rebuilt.warnings && rebuilt.warnings.length) {
          lines.push('⚠️ ' + rebuilt.warnings.join('；'));
        }
      } else {
        lines.push('⚠️ 校正已寫入，但重算持倉失敗：' +
          (rebuilt && rebuilt.reason ? rebuilt.reason : '未知原因') + '。數字暫時不準。');
      }

      Logger.info('AssetTools.setCashBalance', '校正餘額', {
        row: row, account: account, from: current, to: target,
        delta: delta, currency: currency, rebuilt: rebuilt && rebuilt.ok
      });
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.setCashBalance', '校正失敗', ex);
      return '校正餘額時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  return t;
})();
