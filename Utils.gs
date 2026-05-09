/**
 * Utils
 * @description 通用工具函式庫
 */
var Utils = (() => {
  var utils = {};

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

  utils.safeParseJson = (text, expect) => {
    if (!text || typeof text !== 'string') return null;
    expect = expect || 'object';
    try {
      var cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      var open  = expect === 'array' ? '[' : '{';
      var close = expect === 'array' ? ']' : '}';
      var first = cleaned.indexOf(open);
      var last  = cleaned.lastIndexOf(close);
      if (first !== -1 && last !== -1 && last > first) {
        cleaned = cleaned.substring(first, last + 1);
      }
      return JSON.parse(cleaned);
    } catch (e) { return null; }
  };

  var TIMESTAMP_RE = /^\[\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*/;
  utils.stripTimestampPrefix = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(TIMESTAMP_RE, '');
  };

  utils.truncateForLine = (str, limit) => {
    limit = limit || 4900;
    if (typeof str !== 'string' || str.length <= limit) return str;
    return str.slice(0, limit) + '\n\n（回覆過長已截斷，可詢問更具體的問題以取得完整資訊）';
  };

  return utils;
})();
