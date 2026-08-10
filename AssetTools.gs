/**
 * AssetTools
 * @description 輸入層（標的／帳戶／交易）的用例層，供 Tools.execute 呼叫
 *
 * 寫入一律是「交易表 append 一列 + Position.rebuild()」；持倉、成本、已實現損益、
 * 現金餘額都是那一列的推導結果。
 *
 * 讀取分工：計算層（持倉／指標／現金／每日快照）走 Snapshot 與 GoogleSheet；
 * 輸入層三張表走這裡的 listInstruments / listAccounts / listTrades。
 *
 * 修改規則：交易 append-only，記錯用 voidTrade 打作廢記號；
 * 主檔只能 updateInstrument / updateAccount 改，帳戶不可刪除只能停用。
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

  /** 顯示用日期：Date 就格式化，其餘原樣吐回（看不懂也讓主人看得到原始內容） */
  var _showDate = (v, tz) => (v instanceof Date)
    ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : _str(v);

  /** 一列交易的單行摘要，列表與作廢回報共用 */
  var _tradeLine = (x, tz) => {
    var bits = [_showDate(x['日期'], tz), _str(x['動作'])];
    var code = _str(x['代號']);
    if (code) bits.push(code + (_str(x['名稱']) ? ' ' + _str(x['名稱']) : ''));
    if (_num(x['股數'])) {
      bits.push(_money(x['股數']) + ' 股' + (_num(x['單價']) ? ' @' + _num(x['單價']) : ''));
    }
    if (_num(x['金額'])) bits.push('$' + _amt(x['金額']));
    if (_num(x['手續費'])) bits.push('費 ' + _money(x['手續費']));
    if (_num(x['交易稅'])) bits.push('稅 ' + _money(x['交易稅']));
    if (_str(x['帳戶'])) bits.push('→ ' + _str(x['帳戶']));
    return bits.join(' ');
  };

  /**
   * 在某一欄裡找出值等於 value 的列，回傳 1-based 列號（找不到 0）。
   * ⚠️ 不可用 readObjects 的索引 +2 代替：它會跳過空白列，對不上實際列號。
   */
  var _findRow = (sheet, colName, value) => {
    var map = AssetSchema.headerMap(sheet);
    var out = { row: 0, map: map };
    var idx = map[colName];
    if (idx === undefined || idx < 0) return out;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return out;
    var col = sheet.getRange(2, idx + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) {
      if (_str(col[i][0]) === value) { out.row = i + 2; return out; }
    }
    return out;
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
          Utils.noteLedgerWrite('標的 自動登記 ' + val.symbol);
          autoAdded = true;
        }
      }

      // ── 賣出：檢查該日期當下的持股是否足夠 ──
      // 擋在寫入前。放行的話 Position.replay 會跳過這筆（股數不動），但「現金流」是
      // 該列自己的試算表公式、看不到持倉，結果是股票沒動而錢入帳。
      // 用 replay 重放到該日期來判斷，不自行計算：加權平均是路徑相依的，
      // 第二份實作會與真正的重放分岔。
      // ⚠️ 只在 recordTrade 擋。券商匯入不擋（見 AssetImport），
      //    匯入與手改造成的賣超由 replay 的警告收尾。
      if (action === '賣出') {
        var upto = AssetSchema.readTrades(ss).filter(x => {
          var d = _str(x['日期']) ? _normalizeDate(x['日期'], tz) : '';
          return d && d <= dateStr;
        });
        var st = Position.replay(upto).positions[val.symbol];
        var held = st ? st.shares : 0;
        if (held < val.shares) {
          return held <= 0
            ? '這筆賣出擋下來了：' + dateStr + ' 當下你手上沒有 ' + val.symbol +
              '，賣不掉 ' + _money(val.shares) + ' 股。\n' +
              '如果真的賣了，表示帳本裡少了對應的買進 —— 請先把買進補記進來，再記這一筆。' +
              '（硬記下去的話持倉不會動，但那列的現金流照樣入帳，帳戶餘額會憑空變多）'
            : '這筆賣出擋下來了：' + dateStr + ' 當下 ' + val.symbol + ' 只有 ' +
              _money(held) + ' 股，賣不掉 ' + _money(val.shares) + ' 股。\n' +
              '請先確認股數。真的賣了這麼多的話，表示帳本裡少了買進，請先補記買進再記這一筆。';
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

      // 幣別取自帳戶。餘額是 SUMIF 算的、不讀這一欄，但寫死 TWD 會讓外幣戶的
      // 每一列幣別都是錯的，之後按幣別分群的讀者會拿到錯的結果。
      var accRow = accounts.filter(x => _str(x['帳戶']) === val.account)[0];
      var currency = (accRow && _str(accRow['幣別'])) || 'TWD';

      // ⚠️ 必須走 appendTrade：它會補上「現金流」公式，缺了那欄這筆錢不會進帳戶餘額。
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

  /** 帳戶類型。只有「證券」有語意：買賣沒指定帳戶時會自動採用唯一的證券戶 */
  var ACCOUNT_TYPES = ['證券', '現金', '外幣'];

  /**
   * 開一個新帳戶（往「帳戶」主檔加一列）。唯一會寫「帳戶」主檔的新增路徑。
   *
   * ⚠️ 期初餘額＝「期初日期那天的餘額」，建完不應再動。
   *    之後的水位由交易推導，要修正用 setCashBalance。
   *
   * @param {object} a
   * @param {string} a.name          帳戶名稱，之後記交易、查餘額都用這個名字
   * @param {string} [a.type]        證券 / 現金 / 外幣，沒給就照名稱與幣別推
   * @param {string} [a.currency]    三碼幣別，預設 TWD
   * @param {string} [a.institution] 機構名稱
   * @param {number} [a.balance]     期初餘額，預設 0
   * @param {string} [a.date]        期初日期，預設今天
   * @param {string} [a.note]        備註
   * @returns {string} 給 LLM 轉述用的結果文字
   */
  t.addAccount = (a) => {
    a = a || {};
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();
      var sheet = ss.getSheetByName('帳戶');
      if (!sheet) return '找不到「帳戶」分頁，請先執行 setupAssetSheet()。';

      var name = _str(a.name);
      if (!name) {
        return '新帳戶要叫什麼名字？之後記交易、查餘額都是用這個名字比對，' +
               '取跟你平常講法一致的稱呼最好認。';
      }

      // 重名要連停用的一起比對：現金表是 SUMIF(帳戶)，兩列同名會把同一筆錢算兩次
      var exist = AssetSchema.readObjects(sheet).filter(x => _str(x['帳戶']) === name)[0];
      if (exist) {
        return '「' + name + '」已經在「帳戶」表裡了（狀態：' + (_str(exist['狀態']) || '啟用') +
               '），不用再建一次。要改它的水位請用 setCashBalance。';
      }

      var currency = _str(a.currency).toUpperCase() || 'TWD';
      if (!/^[A-Z]{3}$/.test(currency)) {
        return '看不懂的幣別：「' + _str(a.currency) + '」。請用三碼代碼，例如 TWD / USD / JPY。';
      }

      var type = _str(a.type);
      if (type && ACCOUNT_TYPES.indexOf(type) < 0) {
        return '帳戶類型只能是：' + ACCOUNT_TYPES.join('、') + '。';
      }
      // 未指定就依名稱與幣別推斷（規則同 AssetMigrate），回覆會標明是推斷的
      var inferred = !type;
      if (!type) type = /證券|券商/.test(name) ? '證券' : (currency === 'TWD' ? '現金' : '外幣');

      var dateStr = _normalizeDate(a.date, tz);
      if (!dateStr) return '看不懂的日期：' + _str(a.date) + '（請用 yyyy-MM-dd）';

      var balance = _num(a.balance);

      // 欄位以標題文字對位，不寫死欄號（「帳戶」是人工維護的表）
      var map = AssetSchema.headerMap(sheet);
      var row = new Array(map.__header.filter(h => h !== '').length).fill('');
      var put = (col, v) => { if (map[col] !== undefined && map[col] >= 0) row[map[col]] = v; };
      put('帳戶', name);
      put('類型', type);
      put('幣別', currency);
      put('機構', _str(a.institution));
      put('期初餘額', balance);
      put('期初日期', dateStr);
      put('狀態', '啟用');
      put('備註', _str(a.note) || '由 Iris 於 ' + dateStr + ' 建立');
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
      Utils.noteLedgerWrite('帳戶 新增 ' + name);

      var rebuilt = Position.rebuild();

      var lines = [];
      lines.push('已建立帳戶：' + name + '（' + type + '／' + currency + '）' +
        '，期初餘額 ' + _amt(balance) + '，期初日期 ' + dateStr);
      if (inferred) {
        lines.push('▸ 類型是照名稱與幣別推的，不對的話直接在「帳戶」分頁改');
      }
      if (rebuilt && rebuilt.ok) {
        var cash = AssetSchema.readObjects(ss.getSheetByName('現金'))
          .filter(x => _str(x['帳戶']) === name)[0];
        if (cash) {
          lines.push('▸ ' + name + ' 餘額 ' + _amt(cash['餘額']) + ' ' + _str(cash['幣別']) +
            '，已計入總資產');
        }
        if (rebuilt.warnings && rebuilt.warnings.length) {
          lines.push('⚠️ ' + rebuilt.warnings.join('；'));
        }
      } else {
        lines.push('⚠️ 帳戶已建立，但重算失敗：' +
          (rebuilt && rebuilt.reason ? rebuilt.reason : '未知原因') + '。數字暫時不準。');
      }
      lines.push('▸ 期初餘額指的是 ' + dateStr + ' 那天的餘額，之後的水位一律由交易推導 ——' +
        '要修正請用 setCashBalance，不要回頭改期初');

      Logger.info('AssetTools.addAccount', '建立帳戶', {
        name: name, type: type, currency: currency,
        balance: balance, date: dateStr, rebuilt: rebuilt && rebuilt.ok
      });
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.addAccount', '建立帳戶失敗', ex);
      return '建立帳戶時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  /**
   * 把某個現金帳戶的餘額校正成指定的數字。
   *
   * 「現金」表由 Position.rebuild() 整段覆寫（餘額 = 帳戶期初 + SUMIF 現金流），
   * 手改那一格活不過下次重算。所以絕對值會被翻譯成一列差額：
   *     差額 = 指定餘額 − 現在餘額 → 交易表一列「調整」→ Position.rebuild()
   *
   * ⚠️ 減法必須在這裡做，不可讓 LLM 算好差額再呼叫 recordTrade：
   *    模型看到的是 Snapshot._cash 的台幣值，這裡比的是原幣餘額，
   *    外幣戶會差一個匯率，且兩邊都不會報錯。
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

  /**
   * 作廢一筆記錯的交易。
   *
   * 帳本是 append-only，但 append-only 需要的是**撤銷的方法**，不是「不准動」。
   * 這裡打的是墓碑：列留著、原始數字留著，只在「狀態」寫上「作廢」，所有算數字
   * 的地方（`AssetSchema.readTrades`）跳過它，現金流公式也一併失效。
   *
   * ⚠️ **不要改用「反手記一筆相反的交易」。** 現金那邊可以（現金流一路 SUMIF，
   *    加一列負的就抵掉），股票那邊不行：記錯的買進反手記一筆賣出，加權平均重放
   *    會把它當成真的處分，憑空生出一筆已實現損益 —— 錯的沒消失，只是多了一筆假的。
   *
   * ⚠️ 「期初」不給作廢。那是遷移建倉的起點，拿掉它之後所有後續賣出都會變成
   *    「當下無持股」而整批被跳過，持倉直接歸零。
   *
   * @param {object} a
   * @param {number} a.row      「交易」表上的列號（listTrades 每一筆前面的「第 N 列」）
   * @param {string} [a.reason] 作廢原因，會寫進備註
   * @returns {string} 給 LLM 轉述用的結果文字
   */
  t.voidTrade = (a) => {
    a = a || {};
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();
      var sheet = ss.getSheetByName('交易');
      if (!sheet) return '找不到「交易」分頁，請先執行 setupAssetSheet()。';

      var map = AssetSchema.headerMap(sheet);
      if (map['狀態'] === undefined || map['狀態'] < 0) {
        return '「交易」表還沒有「狀態」欄，作廢就是靠那一欄標記的。' +
               '請先在 GAS 編輯器執行一次 setupAssetSheet() 補上欄位。';
      }

      var row = Math.round(_num(a.row));
      if (!(row >= 2)) {
        return '要作廢哪一列？請給「交易」表上的列號 —— 用 listTrades 查，' +
               '每一筆前面的「第 N 列」就是。';
      }
      var lastRow = sheet.getLastRow();
      if (row > lastRow) {
        return '「交易」表只到第 ' + lastRow + ' 列，沒有第 ' + row + ' 列。請先用 listTrades 確認。';
      }

      var values = sheet.getRange(row, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
      var rec = {};
      map.__header.forEach((h, i) => { if (h) rec[h] = values[i]; });

      if (!_str(rec['日期']) && !_str(rec['動作'])) {
        return '第 ' + row + ' 列是空的，沒有東西可以作廢。';
      }
      if (AssetSchema.isVoid(rec)) {
        return '第 ' + row + ' 列已經是作廢狀態了：' + _tradeLine(rec, tz) +
               '\n備註：' + _str(rec['備註']);
      }

      var action = _str(rec['動作']);
      if (action === '期初') {
        return '第 ' + row + ' 列是「期初」，不能作廢 —— 那是遷移建倉的起點。' +
               '拿掉它之後每一筆後續賣出都會變成「當下無持股」而被跳過，持倉會整批歸零。' +
               '期初的數字如果不對，要改的是遷移，不是這一列。';
      }

      var code    = _str(rec['代號']);
      var account = _str(rec['帳戶']);
      var summary = _tradeLine(rec, tz);
      var reason  = _str(a.reason) || '未說明';
      var stamp   = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');

      // 原本的備註留著（券商匯入的內容鍵就在裡面，去重靠它認人），作廢資訊接在後面。
      // 分隔用全形「｜」加空白：`imp:` / `stm:` 那兩個鍵的比對是 [^\s|]+，
      // 遇到空白就停，不會把作廢字串一起吃進鍵裡。
      var note = _str(rec['備註']);
      sheet.getRange(row, map['狀態'] + 1).setValue(AssetSchema.VOID);
      if (map['備註'] !== undefined && map['備註'] >= 0) {
        sheet.getRange(row, map['備註'] + 1)
          .setValue((note ? note + ' ｜ ' : '') + '作廢於 ' + stamp + '：' + reason);
      }
      // ⚠️ 一定要重寫這一列的公式：現金流的守門條件寫在公式裡，而這一列可能還
      //    帶著加「狀態」欄之前的舊版公式 —— 不重寫就會變成「列跳過了、錢還在」。
      AssetSchema.writeRowFormulas(sheet, row, map);
      Utils.noteLedgerWrite('交易 第 ' + row + ' 列 作廢');

      var rebuilt = Position.rebuild();

      var lines = [];
      lines.push('已作廢第 ' + row + ' 列：' + summary);
      lines.push('▸ 原因：' + reason + '（原始數字留在表上，沒有刪除）');

      // ⚠️ 轉帳是兩列，而且**沒有欄位把兩腿綁在一起**（見 AssetSchema.TRADE_FORMULAS
      //    的註解：不設「對方帳戶」欄，是為了讓每個帳戶的餘額只是一次 SUMIF）。
      //    只作廢一腿不會有任何東西擋下來，錢就憑空多出或少掉，而且**不像賣出那樣
      //    會被 Position.replay 警告** —— 轉帳根本不碰持倉，沒有人會發現。
      //    配對只能靠人看，所以這裡一定要講出來。
      if (action === '轉出' || action === '轉入') {
        lines.push('⚠️ 轉帳是兩列（轉出＋轉入），這裡只作廢了「' + action + '」這一腿。' +
          '另一腿還在的話，總資產會憑空' + (action === '轉出' ? '多出' : '少掉') +
          ' ' + _amt(rec['金額']) + ' —— 請用 listTrades 找出配對的那一列一起作廢。');
      }

      if (rebuilt && rebuilt.ok) {
        if (code) {
          var pos = AssetSchema.readObjects(ss.getSheetByName('持倉'))
            .filter(x => _str(x['代號']) === code)[0];
          lines.push(pos
            ? '▸ ' + code + '：' + _money(pos['股數']) + ' 股，均價 ' +
              (Math.round(_num(pos['平均成本']) * 100) / 100)
            : '▸ ' + code + ' 已無持倉紀錄');
        }
        if (account) {
          var cash = AssetSchema.readObjects(ss.getSheetByName('現金'))
            .filter(x => _str(x['帳戶']) === account)[0];
          if (cash) lines.push('▸ ' + account + ' 餘額 ' + _amt(cash['餘額']) + ' ' + _str(cash['幣別']));
        }
        if (rebuilt.warnings && rebuilt.warnings.length) {
          lines.push('⚠️ ' + rebuilt.warnings.join('；'));
        }
      } else {
        lines.push('⚠️ 已標記作廢，但重算持倉失敗：' +
          (rebuilt && rebuilt.reason ? rebuilt.reason : '未知原因') + '。數字暫時不準。');
      }

      Logger.info('AssetTools.voidTrade', '作廢交易', {
        row: row, action: action, code: code, account: account,
        reason: reason, rebuilt: rebuilt && rebuilt.ok
      });
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.voidTrade', '作廢失敗', ex);
      return '作廢交易時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  /**
   * 列出交易紀錄。
   *
   * 這是 `voidTrade` 的前置條件 —— 沒有它，模型知道記錯了也講不出要作廢哪一列。
   * 所以每一行前面都掛著實際列號，而不是流水序號。
   *
   * @param {object} [a]
   * @param {number} [a.limit]   最多幾筆（預設 15，上限 50）
   * @param {string} [a.symbol]  只看某一檔
   * @param {string} [a.account] 只看某一個帳戶
   * @param {string} [a.action]  只看某一種動作
   * @param {boolean} [a.includeVoid] 連作廢的一起列（預設不列）
   */
  t.listTrades = (a) => {
    a = a || {};
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();
      var all = AssetSchema.readTrades(ss, { includeVoid: true });
      if (!all.length) return '「交易」表還沒有任何紀錄。';

      var includeVoid = !!a.includeVoid;
      var symbol  = _str(a.symbol);
      var account = _str(a.account);
      var action  = _str(a.action);
      if (ALIAS[action]) action = ALIAS[action];

      var rows = all.filter(x => {
        if (!includeVoid && AssetSchema.isVoid(x)) return false;
        if (symbol && _str(x['代號']) !== symbol) return false;
        if (account && _str(x['帳戶']) !== account) return false;
        if (action && _str(x['動作']) !== action) return false;
        return true;
      });

      var filters = [];
      if (symbol)  filters.push('代號 ' + symbol);
      if (account) filters.push('帳戶 ' + account);
      if (action)  filters.push('動作 ' + action);
      var scope = filters.length ? '（' + filters.join('、') + '）' : '';

      if (!rows.length) return '沒有符合條件的交易' + scope + '。';

      // 表上的順序是寫入順序，不是時間順序 —— 遷移的期初列日期最早卻排在最前面，
      // 之後補記的歷史交易也會落在表尾。要「最近幾筆」就得按日期排。
      var limit = Math.min(Math.max(Math.round(_num(a.limit)) || 15, 1), 50);
      var sorted = rows
        .map(x => ({ x: x, d: _showDate(x['日期'], tz) }))
        .sort((p, q) => (p.d < q.d ? 1 : p.d > q.d ? -1 : q.x.__row - p.x.__row))
        .slice(0, limit);

      var voided = all.filter(x => AssetSchema.isVoid(x)).length;
      var lines = [];
      lines.push('交易紀錄' + scope + '：共 ' + rows.length + ' 筆，以下是最近 ' +
        sorted.length + ' 筆（新到舊）' +
        (!includeVoid && voided ? '；另有 ' + voided + ' 筆已作廢未列出' : ''));
      sorted.forEach(o => {
        lines.push('第 ' + o.x.__row + ' 列  ' + _tradeLine(o.x, tz) +
          (AssetSchema.isVoid(o.x) ? '  ⛔ 已作廢' : '') +
          (_str(o.x['備註']) ? '\n            備註：' + _str(o.x['備註']) : ''));
      });
      lines.push('（「第 N 列」就是 voidTrade 要的列號）');
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.listTrades', '列出交易失敗', ex);
      return '讀取交易紀錄時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  /**
   * 列出所有帳戶（含停用），帶上**原幣**餘額。
   *
   * ⚠️ 餘額特意同時給原幣與台幣值。`Snapshot._cash`（也就是 getDashboard）只給
   *    台幣值，而 `setCashBalance` 收的是原幣 —— 少了這個讀取面，外幣戶的餘額
   *    對模型來說根本不存在，它只能拿台幣值去猜。
   */
  t.listAccounts = () => {
    try {
      var ss = AssetSchema.open();
      var sheet = ss.getSheetByName('帳戶');
      if (!sheet) return '找不到「帳戶」分頁，請先執行 setupAssetSheet()。';

      var accounts = AssetSchema.readObjects(sheet).filter(x => _str(x['帳戶']));
      if (!accounts.length) return '「帳戶」表還沒有任何帳戶，用 addAccount 建立第一個。';

      var cash = {};
      var cashSheet = ss.getSheetByName('現金');
      if (cashSheet) {
        AssetSchema.readObjects(cashSheet).forEach(c => { cash[_str(c['帳戶'])] = c; });
      }

      var active = accounts.filter(x => _str(x['狀態']) !== '停用');
      var lines = ['帳戶（啟用 ' + active.length + ' 個' +
        (accounts.length - active.length ? '，停用 ' + (accounts.length - active.length) + ' 個' : '') + '）'];

      accounts.forEach(x => {
        var name = _str(x['帳戶']);
        var off  = _str(x['狀態']) === '停用';
        var cur  = _str(x['幣別']) || 'TWD';
        var row  = cash[name];
        var bits = [(off ? '⛔ [停用] ' : '▸ ') + name,
                    (_str(x['類型']) || '未分類') + '／' + cur];
        if (_str(x['機構'])) bits.push(_str(x['機構']));
        if (off) {
          bits.push('停用中，不計入總資產');
        } else if (row) {
          bits.push('餘額 ' + _amt(row['餘額']) + ' ' + cur +
            (cur === 'TWD' ? '' : '（台幣值 ' + _money(row['台幣值']) + '）'));
        } else {
          bits.push('⚠️ 還沒出現在「現金」表，請執行 /refresh 重算');
        }
        lines.push(bits.join(' | '));
      });

      lines.push('（餘額是**原幣** —— setCashBalance 要填的就是這個數字，不是台幣值）');
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.listAccounts', '列出帳戶失敗', ex);
      return '讀取帳戶時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  /**
   * 列出「標的」主檔。
   *
   * `getHoldings` 讀的是持倉、而且只給股數 > 0 的列 —— 已經出清、以及登記了還
   * 沒買的標的完全看不到。而區域／類型／目標配置% 只住在這張表上，配置分組就是
   * 按它們分的，空著的欄位要有人看得見才補得起來，所以缺哪一欄這裡會直接點名。
   */
  t.listInstruments = (a) => {
    a = a || {};
    try {
      var ss = AssetSchema.open();
      var sheet = ss.getSheetByName('標的');
      if (!sheet) return '找不到「標的」分頁，請先執行 setupAssetSheet()。';

      var rows = AssetSchema.readObjects(sheet).filter(x => _str(x['代號']));
      if (!rows.length) return '「標的」表還沒有任何標的 —— 記第一筆買進時會自動建立。';

      var held = {};
      var posSheet = ss.getSheetByName('持倉');
      if (posSheet) {
        AssetSchema.readObjects(posSheet).forEach(p => { held[_str(p['代號'])] = _num(p['股數']); });
      }

      var lines = ['標的（' + rows.length + ' 檔）'];
      var incomplete = [];

      rows.forEach(x => {
        var code = _str(x['代號']);
        var miss = ['區域', '類型'].filter(k => !_str(x[k]));
        if (miss.length) incomplete.push(code + '（缺 ' + miss.join('、') + '）');

        var target = _num(x['目標配置%']);
        var bits = ['▸ ' + code + (_str(x['名稱']) ? ' ' + _str(x['名稱']) : ''),
                    (_str(x['市場']) || 'TPE') + '／' + (_str(x['幣別']) || 'TWD')];
        bits.push('區域 ' + (_str(x['區域']) || '⚠️ 未填'));
        bits.push('類型 ' + (_str(x['類型']) || '⚠️ 未填'));
        // 目標配置% 是 0..1 的比例。兩種寫法都印出來，是因為主人講的是「6%」而
        // updateInstrument 收的是 0.06 —— 只印一種，換算就會發生在模型腦裡。
        bits.push('目標 ' + (_str(x['目標配置%']) === ''
          ? '未設'
          : target + '（' + Math.round(target * 1000) / 10 + '%）'));
        bits.push(held[code] > 0 ? '持有 ' + _money(held[code]) + ' 股' : '目前無持股');
        if (_str(x['狀態'])) bits.push(_str(x['狀態']));
        lines.push(bits.join(' | '));
      });

      if (incomplete.length) {
        lines.push('⚠️ 區域／類型沒填的標的不會進「配置」的分組統計：' + incomplete.join('、') +
          '。可以用 updateInstrument 補。');
      }
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.listInstruments', '列出標的失敗', ex);
      return '讀取標的時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  /** updateInstrument 收的參數 → 「標的」表的欄位 */
  var INSTRUMENT_FIELDS = {
    name: '名稱', market: '市場', currency: '幣別', quoteSource: '報價來源',
    region: '區域', category: '類型', target: '目標配置%', status: '狀態', note: '備註'
  };

  /**
   * 修改「標的」主檔的欄位。
   *
   * 主檔沒有「再記一筆」可以退：`交易!名稱` 與 `持倉!目標配置%` 都是 VLOOKUP
   * 回這張表，新建一列正確的並不會讓舊的失效。所以更新就是唯一的修正路徑。
   *
   * 這個工具存在的直接原因是 `recordTrade` 的自動建立只生得出半個標的 ——
   * 區域／類型／目標配置% 一律留空，而「配置」就是按區域與類型分組的。
   *
   * ⚠️ **代號不給改。** 它是 `交易`、`持倉`、`每日快照` 共同的比對鍵，改一張
   *    表就會讓另外兩張對不上；真的遇到代號變更，請連同歷史列一起手動處理。
   *
   * @param {object} a
   * @param {string} a.symbol 代號（必填，用來定位）
   * @param {string} [a.name] [a.market] [a.currency] [a.quoteSource] [a.region]
   *                 [a.category] [a.status] [a.note]
   * @param {number} [a.target] 目標配置%，**0..1 的比例**（6% 要填 0.06）
   */
  t.updateInstrument = (a) => {
    a = a || {};
    try {
      var ss = AssetSchema.open();
      var sheet = ss.getSheetByName('標的');
      if (!sheet) return '找不到「標的」分頁，請先執行 setupAssetSheet()。';

      var symbol = _str(a.symbol);
      if (!symbol) return '要修改哪一檔標的？請給代號（用 listInstruments 查）。';

      var found = _findRow(sheet, '代號', symbol);
      if (!found.row) {
        var known = AssetSchema.readObjects(sheet).map(x => _str(x['代號'])).filter(Boolean);
        return '「標的」表裡沒有 ' + symbol + '。目前有：' + known.join('、');
      }
      var map = found.map;

      // ── 收要改的欄位 ──
      var updates = {};
      Object.keys(INSTRUMENT_FIELDS).forEach(k => {
        if (a[k] === undefined || a[k] === null || a[k] === '') return;
        updates[INSTRUMENT_FIELDS[k]] = a[k];
      });
      if (!Object.keys(updates).length) {
        return '要改什麼？可以改的有：' + Object.keys(INSTRUMENT_FIELDS)
          .map(k => INSTRUMENT_FIELDS[k]).join('、') + '（代號不能改）。';
      }

      // ── 驗證 ──
      if (updates['目標配置%'] !== undefined) {
        var target = _num(a.target);
        // ⚠️ 這裡**不做 /100 的自動換算**。12.5 到底是 12.5% 還是有人手滑多打
        //    一位，程式分不出來，猜錯就是整整一百倍的偏離而且不會報錯。
        if (!(target >= 0) || target > 1) {
          return '目標配置% 要填 0 到 1 之間的**比例**，不是百分比 —— ' +
                 '6% 請填 0.06，收到的是 ' + _str(a.target) + '。' +
                 '（「偏離」= 佔總資產% − 目標配置%，兩邊都是比例）';
        }
        updates['目標配置%'] = target;
      }
      if (updates['幣別'] !== undefined) {
        var cur = _str(a.currency).toUpperCase();
        if (!/^[A-Z]{3}$/.test(cur)) {
          return '看不懂的幣別：「' + _str(a.currency) + '」。請用三碼代碼，例如 TWD / USD。';
        }
        updates['幣別'] = cur;
      }
      if (updates['市場'] !== undefined) updates['市場'] = _str(a.market).toUpperCase();

      // ── 寫入 ──
      var changed = [], skipped = [];
      Object.keys(updates).forEach(col => {
        var idx = map[col];
        if (idx === undefined || idx < 0) { skipped.push(col); return; }
        var cell = sheet.getRange(found.row, idx + 1);
        var before = cell.getValue();
        if (_str(before) === _str(updates[col])) return;      // 沒變就不寫
        cell.setValue(updates[col]);
        changed.push(col + '：' + (_str(before) || '(空白)') + ' → ' + _str(updates[col]));
      });

      // 沒有任何一欄真的變動就不算寫入 —— 上面那個迴圈「沒變就不寫」，
      // 這裡的提前返回也就是「這次沒動到試算表」，計數器不能動。
      if (!changed.length) {
        return symbol + ' 的這些欄位本來就是這個值，沒有改動。' +
               (skipped.length ? '（表上沒有這些欄位：' + skipped.join('、') + '）' : '');
      }
      Utils.noteLedgerWrite('標的 更新 ' + symbol + '：' + changed.length + ' 欄');

      var rebuilt = Position.rebuild();

      var lines = ['已更新標的 ' + symbol + '（第 ' + found.row + ' 列）：'];
      changed.forEach(c => lines.push('▸ ' + c));
      if (skipped.length) lines.push('⚠️ 表上沒有這些欄位，未寫入：' + skipped.join('、'));
      if (updates['市場'] !== undefined && updates['市場'] !== 'TPE') {
        lines.push('⚠️ 只有 TPE 的市價有 TWSE 備援，其他市場抓不到 GOOGLEFINANCE 就是空白');
      }
      if (rebuilt && rebuilt.ok) {
        if (updates['目標配置%'] !== undefined) {
          lines.push('▸ 「偏離」已跟著更新（持倉的目標配置% 是指回這張表的公式）');
        }
        if (rebuilt.warnings && rebuilt.warnings.length) lines.push('⚠️ ' + rebuilt.warnings.join('；'));
      } else {
        lines.push('⚠️ 已寫入，但重算失敗：' +
          (rebuilt && rebuilt.reason ? rebuilt.reason : '未知原因') + '。數字暫時不準。');
      }

      Logger.info('AssetTools.updateInstrument', '更新標的', {
        symbol: symbol, row: found.row, changed: changed, rebuilt: rebuilt && rebuilt.ok
      });
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.updateInstrument', '更新標的失敗', ex);
      return '更新標的時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  /**
   * 修改「帳戶」主檔：改名、改機構／類型、停用或重新啟用。
   *
   * ⚠️ **改名是跨兩張表的事。** `現金!交易淨流` 是 `SUMIF(交易!$L:$L, 帳戶名)`，
   *    只改主檔那一格、不改「交易」裡的每一列，那個帳戶的餘額會靜靜地掉回期初值，
   *    不會有任何錯誤。手改試算表最容易漏的就是這一步，所以它必須由程式做。
   *
   * ⚠️ **不提供刪除。** 刪掉有歷史的帳戶會讓 SUMIF 對不到任何列、餘額歸零，
   *    而交易列還指著一個不存在的名字。要「關掉」請用 status='停用'。
   *
   * @param {object} a
   * @param {string} a.name        現在的帳戶名稱（必填，用來定位）
   * @param {string} [a.newName]   改成這個名字（會一併改寫「交易」的每一列）
   * @param {string} [a.type]      證券 / 現金 / 外幣
   * @param {string} [a.currency]  三碼幣別（已經有交易的帳戶不給改，見下）
   * @param {string} [a.institution] 機構
   * @param {string} [a.status]    啟用 / 停用
   * @param {string} [a.note]      備註
   */
  t.updateAccount = (a) => {
    a = a || {};
    try {
      var ss = AssetSchema.open();
      var sheet = ss.getSheetByName('帳戶');
      if (!sheet) return '找不到「帳戶」分頁，請先執行 setupAssetSheet()。';

      var name = _str(a.name);
      if (!name) return '要修改哪一個帳戶？請給帳戶名稱（用 listAccounts 查）。';

      var all = AssetSchema.readObjects(sheet).filter(x => _str(x['帳戶']));
      var found = _findRow(sheet, '帳戶', name);
      if (!found.row) {
        return '沒有這個帳戶：「' + name + '」。目前有：' +
               all.map(x => _str(x['帳戶'])).join('、');
      }
      var map = found.map;
      var cur0 = all.filter(x => _str(x['帳戶']) === name)[0] || {};

      var updates = {}, notes = [];

      // ── 改名 ──
      var newName = _str(a.newName);
      if (newName && newName !== name) {
        // 重複要連停用的一起比：兩列同名會讓同一筆錢被 SUMIF 算兩次
        if (all.some(x => _str(x['帳戶']) === newName)) {
          return '「' + newName + '」已經是另一個帳戶的名字了，換一個。';
        }
        updates['帳戶'] = newName;
      }

      // ── 類型 ──
      if (_str(a.type)) {
        if (ACCOUNT_TYPES.indexOf(_str(a.type)) < 0) {
          return '帳戶類型只能是：' + ACCOUNT_TYPES.join('、') + '。';
        }
        updates['類型'] = _str(a.type);
      }

      // ── 幣別 ──
      // 已經有交易之後改幣別是靜默的災難：那些列的金額是用舊幣別記的，餘額
      // （SUMIF 出來的原幣加總）會變成兩種貨幣混在一起，再乘上新匯率。
      if (_str(a.currency)) {
        var cur = _str(a.currency).toUpperCase();
        if (!/^[A-Z]{3}$/.test(cur)) {
          return '看不懂的幣別：「' + _str(a.currency) + '」。請用三碼代碼，例如 TWD / USD / JPY。';
        }
        if (cur !== (_str(cur0['幣別']) || 'TWD')) {
          var used = AssetSchema.readTrades(ss)
            .filter(x => _str(x['帳戶']) === name).length;
          if (used) {
            return '「' + name + '」已經有 ' + used + ' 筆交易，不能改幣別。' +
                   '那些列的金額是用 ' + (_str(cur0['幣別']) || 'TWD') +
                   ' 記的，改了之後餘額會變成兩種幣別加在一起再乘新匯率，而且不會報錯。' +
                   '正確做法是開一個新帳戶，把餘額轉過去。';
          }
          updates['幣別'] = cur;
        }
      }

      if (_str(a.institution)) updates['機構'] = _str(a.institution);
      if (_str(a.note))        updates['備註'] = _str(a.note);

      // ── 狀態 ──
      var status = _str(a.status);
      if (status) {
        if (['啟用', '停用'].indexOf(status) < 0) return '狀態只能是「啟用」或「停用」。';
        if (status === '停用') {
          // 停用的帳戶會被 Position 從「現金」表整列濾掉 —— 裡面還有錢的話，
          // 那筆錢會直接從總資產上消失，而且沒有任何提示。
          var cashRow = ss.getSheetByName('現金')
            ? AssetSchema.readObjects(ss.getSheetByName('現金'))
                .filter(x => _str(x['帳戶']) === name)[0]
            : null;
          // 「現金」還沒有這一列時退回主檔的期初餘額，**不要當成 0** ——
          // 剛建好還沒重算過的帳戶就是這個狀態，當成 0 會讓期初的錢直接蒸發
          var bal = cashRow ? _num(cashRow['餘額']) : _num(cur0['期初餘額']);
          if (Math.abs(bal) >= 0.01) {
            return '「' + name + '」還有 ' + _amt(bal) + ' ' + (_str(cur0['幣別']) || 'TWD') +
                   '，不能直接停用 —— 停用的帳戶會從「現金」表整列消失，那筆錢會跟著' +
                   '從總資產上不見，而且不會有任何提示。請先把錢轉出（recordTrade 轉出／提出），' +
                   '或用 setCashBalance 校正成 0，再停用。';
          }
        }
        updates['狀態'] = status;
      }

      if (!Object.keys(updates).length) {
        return '要改什麼？可以改的有：名稱（newName）、類型、幣別、機構、狀態、備註。' +
               '（餘額不在這裡改 —— 那是交易推導出來的，用 setCashBalance 或 recordTrade）';
      }

      // 改名前先記下餘額。改名是跨兩張表的事，而「漏改一邊」的症狀就是餘額
      // 靜靜掉回期初 —— 那正是這個工具要防的東西，所以做完自己驗一次。
      var balBefore = null;
      if (updates['帳戶'] && ss.getSheetByName('現金')) {
        var cr = AssetSchema.readObjects(ss.getSheetByName('現金'))
          .filter(x => _str(x['帳戶']) === name)[0];
        if (cr) balBefore = _num(cr['餘額']);
      }

      // ── 寫入主檔 ──
      var changed = [];
      Object.keys(updates).forEach(col => {
        var idx = map[col];
        if (idx === undefined || idx < 0) return;
        var cell = sheet.getRange(found.row, idx + 1);
        var before = cell.getValue();
        if (_str(before) === _str(updates[col])) return;
        cell.setValue(updates[col]);
        changed.push(col + '：' + (_str(before) || '(空白)') + ' → ' + _str(updates[col]));
      });

      // ── 改名要連「交易」一起改寫 ──
      var renamed = 0;
      if (updates['帳戶']) {
        var tradeSheet = ss.getSheetByName('交易');
        var tMap = AssetSchema.headerMap(tradeSheet);
        var tIdx = tMap['帳戶'];
        var lastRow = tradeSheet.getLastRow();
        if (tIdx !== undefined && tIdx >= 0 && lastRow >= 2) {
          var range = tradeSheet.getRange(2, tIdx + 1, lastRow - 1, 1);
          var vals = range.getValues();
          vals.forEach(r => { if (_str(r[0]) === name) { r[0] = newName; renamed++; } });
          // 作廢的列也一起改：它們是歷史紀錄，名字對不上比留著更難讀
          if (renamed) range.setValues(vals);
        }
        notes.push('「交易」裡 ' + renamed + ' 列的帳戶名一起改寫了' +
          (renamed ? '' : '（本來就沒有交易掛在這個名字下）'));
        notes.push('「每日快照」的歷史列仍是舊名稱 —— 那是當時的紀錄，不動它');
      }

      // 改名只動「交易」而主檔沒變的情況也算寫入，所以兩個都要看
      if (changed.length || renamed) {
        Utils.noteLedgerWrite('帳戶 更新 ' + name +
          '：' + changed.length + ' 欄' + (renamed ? '、交易 ' + renamed + ' 列改名' : ''));
      }

      var rebuilt = Position.rebuild();

      var lines = ['已更新帳戶「' + name + '」（第 ' + found.row + ' 列）：'];
      changed.forEach(c => lines.push('▸ ' + c));
      notes.forEach(n => lines.push('▸ ' + n));

      if (rebuilt && rebuilt.ok) {
        var after = AssetSchema.readObjects(ss.getSheetByName('現金'))
          .filter(x => _str(x['帳戶']) === (newName || name))[0];
        if (after) {
          lines.push('▸ ' + (newName || name) + ' 餘額 ' + _amt(after['餘額']) + ' ' + _str(after['幣別']));
          if (balBefore !== null && Math.abs(_num(after['餘額']) - balBefore) >= 0.01) {
            lines.push('⚠️ 改名後餘額從 ' + _amt(balBefore) + ' 變成 ' + _amt(after['餘額']) +
              ' —— 有交易列沒有跟著改寫，請檢查「交易」的帳戶欄。' +
              '（餘額是 SUMIF 帳戶名算出來的，名字對不上就會掉回期初值）');
            Logger.error('AssetTools.updateAccount', '改名後餘額對不上', {
              from: name, to: newName, before: balBefore, after: _num(after['餘額'])
            });
          }
        } else if (updates['狀態'] === '停用') {
          lines.push('▸ 已停用，不再出現在「現金」表與總資產裡');
        }
        if (rebuilt.warnings && rebuilt.warnings.length) lines.push('⚠️ ' + rebuilt.warnings.join('；'));
      } else {
        lines.push('⚠️ 已寫入，但重算失敗：' +
          (rebuilt && rebuilt.reason ? rebuilt.reason : '未知原因') + '。數字暫時不準。');
      }

      Logger.info('AssetTools.updateAccount', '更新帳戶', {
        name: name, row: found.row, changed: changed,
        renamedTrades: renamed, rebuilt: rebuilt && rebuilt.ok
      });
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetTools.updateAccount', '更新帳戶失敗', ex);
      return '更新帳戶時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  return t;
})();
