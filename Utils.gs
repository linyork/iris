/**
 * Utils
 * @description 通用工具函式庫
 */
var Utils = (() => {
  var utils = {};

  // ─── 執行時間預算 ────────────────────────────────────────────────
  //
  // GAS 每次執行的硬上限是 6 分鐘，超過會被直接砍掉 —— 而那是一個**攔不到**的終止：
  // catch 進不去、finally 不會跑、Logger 寫不出最後一行。從 consolelog 看起來就是
  // 「做到一半突然沒聲音」，2026-08-07 早報消失時留下的正是這個形狀。
  //
  // 時間戳在**檔案載入時**取得：GAS 每次執行都重新載入全部 .gs，所以它等同「本次執行
  // 的起點」，不必由每個進入點自己傳一個 startTime 下來 —— 真正需要看錶的地方
  // （NvidiaService 的重試迴圈）離進入點有三層遠，傳參數等於要求每一層都記得轉交。
  var EXEC_START = Date.now();

  utils.EXEC_LIMIT_MS  = 360000;
  utils.execElapsedMs  = () => Date.now() - EXEC_START;
  utils.execTimeLeftMs = () => utils.EXEC_LIMIT_MS - utils.execElapsedMs();

  utils.isJsonString = (str) => {
    if (typeof str !== 'string') return false;
    try { JSON.parse(str); return true; } catch (e) { return false; }
  };

  utils.checkMaster = (userId) => {
    try {
      return Config.ADMIN_STRING.split(',').includes(userId);
    } catch (ex) {
      return false;
    }
  };

  utils.extractText = (response) => {
    try {
      if (!response || !response.candidates || !response.candidates[0]) return '';
      var content = response.candidates[0].content;
      if (!content || !content.parts) return '';
      var textPart = content.parts.find(p => p.text);
      return textPart ? textPart.text : '';
    } catch (e) { return ''; }
  };

  var TIMESTAMP_RE = /^\[\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*/;
  utils.stripTimestampPrefix = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(TIMESTAMP_RE, '');
  };

  // 剝除 Markdown 標記 — Telegram 未設 parse_mode 時 ** 會顯示成字面星號
  utils.stripMarkdown = (str) => {
    if (typeof str !== 'string') return str;
    return str
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // **粗體**
      .replace(/\*([^*\n]+)\*/g, '$1')     // *斜體*
      .replace(/__([^_\n]+)__/g, '$1')     // __底線粗體__
      .replace(/`([^`\n]+)`/g, '$1');      // `行內程式碼`
  };

  // 清除模型誤輸出的 <tool_call>...</tool_call> XML 殘留
  utils.stripToolCallXml = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
  };

  // 強制在段落符號前插入換行，防止模型輸出密集連續文字
  utils.formatForLine = (str) => {
    if (typeof str !== 'string') return str;
    var result = str;
    // 在 ▸ ◆ 【 前確保有換行（若前一個字元不是換行則插入 \n\n）
    result = result.replace(/([^\n])(▸|◆|【)/g, '$1\n\n$2');
    // 在句號/問號/！後若直接接著文字（非換行），插入換行
    result = result.replace(/([。？！])([^\n」』）\s])/g, '$1\n$2');
    // 清理超過兩個連續空行
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
  };

  // 將長訊息依換行點切成 ≤ limit 字元的陣列，供 pushMsg 分段發送
  utils.splitForLine = (str, limit) => {
    limit = limit || 4900;
    if (typeof str !== 'string' || str.length <= limit) return [str];
    var chunks = [];
    var remaining = str;
    while (remaining.length > limit) {
      var cut = remaining.lastIndexOf('\n', limit);
      if (cut <= 0) cut = limit;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^\n/, '');
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  };

  return utils;
})();
