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
      name: 'searchWeb',
      description: '搜尋即時網路資訊，用於查詢當前國際財經、總體經濟、地緣政治、央行政策、匯率走勢、市場新聞等外部資訊。當分析持倉風險或市場趨勢需要參考外部時事時使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜尋關鍵字，建議用具體的財經或時事詞彙，例如「Fed 利率決策 2025」、「台幣匯率走勢」' }
        },
        required: ['query']
      }
    }
  ];

  tools.getDefinitions = () => definitions;

  tools.execute = (name, args) => {
    try {
      Logger.info('Tools.execute', '執行工具: ' + name, args);
      switch (name) {
        case 'getHoldings':
          return GoogleSheet.getHoldings();

        case 'getDashboard':
          return GoogleSheet.getDashboard();

        case 'getHistory':
          return GoogleSheet.getHistory(args.days || 30);

        case 'rememberShortTerm':
          if (!args.key || !args.content) return '缺少必要參數：key 與 content 皆為必填。';
          return GoogleSheet.addShortTermMemory(
            args.key,
            args.content,
            Math.min(args.hours || 24, 168)
          );

        case 'saveKnowledge':
          if (!args.tags || !args.content) return '缺少必要參數：tags 與 content 皆為必填。';
          return GoogleSheet.addKnowledge(args.tags, args.content);

        case 'searchKnowledge':
          if (!args.query) return '缺少必要參數：query。';
          return GoogleSheet.searchKnowledge(args.query);

        case 'searchWeb':
          if (!args.query) return '缺少必要參數：query。';
          return WebSearch.search(args.query);

        default:
          return '未知的工具：' + name;
      }
    } catch (ex) {
      Logger.error('Tools.execute', '工具執行失敗: ' + name, ex);
      return '工具執行失敗：' + ex.message;
    }
  };

  return tools;
})();
