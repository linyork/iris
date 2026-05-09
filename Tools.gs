/**
 * Tools
 * @description 提供給 AI 的工具定義與執行邏輯（資產管理功能）
 */
var Tools = (() => {
  var tools = {};

  var definitions = [
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
    }
  ];

  tools.getDefinitions = () => definitions;

  tools.execute = (name, args) => {
    try {
      Logger.info('Tools.execute', '執行工具: ' + name, args);
      switch (name) {
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
