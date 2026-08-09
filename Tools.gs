/**
 * Tools
 * @description 提供給 AI 的工具定義與執行邏輯（資產管理功能）
 */
var Tools = (() => {
  var tools = {};

  var definitions = [
    {
      name: 'getHoldings',
      description: '取得完整持倉明細，包含每檔 ETF 的股數、總成本、當前市價、損益、幅度、殖利率等，以及合計列。用於查詢持倉現況或分析單一標的。',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'getDashboard',
      description: '取得資產總覽儀表板，包含：投資組合摘要（總成本、收益、收益率、虛均月領）、淨值（扣除現金後的真實報酬）、各帳戶現金分布、ETF 配置比例（台/全球/息/指）。用於全局分析或資產配置建議。',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'getHistory',
      description: '取得每日資產快照歷史紀錄，可看總價值走勢、各 ETF 股價變化。用於趨勢分析、高低點查詢、近期績效比較。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '查詢最近幾天（預設 30，最多 365）' }
        },
        required: []
      }
    },
    {
      name: 'rememberShortTerm',
      description: '記住一段有時效性的資訊（例如：使用者當前狀態、臨時交代的事、對話脈絡）。這些記憶會在對話中自動注入，但時效過後自動消失。',
      parameters: {
        type: 'object',
        properties: {
          key:     { type: 'string', description: '記憶的主題鍵值，例如 "目前關注標的"、"投資計畫"' },
          content: { type: 'string', description: '記憶內容（簡潔描述）' },
          hours:   { type: 'number', description: '有效時數（預設 24，最長 168 小時 = 7 天）' }
        },
        required: ['key', 'content']
      }
    },
    {
      name: 'saveKnowledge',
      description: '儲存使用者的長期知識（偏好、策略原則、重要事實）。這些知識會在相關對話時自動被搜尋出來使用。',
      parameters: {
        type: 'object',
        properties: {
          tags:    { type: 'string', description: '標籤（逗號分隔），例如 "投資策略,風險偏好"' },
          content: { type: 'string', description: '知識內容（完整且自解釋的句子）' }
        },
        required: ['tags', 'content']
      }
    },
    {
      name: 'searchKnowledge',
      description: '在長期知識庫中搜尋相關資訊。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜尋關鍵字' }
        },
        required: ['query']
      }
    },
    {
      name: 'getDividendHistory',
      description: '查詢股利收入歷史統計，包含各 ETF 股利金額、年度合計、月均。可指定年份或查詢全部紀錄。',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'number', description: '查詢指定年份（可選，例如 2025），不填則回傳全部' }
        },
        required: []
      }
    },
    {
      name: 'recordDividend',
      description: '登記一筆收到的股利。當使用者說「收到 XXX 股利」或「股利入帳」時使用。內部走 recordTrade，寫進「交易」表後自動重算持倉。',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '股票代號，例如 "0056"、"00878"' },
          amount: { type: 'number', description: '股利金額（新台幣）' },
          date:   { type: 'string', description: '入帳日期，格式 yyyy/MM/dd（可選，預設今日）' }
        },
        required: ['symbol', 'amount']
      }
    },
    {
      name: 'recordTrade',
      description: '把一筆交易記進「資產管理」表：買進、賣出、股利、現金存提、費用、利息、帳戶間轉帳。當主人說「今天買了/賣了什麼」「收到股利」「從某個帳戶提了多少」時使用。記完會自動重算持倉、成本、已實現損益與帳戶餘額並回報。資訊不齊（例如只說賣了但沒說幾股或價位）時不要猜，先問。' +
        '⚠️ 賣出會先檢查那一天手上有沒有那麼多股，不夠就整筆擋下不寫 —— 被擋下時照工具講的轉述，' +
        '不要改小股數硬記，也不要改用別的動作繞過去。',
      parameters: {
        type: 'object',
        properties: {
          action:  { type: 'string', description: '動作，擇一：買進 / 賣出 / 股利 / 存入 / 提出 / 費用 / 利息 / 轉出 / 轉入' },
          symbol:  { type: 'string', description: '股票代號，買進、賣出、股利必填。⚠️ 台股代號要保留前導零，寫 "0056" 不是 "56"' },
          shares:  { type: 'number', description: '股數（買進、賣出必填）' },
          price:   { type: 'number', description: '成交單價（買進、賣出必填）' },
          fee:     { type: 'number', description: '手續費（可選）' },
          tax:     { type: 'number', description: '交易稅（可選，通常只有賣出才有）' },
          amount:  { type: 'number', description: '金額（股利與現金類動作必填）' },
          account: { type: 'string', description: '帳戶名稱，需與「帳戶」表完全一致。買賣與股利若省略、且只有一個證券戶，會自動採用該戶' },
          date:    { type: 'string', description: '日期，格式 yyyy-MM-dd（可選，預設今天）' },
          note:    { type: 'string', description: '備註（可選）' }
        },
        required: ['action']
      }
    },
    {
      name: 'addAccount',
      description: '開一個新的帳戶（券商戶、銀行戶、外幣戶、郵局…），寫進「帳戶」主檔。' +
        '當主人說「我有一個新帳戶」「我開了一個新戶頭」「新增一個帳戶叫 XXX」時使用。' +
        '⚠️ 這是唯一能新增帳戶的方法 —— 沒有呼叫這個工具就等於沒有建立，' +
        '在收到它的回傳結果之前絕對不能說已經建好了。' +
        '幣別與類型沒講就問，不要自己猜外幣戶。',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: '帳戶名稱，之後記交易、查餘額都用這個名字比對' },
          type:        { type: 'string', description: '帳戶類型：證券 / 現金 / 外幣（可選，沒給就照名稱與幣別推）' },
          currency:    { type: 'string', description: '三碼幣別，例如 TWD / USD / JPY（可選，預設 TWD）' },
          institution: { type: 'string', description: '機構名稱，例如 國泰世華、台新銀行（可選）' },
          balance:     { type: 'number', description: '期初餘額，即「期初日期」那天帳戶裡的錢（可選，預設 0）' },
          date:        { type: 'string', description: '期初日期，格式 yyyy-MM-dd（可選，預設今天）' },
          note:        { type: 'string', description: '備註（可選）' }
        },
        required: ['name']
      }
    },
    {
      name: 'setCashBalance',
      description: '把某個現金帳戶的餘額直接校正成指定的數字。當主人講的是**絕對值**時使用：' +
        '「郵局現在是 12000」「國泰現金戶剩 8 萬」「餘額改成 X」。' +
        '講的是增減（「收到 5000」「花了 200」）請改用 recordTrade 的存入／提出。' +
        '差額由程式重讀帳戶餘額當場算，你不要自己減、也不要先查餘額再算 —— ' +
        '你看到的現金數字是換算過的台幣值，拿去減外幣戶會差一個匯率。',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '帳戶名稱，需與「帳戶」表完全一致' },
          balance: { type: 'number', description: '校正後的餘額，⚠️ 一律填該帳戶的原幣：外幣帳戶就填美金／日圓金額，不要換算成台幣' },
          note:    { type: 'string', description: '校正原因（可選），例如「對帳後補差額」' },
          date:    { type: 'string', description: '日期，格式 yyyy-MM-dd（可選，預設今天）' }
        },
        required: ['account', 'balance']
      }
    },
    {
      name: 'voidTrade',
      description: '把一筆記錯的交易作廢。當主人說「剛剛那筆記錯了」「取消／刪掉那筆交易」「股數打錯」時使用。' +
        '⚠️ 不要改用「反手記一筆相反的交易」來抵銷 —— 那在股票上會被算成真的處分，憑空生出一筆已實現損益。' +
        '要作廢哪一列不確定的話，先用 listTrades 查列號，不要猜。' +
        '原始數字會留在表上，只是不再計入任何統計。',
      parameters: {
        type: 'object',
        properties: {
          row:    { type: 'number', description: '「交易」表上的列號，即 listTrades 每筆前面的「第 N 列」' },
          reason: { type: 'string', description: '作廢原因，會寫進備註留存，例如「股數打錯」「重複記錄」' }
        },
        required: ['row', 'reason']
      }
    },
    {
      name: 'listTrades',
      description: '列出「交易」表的紀錄（買賣、股利、存提、校正），每一筆都帶列號。' +
        '用於回答「我上個月買了什麼」「這檔我進出過幾次」，以及**作廢前先確認要作廢哪一列**。' +
        '注意這查的是逐筆交易；要看每日資產走勢請用 getHistory。',
      parameters: {
        type: 'object',
        properties: {
          limit:       { type: 'number',  description: '最多幾筆（預設 15，上限 50），依日期新到舊' },
          symbol:      { type: 'string',  description: '只看某一檔的交易（可選）' },
          account:     { type: 'string',  description: '只看某一個帳戶的交易（可選）' },
          action:      { type: 'string',  description: '只看某一種動作：買進／賣出／股利／存入／提出…（可選）' },
          includeVoid: { type: 'boolean', description: '連已作廢的一起列出（可選，預設不列）' }
        },
        required: []
      }
    },
    {
      name: 'listAccounts',
      description: '列出所有帳戶（含已停用），帶類型、幣別、機構與**原幣餘額**。' +
        '用於回答「我有哪些帳戶」「那個美金戶現在有多少美金」，以及記交易或校正餘額前確認帳戶名稱。' +
        '⚠️ getDashboard 的現金只有換算後的台幣值；要原幣就用這個。',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'listInstruments',
      description: '列出「標的」主檔：代號、名稱、市場、區域、類型、目標配置%、目前股數。' +
        '和 getHoldings 不同 —— 這裡連已出清、以及登記了還沒買的標的都看得到，' +
        '也會點名哪幾檔的區域／類型還沒填（沒填就不會進「配置」的分組統計）。',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'updateInstrument',
      description: '修改「標的」主檔的欄位：名稱、市場、幣別、報價來源、區域、類型、目標配置%、狀態、備註。' +
        '當主人說「00878 的類型是高股息」「把 0056 的目標配置設成 15%」時使用。' +
        '⚠️ 代號不能改（它是各表共用的比對鍵）。' +
        '⚠️ 目標配置% 一律填 0 到 1 的比例：15% 要填 0.15，填 15 會被擋下來。',
      parameters: {
        type: 'object',
        properties: {
          symbol:      { type: 'string', description: '要修改的標的代號（必填）' },
          name:        { type: 'string', description: '名稱（可選）' },
          market:      { type: 'string', description: '市場，例如 TPE / NASDAQ（可選）。只有 TPE 的市價有 TWSE 備援' },
          currency:    { type: 'string', description: '三碼幣別（可選）' },
          quoteSource: { type: 'string', description: '報價來源，例如 GOOGLEFINANCE（可選）' },
          region:      { type: 'string', description: '區域，配置分組用，例如 台股／美股／全球（可選）' },
          category:    { type: 'string', description: '類型，配置分組用，例如 高息／市值型／債券（可選）' },
          target:      { type: 'number', description: '目標配置%，⚠️ 0..1 的比例，15% 填 0.15（可選）' },
          status:      { type: 'string', description: '狀態，例如 持有中／已出清／觀察中（可選）' },
          note:        { type: 'string', description: '備註（可選）' }
        },
        required: ['symbol']
      }
    },
    {
      name: 'updateAccount',
      description: '修改帳戶主檔：改名、改類型／機構／幣別、停用或重新啟用。' +
        '當主人說「那個帳戶改叫 XXX」「郵局那個戶頭我關了」時使用。' +
        '⚠️ 這不是改餘額 —— 餘額是交易推導出來的，要改請用 setCashBalance 或 recordTrade。' +
        '⚠️ 帳戶不能刪除，只能停用；而且停用前餘額必須是 0，否則那筆錢會從總資產上消失。',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: '現在的帳戶名稱（必填，用來定位）' },
          newName:     { type: 'string', description: '改成這個名字（可選）。「交易」裡的每一列會一起改寫' },
          type:        { type: 'string', description: '帳戶類型：證券 / 現金 / 外幣（可選）' },
          currency:    { type: 'string', description: '三碼幣別（可選）。已經有交易的帳戶不給改，會被擋下' },
          institution: { type: 'string', description: '機構名稱（可選）' },
          status:      { type: 'string', description: '啟用 / 停用（可選）' },
          note:        { type: 'string', description: '備註（可選）' }
        },
        required: ['name']
      }
    },
    {
      name: 'getPrice',
      description: '查詢台灣上市股票或 ETF 的即時（或最新收盤）股價，包含漲跌幅、開高低。用於查詢目前未持有但考慮買入的標的，或快速確認某檔股票當前價格。',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'string', description: '股票代號，多檔用逗號分隔，例如 "2330,006205"，一次最多 10 檔' }
        },
        required: ['symbols']
      }
    },
    {
      name: 'listMemories',
      description: '列出目前所有有效的短期記憶與長期知識，用於確認 Iris 記住了哪些內容。',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'deleteMemory',
      description: '刪除指定的短期記憶或長期知識條目。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '"stm"（短期記憶）或 "knowledge"（長期知識）' },
          key:  { type: 'string', description: '要刪除的記憶鍵值（STM）或標籤（knowledge），需與 listMemories 回傳的名稱完全一致' }
        },
        required: ['type', 'key']
      }
    },
    {
      name: 'searchWeb',
      description: '搜尋即時網路資訊，用於查詢當前國際財經、總體經濟、地緣政治、央行政策、匯率走勢、市場新聞等外部資訊。當分析持倉風險或市場趨勢需要參考外部時事時使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜尋關鍵字，用具體的財經或時事詞彙。重要：查詢涉及「今日/最近/本週」時，必須使用 [System Info] Current Time 的實際年份與日期，禁止自行假設或寫死年份。例如「Fed 利率決策」、「台幣匯率走勢 本週」。' }
        },
        required: ['query']
      }
    }
  ];

  tools.getDefinitions = () => definitions;

  // 這裡以前有一份 WRITE_TOOLS 名單，供 `ChatBot.reply` 判斷「模型說已記錄，
  // 到底有沒有寫過」。它是**第三處**必須跟著 `definitions` 與 `execute()` 一起改的
  // 地方，而漏改不會報錯，只會讓那個工具的假宣稱從此不再被攔下。
  //
  // 現在證據取自寫入本身（`Utils.noteLedgerWrite`），這份名單就不需要了 ——
  // 工具只要真的寫進去就一定會被算到，不必有人記得來這裡登記。要改的地方回到兩處。

  /**
   * 工具回傳的信封
   *
   * `execute()` 以前一律回字串，於是「查到了」「參數不齊」「工具壞了」在型別上完全一樣。
   * 後果是模型可以把「讀取持倉時發生錯誤：xxx」當成一段內容拿去總結，然後用一樣的
   * 語氣講給主人聽 —— 迴圈也沒有任何辦法對失敗做出不同的反應。
   *
   * ⚠️ **只宣告分得出來的三種。** 「成功但查無資料」刻意不在裡面：那個判斷藏在
   *    `GoogleSheet` / `AssetTools` 各自回的中文句子裡（「（尚無持倉資料）」之類），
   *    要在這一層認出來只能比對字串 —— 那正是這個信封想消滅的東西。真要區分，
   *    得從底層函式一起改，而不是在信封上補一個猜出來的欄位。
   */
  var ok      = (text) => ({ ok: true,  status: 'ok',           text: String(text) });
  var invalid = (text) => ({ ok: false, status: 'invalid_args', text: String(text) });
  var failed  = (text) => ({ ok: false, status: 'error',        text: String(text) });

  /** 原本的分派；回字串代表成功，回信封代表它自己判斷過了 */
  var _dispatch = (name, args) => {
    {
      switch (name) {
        case 'getHoldings':
          return GoogleSheet.getHoldings();

        case 'getDashboard':
          return GoogleSheet.getDashboard();

        case 'getHistory':
          return GoogleSheet.getHistory(args.days || 30);

        case 'rememberShortTerm':
          if (!args.key || !args.content) return invalid('缺少必要參數：key 與 content 皆為必填。');
          return GoogleSheet.addShortTermMemory(
            args.key,
            args.content,
            Math.min(args.hours || 24, 168)
          );

        case 'saveKnowledge':
          if (!args.tags || !args.content) return invalid('缺少必要參數：tags 與 content 皆為必填。');
          return GoogleSheet.addKnowledge(args.tags, args.content);

        case 'searchKnowledge':
          if (!args.query) return invalid('缺少必要參數：query。');
          return GoogleSheet.searchKnowledge(args.query);

        case 'getDividendHistory':
          return GoogleSheet.getDividendHistory(args.year);

        case 'recordDividend':
          if (!args.symbol || !args.amount) return invalid('缺少必要參數：symbol 與 amount 皆為必填。');
          // 統一走 recordTrade：股利只是動作欄不同的一列交易，
          // 走同一條路才會一併觸發重算，累計股利與帳戶餘額才跟得上。
          return AssetTools.recordTrade({
            action: '股利', symbol: args.symbol, amount: args.amount, date: args.date
          });

        case 'recordTrade':
          if (!args.action) return invalid('缺少必要參數：action。');
          return AssetTools.recordTrade(args);

        case 'addAccount':
          if (!args.name) return invalid('缺少必要參數：name。');
          return AssetTools.addAccount(args);

        case 'setCashBalance':
          // balance 可以是 0（把戶頭清空），所以只能擋 undefined/null
          if (!args.account || args.balance === undefined || args.balance === null) {
            return invalid('缺少必要參數：account 與 balance 皆為必填。');
          }
          return AssetTools.setCashBalance(args);

        case 'voidTrade':
          if (args.row === undefined || args.row === null) {
            return invalid('缺少必要參數：row（「交易」表上的列號，用 listTrades 查）。');
          }
          return AssetTools.voidTrade(args);

        case 'listTrades':
          return AssetTools.listTrades(args);

        case 'listAccounts':
          return AssetTools.listAccounts();

        case 'listInstruments':
          return AssetTools.listInstruments(args);

        case 'updateInstrument':
          if (!args.symbol) return invalid('缺少必要參數：symbol。');
          return AssetTools.updateInstrument(args);

        case 'updateAccount':
          if (!args.name) return invalid('缺少必要參數：name。');
          return AssetTools.updateAccount(args);

        case 'getPrice':
          if (!args.symbols) return invalid('缺少必要參數：symbols。');
          return StockPrice.getPrice(args.symbols);

        case 'listMemories':
          return GoogleSheet.listMemories();

        case 'deleteMemory':
          if (!args.type || !args.key) return invalid('缺少必要參數：type 與 key 皆為必填。');
          return GoogleSheet.deleteMemory(args.type, args.key);

        case 'searchWeb':
          if (!args.query) return invalid('缺少必要參數：query。');
          return WebSearch.search(args.query);

        default:
          return failed('未知的工具：' + name);
      }
    }
  };

  /**
   * 執行一個工具
   * @returns {{ok: boolean, status: 'ok'|'invalid_args'|'error', text: string}}
   */
  tools.execute = (name, args) => {
    try {
      Logger.info('Tools.execute', '執行工具: ' + name, args);
      var out = _dispatch(name, args);
      // 分派裡自己判斷過的（參數不齊、未知工具）已經是信封，其餘一律視為成功
      if (out && typeof out === 'object' && out.status) return out;
      return ok(out);
    } catch (ex) {
      Logger.error('Tools.execute', '工具執行失敗: ' + name, ex);
      return failed('工具執行失敗：' + (ex && ex.message ? ex.message : String(ex)));
    }
  };

  return tools;
})();
