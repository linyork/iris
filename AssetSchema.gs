/**
 * AssetSchema
 * @description 「資產管理」試算表的結構定義與建表程式
 *
 * 一切從交易明細推導：
 *   輸入層（人或 Iris 會寫）  帳戶 / 實體資產 / 交易
 *   計算層（程式或公式產生）  持倉 / 現金 / 配置 / 指標
 *                             （持倉的 名稱／區域／類型／目標配置% 例外：人手維護，重算時依代號保留）
 *   歷史層                   每日快照（長表）
 *   系統層                   consolelog / chat
 *
 * ⚠️ 計算層的分頁不可手改，Position.rebuild() 會整段覆寫。要修正數字改「交易」那一列。
 * ⚠️ 成本用加權平均法（與台灣券商對帳單一致），路徑相依，所以由 Apps Script 重算後寫入。
 * ⚠️ 欄位一律以標題文字定位（headerMap），不用固定索引。
 */
var AssetSchema = (() => {
  var s = {};

  /**
   * 「資產管理」試算表，唯一來源是指令碼屬性 SHEET_ID。
   * ⚠️ 不可寫死 ID：資產層與系統層若各有一份，換表時會一邊舊一邊新且不報錯。
   * ⚠️ 用 getter 而非直接指派：直接指派在 IIFE 載入當下求值，
   *    而 GAS 不保證檔案載入順序，Config 那時可能還不存在。
   */
  Object.defineProperty(s, 'SHEET_ID', {
    get: () => Config.SHEET_ID,
    enumerable: true
  });

  /** 舊的「股票」試算表，只讀且已凍結，僅 AssetMigrate 在測試裡當 fixture 用。 */
  s.LEGACY_SHEET_ID = '1wKRC30tcoC6FOOW6dKBGFeexqkVUtR3b28NY92tGiWs';

  // ─── 動作列舉 ────────────────────────────────────────────────
  // 動作全集，供閱讀與比對；必填驗證在 AssetTools.REQUIRED（那裡不含「期初」）。
  //
  // 「期初」是遷移建倉用：建立持倉與成本但不產生現金流（帳戶期初餘額已是遷移
  // 當下的實際餘額）。遷移進來的歷史交易「帳戶」欄一律留空，現金表是
  // SUMIF(帳戶)，空帳戶不影響任何餘額。
  //
  // 「調整」是餘額校正，唯一允許「金額」為負的動作。同樣不在 REQUIRED：
  // 差額只能由 AssetTools.setCashBalance() 重讀「現金」表當場算。
  // 開放給 LLM 填等於讓它做減法，而它看到的是台幣值，外幣戶會差一個匯率。
  s.ACTIONS = ['買進', '賣出', '股利', '存入', '提出', '費用', '利息', '轉出', '轉入', '期初', '調整'];

  // ─── 作廢 ────────────────────────────────────────────────────
  // 墓碑式撤銷：列與數字都留著，只在「狀態」打記號，算數字的地方跳過。
  //
  // ⚠️ 不可改用「反向沖銷列」。現金那邊可行（現金流是 SUMIF），股票那邊不行 ——
  //    記錯的買進反手記一筆賣出，加權平均重放會當成真的處分，生出假的已實現損益。
  // ⚠️ 現金流那一欄必須跟著失效，否則列跳過了錢還留在餘額裡
  //    （現金!交易淨流 是整欄 SUMIF，看不到 JS 的過濾）。守門寫在公式裡，
  //    見 TRADE_FORMULAS。
  s.VOID = '作廢';

  /** 這一列被作廢了嗎？所有讀「交易」的地方都該問這一句，不要各自比字串 */
  s.isVoid = (t) => s.str(t && t['狀態']) === s.VOID;

  // ─── 分頁定義 ──────────────────────────────────────────────────
  //
  // generated: true 代表整張表由 Position.rebuild() 覆寫，人不要手改。
  // 每個分頁都凍結第一列。

  s.TABS = [
    {
      name: '帳戶',
      note: '帳戶主檔。期初餘額只填一次，之後餘額由交易推導。',
      // 2026-10-08 拿掉機構／期初日期／備註：只寫不讀。讀寫這張表一律依欄名。
      headers: ['帳戶', '類型', '幣別', '期初餘額', '狀態']
    },
    {
      name: '實體資產',
      note: '黃金這類非證券資產。名稱與數量手動維護，現價與市值是公式。',
      // 2026-10-08 拿掉 8 欄（類別／單位／單位成本／取得日／報價來源／成本／損益／備註）：
      // 主人暫時不需要實體資產的損益，其餘沒人讀。讀這張表的地方一律依欄名。
      headers: ['名稱', '數量', '現價', '市值']
    },
    {
      name: '交易',
      textColumns: ['代號'],
      note: '唯一的事實來源。每一筆買賣、股利、存提都在這裡。只新增，不改歷史數字；' +
            '記錯了把「狀態」設成「作廢」（voidTrade），不要刪列、不要改金額。',
      headers: ['日期', '動作', '代號', '名稱', '股數', '單價', '手續費', '交易稅',
                '金額', '現金流', '幣別', '帳戶', '分類', '備註', '來源', '建立時間', '狀態']
    },
    {
      name: '持倉',
      generated: true,
      textColumns: ['代號'],
      note: '⚠️ 由 Position.rebuild() 覆寫，請勿手改。要修正請改「交易」。',
      // 2026-10-08 拿掉 7 欄沒有任何程式讀的（未實現損益／報酬率／淨成本／淨報酬率／
      // 佔股票%／佔總資產%／偏離）：損益與佔比由 Snapshot 自己算，偏離看「配置」。
      headers: ['代號', '名稱', '股數', '總成本', '平均成本', '累計股利', '已實現損益',
                '市價', '市值', '區域', '類型', '目標配置%']
    },
    {
      name: '現金',
      generated: true,
      note: '⚠️ 由 Position.rebuild() 覆寫。餘額 = 帳戶期初 + 交易現金流。',
      // 2026-10-08 拿掉「類型」：沒人讀（要帳戶類型的地方讀的是「帳戶」表）。
      // 這張表是依欄名寫的（writeBlockByName），表上多一欄或少一欄都不會寫錯位置。
      headers: ['帳戶', '幣別', '期初', '交易淨流', '餘額', '匯率', '台幣值']
    },
    {
      name: '配置',
      generated: true,
      note: '⚠️ 由 Position.rebuild() 覆寫。三個維度：大類 / 區域 / 類型。',
      headers: ['維度', '分組', '成本', '市值', '實際%', '目標%', '偏離%', '偏離金額']
    },
    {
      name: '指標',
      generated: true,
      note: '⚠️ 由 Position.rebuild() 覆寫。直式 key-value，程式讀的是這張。',
      headers: ['指標', '數值', '說明']
    },
    {
      name: '每日快照',
      textColumns: ['鍵'],
      note: '每日 18:00 寫入的長表。一列一個項目，加減標的不用改結構。',
      headers: ['日期', '類型', '鍵', '名稱', '數量', '單價', '市值', '幣別', '狀態']
    },
    { name: 'consolelog',        headers: ['timestamp', 'level', 'tag', 'message', 'details'] },
    { name: 'chat',              headers: ['userId', 'role', 'message', 'timestamp'] }
  ];

  // ─── 交易表的公式（第 2 列起整欄填滿）─────────────────────────
  // 現金流把每個動作換算成「這個帳戶增減多少錢」：
  //   買進 −(股數×單價 + 手續費)　賣出 +(股數×單價 − 手續費 − 交易稅)
  //   調整 金額欄原樣（帶正負號）　其餘 ±金額欄
  // 轉帳寫成兩列（轉出／轉入），不設「對方帳戶」欄，每個帳戶的餘額都只是一次 SUMIF。
  //
  // ⚠️ $Q 是「狀態」欄，作廢的列現金流必須是空字串，那筆錢才會退出帳戶餘額。
  // ⚠️ 欄位字母寫死是這張表的既有慣例，靠 build() 的標題列逐格比對守住 ——
  //    對不上會丟例外，不會靜默寫到隔壁欄。

  // 「名稱」以前是 VLOOKUP 到「標的」的公式。2026-10-08「標的」退役，名稱改成記帳當下
  // 寫入的文字（見 s.nameFor）—— 它只是顯示用，一律以代號對應。
  s.TRADE_FORMULAS = {
    '現金流':
      '=IF(OR($B{r}="",$Q{r}="' + s.VOID + '"),"",' +
      'IFS(' +
      '$B{r}="買進",-(N($E{r})*N($F{r})+N($G{r})),' +
      '$B{r}="賣出",N($E{r})*N($F{r})-N($G{r})-N($H{r}),' +
      'OR($B{r}="股利",$B{r}="存入",$B{r}="利息",$B{r}="轉入"),N($I{r}),' +
      'OR($B{r}="提出",$B{r}="費用",$B{r}="轉出"),-N($I{r}),' +
      '$B{r}="調整",N($I{r}),' +
      'TRUE,0))'
  };

  // ⚠️ 公式**只填到有資料的最後一列**，絕對不要預先灌滿幾千列。
  //    預灌的話 getLastRow() 會回到公式底部，appendRow() 與所有
  //    「接在最後一列後面」的邏輯都會跳到公式範圍之外，新交易的現金流
  //    永遠是空的 —— 帳戶餘額就再也不會動。用 s.appendTrade() 新增交易。

  // ─── 工具 ──────────────────────────────────────────────────────

  /**
   * 打開「資產管理」試算表。
   * 屬性沒設時自己先擋下：openById(null) 的錯誤訊息看不出是設定漏了還是程式壞了。
   */
  s.open = () => {
    var id = s.SHEET_ID;
    if (!id) {
      throw new Error('指令碼屬性 SHEET_ID 沒有設定 —— 資產表與系統分頁都讀這一個值。' +
        '請到 GAS 專案設定 → 指令碼屬性補上，或執行 setup() 檢查。');
    }
    return SpreadsheetApp.openById(id);
  };

  /**
   * 儲存格 → 字串。空值一律成空字串，前後空白剃掉。
   */
  s.str = (v) => String(v === null || v === undefined ? '' : v).trim();

  /**
   * 儲存格 → 數字。⚠️ 讀不出數字一律回 0，不回 NaN（NaN 會一路傳進彙總且不報錯）。
   *   - 本來是數字就直接用（Infinity / NaN 視為讀不出來，回 0）
   *   - #N/A、#VALUE!、GOOGLEFINANCE 的 Loading...、N/A 一律回 0
   *   - 千分位、貨幣符號、百分比符號、CSV 殘留的引號都剃掉
   * 所有模組共用這一份，不要各自再寫一個。
   */
  s.num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var t = String(v).trim();
    if (t.charAt(0) === '#' || /^loading/i.test(t) || t === 'N/A') return 0;
    var n = parseFloat(t.replace(/[",%$]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  /** 標題文字 → 0-based 索引。找不到的欄位回 -1。 */
  s.headerMap = (sheet) => {
    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var raw = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(v => String(v === null || v === undefined ? '' : v).trim());
    var map = {};
    raw.forEach((h, i) => { if (h && !(h in map)) map[h] = i; });
    map.__header = raw;
    return map;
  };

  s.colLetter = (col) => {
    var letter = '';
    while (col > 0) {
      var mod = (col - 1) % 26;
      letter = String.fromCharCode(65 + mod) + letter;
      col = Math.floor((col - 1) / 26);
    }
    return letter;
  };

  /** 讀整張表成物件陣列（以標題為鍵），空列自動略過 */
  s.readObjects = (sheet) => {
    var lastRow = sheet.getLastRow();
    var lastCol = Math.max(sheet.getLastColumn(), 1);
    if (lastRow < 2) return [];
    var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(v => String(v === null || v === undefined ? '' : v).trim());
    return sheet.getRange(2, 1, lastRow - 1, lastCol).getValues()
      .filter(r => r.some(v => v !== '' && v !== null && v !== undefined))
      .map(r => {
        var o = {};
        header.forEach((h, i) => { if (h) o[h] = r[i]; });
        return o;
      });
  };

  /**
   * 讀「交易」表，**預設不含作廢的列**。
   *
   * 每一個算數字的地方都該走這裡而不是 `readObjects(交易)` —— 漏掉一個，那條路
   * 上的作廢列就會復活，而且只在那一個數字上錯（例如持倉對了、股利統計多一筆）。
   *
   * 每個物件多帶一個 `__row`：試算表上的實際列號。`readObjects` 會跳過空白列，
   * 所以「陣列索引 +2」不保證等於列號，而作廢要指定列號才叫得動。
   *
   * @param {object} [ss]
   * @param {object} [options]
   * @param {boolean} [options.includeVoid] 連作廢的一起回傳（對帳、去重時用）
   */
  s.readTrades = (ss, options) => {
    options = options || {};
    ss = ss || s.open();
    var sheet = ss.getSheetByName('交易');
    if (!sheet) return [];

    var lastRow = sheet.getLastRow();
    var lastCol = Math.max(sheet.getLastColumn(), 1);
    if (lastRow < 2) return [];
    var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(v => s.str(v));

    var out = [];
    sheet.getRange(2, 1, lastRow - 1, lastCol).getValues().forEach((r, i) => {
      if (!r.some(v => v !== '' && v !== null && v !== undefined)) return;
      var o = {};
      header.forEach((h, c) => { if (h) o[h] = r[c]; });
      o.__row = i + 2;
      if (!options.includeVoid && s.isVoid(o)) return;
      out.push(o);
    });
    return out;
  };

  /** TABS 裡某分頁的預期標題列（找不到回 null） */
  s.expected = (name) => {
    var tab = s.TABS.filter(t => t.name === name)[0];
    return tab ? tab.headers.slice() : null;
  };

  /**
   * 檢查標題列是否與 TABS 定義**逐格對齊**。
   *
   * ⚠️ 這件事必須嚴格：`_headerMap` 只用在**讀**，寫入一律是位置對應
   * （`writeBlock` 按索引塞值，產生的公式還把欄位字母寫死成 $A/$C/$H…）。
   * 順序一旦不合又繼續寫，值就會靜默地跑到隔壁欄 —— 正是舊 sheet 上
   * 「Daily Snapshot Column Contract」記錄的那個坑。
   *
   * @returns {{ok:boolean, at?:number, found?:string, want?:string}} at 為 1-based 欄號
   */
  s.checkHeader = (sheet, expected) => {
    var raw = s.headerMap(sheet).__header;
    for (var i = 0; i < expected.length; i++) {
      var actual = String(raw[i] === undefined || raw[i] === null ? '' : raw[i]).trim();
      if (actual !== expected[i]) {
        return { ok: false, at: i + 1, found: actual, want: expected[i] };
      }
    }
    return { ok: true };
  };

  /** 寫入前的守門：欄位對不上就丟例外，不要寫到隔壁欄去 */
  s.assertHeader = (sheet, width) => {
    var expected = s.expected(sheet.getName());
    if (!expected) return;
    var chk = s.checkHeader(sheet, expected.slice(0, width || expected.length));
    if (chk.ok) return;
    throw new Error(
      '「' + sheet.getName() + '」第 ' + chk.at + ' 欄應該是「' + chk.want + '」，' +
      '實際是「' + (chk.found || '(空白)') + '」。寫入是位置對應的，欄位錯位會靜默寫錯，' +
      '請先執行 setupAssetSheet() 修正標題列。'
    );
  };

  /**
   * 欄名 → 欄位字母，讀的是**試算表上實際的標題列**。給跨表公式用（例如「指標」加總
   * 現金的台幣值）：主人在表上刪掉或挪動別的欄，引用會跟著走，而不是靜默讀到隔壁欄。
   * 找不到那一欄就丟例外 —— 寫出一個指錯欄的公式比停下來糟。
   */
  s.liveCol = (sheet, name) => {
    var idx = s.headerMap(sheet)[name];
    if (idx === undefined) throw new Error('「' + sheet.getName() + '」找不到「' + name + '」欄');
    return s.colLetter(idx + 1);
  };

  /**
   * 依**欄名**覆寫一張 generated 分頁的資料區，不靠欄位位置。
   *
   * rowsFn(L) 會拿到「欄名 → 實際欄位字母」的函式，回傳以欄名為鍵的物件陣列；公式裡的
   * 欄位字母也用 L() 組，所以整列都跟著試算表實際的欄序走。
   * 標題列只要求 TABS 定義的欄位**都在**，不管順序、也容許多出來的欄（寫空白）——
   * 主人在表上刪掉一欄沒人讀的欄，不必等程式先改。
   */
  s.writeBlockByName = (sheet, rowsFn) => {
    var map = s.headerMap(sheet);
    var missing = (s.expected(sheet.getName()) || []).filter(h => map[h] === undefined);
    if (missing.length) {
      throw new Error('「' + sheet.getName() + '」缺少欄位：' + missing.join('、') +
        '，請先執行 setupAssetSheet()');
    }
    var header = map.__header;
    var width = header.length;
    var objs = rowsFn((name) => s.colLetter(map[name] + 1));
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), width)).clearContent();
    if (!objs.length) return;
    var rows = objs.map(o => header.map(h => (h && o[h] !== undefined) ? o[h] : ''));
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
  };

  /**
   * 覆寫一張 generated 分頁的資料區（保留標題列）。
   * 先清到最後一列再寫，避免上一次比較長時留下殘影。
   */
  s.writeBlock = (sheet, rows, width) => {
    s.assertHeader(sheet, width);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), width)).clearContent();
    if (rows.length === 0) return;
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
  };

  // ─── 建表 ──────────────────────────────────────────────────────

  /**
   * 冪等建立或補齊所有分頁。
   *   - 分頁不存在 → 新增
   *   - 標題列缺欄 → 補在最後（既有資料不動）
   *   - 交易表的公式欄 → 重新填滿到 TRADE_FORMULA_ROWS
   * 不會刪除任何既有分頁、欄位或資料。
   */
  s.build = () => {
    var ss = s.open();
    var created = [], patched = [];

    s.TABS.forEach(tab => {
      var sheet = ss.getSheetByName(tab.name);
      if (!sheet) {
        sheet = ss.insertSheet(tab.name);
        created.push(tab.name);
      }

      // 標題列必須與 TABS 逐格對齊 —— 補欄一律補在「它該在的位置」，
      // 不是補在最後面。補在最後面而寫入又照 TABS 順序，兩者就會錯開。
      var chk = s.checkHeader(sheet, tab.headers);
      if (!chk.ok) {
        if (chk.found === '') {
          // 尾端缺欄（含全新空表）：直接補上，既有資料的欄位位置不受影響
          var tail = tab.headers.slice(chk.at - 1);
          sheet.getRange(1, chk.at, 1, tail.length).setValues([tail]);
          patched.push(tab.name + '：+' + tail.join('、'));
        } else if (tab.generated) {
          // 計算層本來就整段覆寫，標題列重寫最安全
          sheet.getRange(1, 1, 1, tab.headers.length).setValues([tab.headers]);
          patched.push(tab.name + '：標題列重寫（原第 ' + chk.at + ' 欄為「' + chk.found + '」）');
        } else {
          // 輸入層有人工資料，不能自作主張搬欄位
          throw new Error(
            '「' + tab.name + '」第 ' + chk.at + ' 欄應該是「' + chk.want + '」，' +
            '實際是「' + chk.found + '」。這張是輸入層分頁，程式不會自動搬動既有資料的欄位，' +
            '請手動把標題列調整成：' + tab.headers.join(' | ')
          );
        }
      }

      // ⚠️ 代號欄一定要設成純文字。台股代號有前導零（0056、00878），
      //    用 setValues 寫字串進「自動」格式的欄位，Sheets 會判定它像數字而
      //    轉成 56、878 —— 於是 GOOGLEFINANCE("TPE:"&代號) 查無此股，
      //    市值整欄變 0，而且完全不報錯。只有含字母的代號（00687B）會倖存。
      (tab.textColumns || []).forEach(name => {
        var at = tab.headers.indexOf(name);
        if (at < 0) return;
        try {
          sheet.getRange(1, at + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
        } catch (e) { /* 舊版 API 沒有就算了，資料仍會寫進去 */ }
      });

      try {
        sheet.setFrozenRows(1);
        sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).setFontWeight('bold');
      } catch (e) { /* 格式失敗不影響資料 */ }
    });

    s.applyTradeFormulas(ss);
    _removeDefaultSheet(ss);

    var result = { created: created, patched: patched, tabs: s.TABS.length };
    Logger.info('AssetSchema.build', '建表完成', result);
    return result;
  };

  /**
   * 重填交易表的公式欄，範圍是第 2 列到**最後一列有日期的資料**。
   * 大量寫入交易之後呼叫一次即可。
   */
  s.applyTradeFormulas = (ss) => {
    ss = ss || s.open();
    var sheet = ss.getSheetByName('交易');
    if (!sheet) return 0;
    var map = s.headerMap(sheet);
    var dateIdx = map['日期'];
    if (dateIdx === undefined) return 0;

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;
    var dates = sheet.getRange(2, dateIdx + 1, lastRow - 1, 1).getValues();
    var lastData = 0;
    dates.forEach((d, i) => {
      if (d[0] !== '' && d[0] !== null && d[0] !== undefined) lastData = i + 2;
    });
    if (lastData < 2) return 0;
    var n = lastData - 1;

    Object.keys(s.TRADE_FORMULAS).forEach(colName => {
      var idx = map[colName];
      if (idx === undefined || idx < 0) return;
      var tpl = s.TRADE_FORMULAS[colName];
      var values = [];
      for (var r = 2; r <= lastData; r++) values.push([tpl.replace(/\{r\}/g, r)]);
      sheet.getRange(2, idx + 1, n, 1).setFormulas(values);
    });
    return n;
  };

  // ─── 名稱 ──────────────────────────────────────────────────────
  //
  // 2026-10-08 起「標的」分頁退役，名稱只是顯示用 —— 一切以代號對應。
  // 名稱一律是證交所簡稱（「富邦台50」），與券商對帳單一致。

  /** 證交所名單；測試環境或抓不到時回 null */
  var _listed = () => {
    try {
      return (typeof StockPrice !== 'undefined' && StockPrice.listedNames)
        ? StockPrice.listedNames() : null;
    } catch (e) { return null; }
  };

  /**
   * 代號 → 顯示名稱。先看持倉（主人可能改過），再看證交所名單，都沒有就回代號本身。
   */
  s.nameFor = (ss, code) => {
    code = s.str(code);
    if (!code) return '';
    var pos = ss.getSheetByName('持倉');
    if (pos) {
      var hit = s.readObjects(pos).filter(x => s.str(x['代號']) === code)[0];
      if (hit && s.str(hit['名稱'])) return s.str(hit['名稱']);
    }
    var listed = _listed();
    return (listed && listed.byCode[code]) || code;
  };

  /**
   * 名稱 → 代號，給 CSV 匯入用（對帳單只有股名，沒有代號）。
   *
   * ⚠️ **證交所名單優先**，持倉的名稱只在證交所查不到時（例如上櫃）才用。
   *    反過來的話，主人把某檔在持倉改名成剛好等於另一檔的證交所簡稱，那一檔的
   *    對帳單交易就會記到錯的代號上，而且不會報錯。
   * ⚠️ 只接受剛好對到一檔。零檔或多檔一律回空字串，不猜。
   *
   * @returns {{code: string, isNew: boolean}} isNew = 持倉裡還沒有這個代號
   */
  s.codeForName = (ss, name, listed) => {
    name = s.str(name);
    var out = { code: '', isNew: false };
    if (!name) return out;
    var held = {};
    var byHeldName = {};
    var pos = ss.getSheetByName('持倉');
    if (pos) s.readObjects(pos).forEach(x => {
      var c = s.str(x['代號']);
      if (!c) return;
      held[c] = true;
      (byHeldName[s.str(x['名稱'])] = byHeldName[s.str(x['名稱'])] || []).push(c);
    });
    listed = listed === undefined ? _listed() : listed;
    var hits = (listed && listed.byName[name]) || [];
    if (hits.length !== 1) hits = byHeldName[name] || [];
    if (hits.length !== 1) return out;
    out.code = hits[0];
    out.isNew = !held[out.code];
    return out;
  };

  /**
   * 一次性遷移：把「標的」的 區域／類型／目標配置% 搬進持倉，名稱統一成證交所簡稱，
   * 並把「交易」的名稱公式凍結成文字。**必須在刪掉「標的」之前跑** —— 先刪的話
   * 交易表每一列的名稱公式會立刻變空白。冪等，重跑結果相同。
   * @returns {object} 摘要
   */
  s.retireInstrumentsTab = (ss) => {
    ss = ss || s.open();
    var listed = _listed();
    var inst = ss.getSheetByName('標的');
    var instBy = {};
    if (inst) s.readObjects(inst).forEach(x => { instBy[s.str(x['代號'])] = x; });
    // 名稱：證交所簡稱 → 「標的」的名稱（上櫃查不到證交所的就靠它）→ 原本的值 → 代號
    var nameOf = (code, fallback) => (listed && listed.byCode[code]) ||
      s.str((instBy[code] || {})['名稱']) || s.str(fallback) || code;
    var out = { 持倉: 0, 交易: 0, 證交所名單: !!listed, 標的分頁: !!inst };

    // 持倉：名稱、區域、類型、目標配置% 改成死值（目標配置% 原本是 VLOOKUP 到標的的公式）
    var pos = ss.getSheetByName('持倉');
    if (pos && pos.getLastRow() >= 2) {
      var pm = s.headerMap(pos);
      var cols = ['名稱', '區域', '類型', '目標配置%'];
      if (cols.some(c => pm[c] === undefined)) throw new Error('持倉缺少欄位：' + cols.join('、'));
      var n = pos.getLastRow() - 1;
      var data = pos.getRange(2, 1, n, pos.getLastColumn()).getValues();
      cols.forEach(c => {
        var vals = data.map(r => {
          var code = s.str(r[pm['代號']]);
          var src  = instBy[code] || {};
          if (c === '名稱') return [code ? nameOf(code, r[pm['名稱']]) : ''];
          var v = src[c] !== undefined && s.str(src[c]) !== '' ? src[c] : r[pm[c]];
          return [c === '目標配置%' ? (s.str(v) === '' ? '' : s.num(v)) : s.str(v)];
        });
        pos.getRange(2, pm[c] + 1, n, 1).setValues(vals);
      });
      out.持倉 = n;
    }

    // 交易：名稱凍結成文字，順便統一成證交所簡稱
    var tr = ss.getSheetByName('交易');
    if (tr && tr.getLastRow() >= 2) {
      var tm = s.headerMap(tr);
      var tn = tr.getLastRow() - 1;
      var rows = tr.getRange(2, 1, tn, tr.getLastColumn()).getValues();
      var names = rows.map(r => {
        var code = s.str(r[tm['代號']]);
        return [code ? nameOf(code, r[tm['名稱']]) : s.str(r[tm['名稱']])];
      });
      tr.getRange(2, tm['名稱'] + 1, tn, 1).setValues(names);
      out.交易 = tn;
    }
    Logger.info('AssetSchema.retireInstrumentsTab', '標的退役遷移完成', out);
    return out;
  };

  /**
   * 新增一筆交易，並補上該列的公式欄。
   * 這是新增交易的**唯一正確途徑** —— 直接 appendRow 會少掉現金流公式，
   * 那筆錢就不會進帳戶餘額。
   * @param {object} fields 以標題文字為鍵，例如 {日期:'2026-08-03', 動作:'賣出', …}
   * @returns {number} 寫入的列號
   */
  s.appendTrade = (fields, ss) => {
    ss = ss || s.open();
    var sheet = ss.getSheetByName('交易');
    if (!sheet) throw new Error('找不到「交易」分頁，請先執行 setupAssetSheet()');

    var map = s.headerMap(sheet);
    var header = map.__header.filter(h => h !== '');
    var row = new Array(header.length).fill('');
    // 名稱是寫進去的文字，不再是公式。呼叫端沒給就依代號查（見 s.nameFor）
    if (s.str(fields['代號']) && !s.str(fields['名稱'])) {
      fields = Object.assign({}, fields, { '名稱': s.nameFor(ss, fields['代號']) });
    }
    Object.keys(fields).forEach(k => {
      if (map[k] !== undefined) row[map[k]] = fields[k];
    });

    var r = sheet.getLastRow() + 1;
    sheet.getRange(r, 1, 1, row.length).setValues([row]);
    s.writeRowFormulas(sheet, r, map);
    // 記帳、股利、餘額校正三個工具都走這裡，所以這一行涵蓋全部帳本新增
    Utils.noteLedgerWrite('交易 第 ' + r + ' 列 ' + s.str(fields['動作']));
    return r;
  };

  /**
   * 把公式欄重寫到單獨一列。
   *
   * 新增一筆交易與作廢一筆交易都需要它：作廢改的是「狀態」，而現金流的守門
   * 條件寫在**公式裡** —— 既有的列可能還帶著沒有守門的舊版公式（那時候還沒有
   * 狀態欄），不重寫的話狀態設了、錢卻還留在帳戶餘額裡。
   */
  s.writeRowFormulas = (sheet, r, map) => {
    map = map || s.headerMap(sheet);
    Object.keys(s.TRADE_FORMULAS).forEach(colName => {
      var idx = map[colName];
      if (idx === undefined || idx < 0) return;
      sheet.getRange(r, idx + 1).setFormula(s.TRADE_FORMULAS[colName].replace(/\{r\}/g, r));
    });
  };

  /** 新試算表預設會有一張空的「工作表1」，建完就移除 */
  var _removeDefaultSheet = (ss) => {
    try {
      var known = s.TABS.map(t => t.name);
      ss.getSheets().forEach(sh => {
        if (known.indexOf(sh.getName()) >= 0) return;
        if (sh.getLastRow() > 0 || sh.getLastColumn() > 1) return;   // 有東西就不碰
        if (ss.getSheets().length <= 1) return;
        ss.deleteSheet(sh);
      });
    } catch (e) { /* 刪不掉就算了 */ }
  };

  return s;
})();

// ─── GAS 編輯器進入點 ─────────────────────────────────────────────
