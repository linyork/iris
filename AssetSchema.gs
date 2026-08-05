/**
 * AssetSchema
 * @description 「資產管理」試算表的結構定義與建表程式
 *
 * 設計原則：**一切從交易明細推導。**
 *
 *   輸入層（人或 Iris 會寫）  標的 / 帳戶 / 實體資產 / 交易
 *   計算層（程式或公式產生）  持倉 / 已實現損益 / 現金 / 配置 / 指標 / 面板
 *   歷史層                   每日快照（長表）
 *   系統層                   env / consolelog / chat / …（與 iris 舊表同構）
 *
 * 計算層的分頁**不要手改** —— `Position.rebuild()` 會整段覆寫。
 * 要修正數字，去改 `交易` 那一列。
 *
 * 兩個刻意的取捨：
 *
 * 1. 成本用**加權平均法**（與台灣券商對帳單一致），不是先進先出。
 *    賣出時按當下均價沖銷，剩餘成本才對得起來。這沒辦法用試算表公式算 ——
 *    需要逐筆遞推 —— 所以 `持倉` / `已實現損益` 由 Apps Script 重算後寫入。
 *
 * 2. 欄位一律以**標題文字**定位（`_headerMap`），不用固定索引。
 *    這是舊 sheet 上踩過的坑，見 CLAUDE.md「Daily Snapshot Column Contract」。
 */
var AssetSchema = (() => {
  var s = {};

  /**
   * 「資產管理」試算表 —— **唯一來源是指令碼屬性 `SHEET_ID`**。
   *
   * 這裡以前寫死一個 ID，於是整份程式有兩個各自獨立的真相：資產層讀這個常數，
   * 系統層（chat / knowledge / short_term_memory / alert_log / env）讀指令碼屬性。
   * 兩者碰巧相同時一切正常，但只要有人改了其中一邊 —— 例如換一張新的試算表卻
   * 只更新指令碼屬性 —— 資產數字會繼續讀舊表、記憶讀新表，而且**不會有任何錯誤**。
   *
   * 用 getter 而不是 `s.SHEET_ID = Config.SHEET_ID`：後者在 IIFE 載入當下就求值，
   * 而 GAS 不保證檔案載入順序，`Config` 那時可能還不存在。
   */
  Object.defineProperty(s, 'SHEET_ID', {
    get: () => Config.SHEET_ID,
    enumerable: true
  });

  /**
   * 舊的「股票」試算表，只讀。
   * 這個維持寫死 —— 它是一張已經凍結、不會再改的表，而且只有 `AssetMigrate`
   * 在測試裡當 fixture 用得到，沒有理由再多一個指令碼屬性去設定它。
   */
  s.LEGACY_SHEET_ID = '1wKRC30tcoC6FOOW6dKBGFeexqkVUtR3b28NY92tGiWs';

  // ─── 動作列舉 ────────────────────────────────────────────────
  //
  // 這是「交易」的動作全集，供閱讀與比對用 —— 實際的必填驗證在
  // `AssetTools.REQUIRED`，那裡刻意不含「期初」（見下）。
  //
  // 「期初」是建倉用的特殊動作：它會建立持倉與成本，但**不產生現金流**
  // （帳戶期初餘額已經是遷移當下的實際餘額，再扣一次就重複了）。
  // 同理，遷移進來的歷史交易一律把「帳戶」欄留空 —— 現金表是
  // SUMIF(帳戶) 出來的，空帳戶自然不會影響任何餘額。
  //
  // 「調整」是餘額校正：主人說的是絕對值（「郵局現在是 X」），但帳本能記的
  // 只有差額，所以它是**唯一允許「金額」為負**的動作。它同樣不在 `REQUIRED`
  // 裡 —— 差額只能由 `AssetTools.setCashBalance()` 重讀「現金」表當場算，
  // 開放給 LLM 自己填等於讓模型做減法，而模型看到的是台幣值（`Snapshot._cash`），
  // 外幣戶會整整差一個匯率而且不會報錯。
  s.ACTIONS = ['買進', '賣出', '股利', '存入', '提出', '費用', '利息', '轉出', '轉入', '期初', '調整'];

  // ─── 作廢 ────────────────────────────────────────────────────
  //
  // 記錯了怎麼辦？帳本是 append-only，但 append-only 需要的是「撤銷的方法」，
  // 不是「不准動」。這裡用**墓碑**：那一列留著、數字留著，只在「狀態」打一個
  // 記號，所有算數字的地方跳過它。
  //
  // 為什麼不是反向沖銷列：現金那邊可以（現金流一路 SUMIF，加一列負的就抵掉），
  // **股票那邊不行** —— 記錯的買進反手記一筆賣出，加權平均重放會把它當成真的
  // 處分，憑空生出一筆已實現損益。錯的沒消失，只是多了一筆假的。
  //
  // ⚠️ 現金流那一欄也必須跟著失效，否則列跳過了、錢還在帳戶餘額裡
  //    （`現金!交易淨流` 是 `SUMIF(交易!$L:$L, …, 交易!$J:$J)`，讀的是儲存格，
  //    不是 JS 這邊的過濾結果）。所以公式本身帶著 `狀態="作廢"` 的守門，
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
      name: '標的',
      textColumns: ['代號'],
      note: '投資標的主檔。新增持股前先在這裡登記一列。',
      headers: ['代號', '名稱', '市場', '幣別', '報價來源', '區域', '類型', '目標配置%', '狀態', '備註']
    },
    {
      name: '帳戶',
      note: '帳戶主檔。期初餘額只填一次，之後餘額由交易推導。',
      headers: ['帳戶', '類型', '幣別', '機構', '期初餘額', '期初日期', '狀態', '備註']
    },
    {
      name: '實體資產',
      note: '黃金這類非證券資產。數量與單位成本手動維護，現價用公式。',
      headers: ['名稱', '類別', '數量', '單位', '單位成本', '取得日', '報價來源',
                '現價', '市值', '成本', '損益', '備註']
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
      headers: ['代號', '名稱', '股數', '總成本', '平均成本', '累計股利', '已實現損益',
                '市價', '市值', '未實現損益', '報酬率', '淨成本', '淨報酬率',
                '佔股票%', '區域', '類型', '目標配置%', '佔總資產%', '偏離']
    },
    {
      name: '已實現損益',
      generated: true,
      textColumns: ['代號'],
      note: '⚠️ 由 Position.rebuild() 覆寫。每一筆賣出的沖銷結果。',
      headers: ['賣出日', '代號', '名稱', '股數', '賣出單價', '賣出淨額',
                '沖銷成本', '已實現損益', '報酬率', '賣出前均價']
    },
    {
      name: '現金',
      generated: true,
      note: '⚠️ 由 Position.rebuild() 覆寫。餘額 = 帳戶期初 + 交易現金流。',
      headers: ['帳戶', '類型', '幣別', '期初', '交易淨流', '餘額', '匯率', '台幣值']
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
      // freeform：沒有標題列契約，整張由 Panel.render() 用公式排版。
      // 人看的版面要能隨時搬動，所以不能同時背著「欄位不准動」的約束 ——
      // 那份約束留給「指標」。
      name: '面板',
      generated: true,
      freeform: true,
      note: '⚠️ 由 Panel.render() 覆寫。人看的橫式儀表板，每一格都是公式。',
      headers: []
    },
    {
      name: '每日快照',
      textColumns: ['鍵'],
      note: '每日 18:00 寫入的長表。一列一個項目，加減標的不用改結構。',
      headers: ['日期', '類型', '鍵', '名稱', '數量', '單價', '市值', '幣別', '狀態']
    },
    { name: 'env',               headers: ['name', 'value'] },
    { name: 'consolelog',        headers: ['timestamp', 'level', 'tag', 'message', 'details'] },
    { name: 'chat',              headers: ['userId', 'role', 'message', 'timestamp'] },
    { name: 'short_term_memory', headers: ['key', 'content', 'expire_at', 'category'] },
    { name: 'knowledge',         headers: ['tags', 'content', 'timestamp'] },
    { name: 'alert_log',         headers: ['timestamp', 'trigger_source', 'decision_ref', 'message', 'snapshot_summary'] }
  ];

  // ─── 交易表的公式（第 2 列起整欄填滿）─────────────────────────
  //
  // 現金流是整套帳的樞紐：不管什麼動作，最後都要換算成「這個帳戶增減多少錢」。
  //   買進  −(股數×單價 + 手續費)
  //   賣出  +(股數×單價 − 手續費 − 交易稅)
  //   調整  金額欄原樣（帶正負號，餘額校正的差額）
  //   其餘  ±金額欄
  // 轉帳寫成兩列（轉出 / 轉入），不設「對方帳戶」欄 —— 兩列版本讓每個帳戶的
  // 餘額都只是一次 SUMIF，不必處理雙向扣抵。
  //
  // $Q 是「狀態」欄。作廢的列現金流要是**空字串**，那筆錢才會從帳戶餘額裡退出去
  // —— `現金!交易淨流` 是整欄 SUMIF，它不知道 JS 那邊過濾掉了什麼。
  // 欄位字母寫死是這張表既有的慣例（$B/$E/$I 都是），靠 build() 的標題列逐格
  // 比對守住：對不上會直接丟例外，不會靜默寫到隔壁欄。

  s.TRADE_FORMULAS = {
    '名稱': '=IF($C{r}="","",IFERROR(VLOOKUP($C{r},標的!$A:$B,2,FALSE),""))',
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
   *
   * 屬性沒設時自己先擋下來 —— `openById(null)` 丟的是「Unexpected error while
   * getting the method or property openById」，看不出來是設定漏了還是程式壞了。
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
   * 儲存格 → 數字。**讀不出數字一律回 0，不回 NaN。**
   *
   * 這七個模組（Snapshot / Position / DataSync / AssetTools / AssetImport /
   * AssetMigrate / Panel）以前各自帶一份 `_num`，彼此差一兩個字元 —— 有的擋
   * `Loading...` 有的沒擋、有的剃 `%` 有的沒剃。差異全是無意的，但只要有一份
   * 漏擋，那條路上的錯誤值就會變成 NaN 一路傳進彙總，而 NaN 不會報錯。
   *
   * 這是那七份的聯集：
   *   - 本來就是數字就直接用（`Infinity` / `NaN` 算讀不出來，回 0）
   *   - `#N/A` `#VALUE!` 這類公式錯誤值、GOOGLEFINANCE 的 `Loading...`、`N/A`
   *     一律當成「還沒有值」回 0，不要讓它們變成 NaN
   *   - 千分位、貨幣符號、百分比符號、CSV 殘留的引號都剃掉
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

      // freeform 分頁的第 1 列是版面的一部分，不是標題列 —— 凍結或加粗都是錯的
      if (tab.freeform) return;
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
    Object.keys(fields).forEach(k => {
      if (map[k] !== undefined) row[map[k]] = fields[k];
    });

    var r = sheet.getLastRow() + 1;
    sheet.getRange(r, 1, 1, row.length).setValues([row]);
    s.writeRowFormulas(sheet, r, map);
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
