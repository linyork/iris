/**
 * GeminiService
 * @description 與 Gemini API 通訊的底層服務
 */
var GeminiService = (() => {
  var service = {};

  service.callAPI = (contents, options) => {
    try {
      options = options || {};

      var selectedModel = options.model || 'gemini-2.5-flash';
      var modelCaps = Config.MODEL_CAPABILITIES[selectedModel];

      var url = Config.GEMINI_API_BASE + '/models/' + selectedModel +
                ':generateContent?key=' + Config.GEMINI_API_KEY;

      var payload = {
        contents: contents,
        generationConfig: {
          temperature:     options.temperature || 1.0,
          maxOutputTokens: options.maxOutputTokens || (modelCaps ? modelCaps.maxOutputTokens : 4096),
          topP: 0.95
        }
      };

      if (options.tools && options.tools.length > 0) {
        payload.tools = [{ functionDeclarations: options.tools }];
      }

      var fetchOptions = {
        method:      'post',
        contentType: 'application/json',
        payload:     JSON.stringify(payload),
        muteHttpExceptions: true
      };

      var response, responseCode;
      for (var attempt = 0; attempt <= 2; attempt++) {
        response     = UrlFetchApp.fetch(url, fetchOptions);
        responseCode = response.getResponseCode();
        if (responseCode === 200) break;
        if ((responseCode === 429 || responseCode >= 500) && attempt < 2) {
          Utilities.sleep(2000 * Math.pow(2, attempt));
        } else {
          Logger.error('GeminiService.callAPI', 'API 錯誤 ' + responseCode, response.getContentText());
          return null;
        }
      }

      var parsed = JSON.parse(response.getContentText());
      Logger.info('GeminiService.callAPI', '回應成功', {
        model:         selectedModel,
        finish_reason: parsed.candidates && parsed.candidates[0] ? parsed.candidates[0].finishReason : 'N/A',
        usage:         parsed.usageMetadata || null,
        hasToolCall:   !!(parsed.candidates && parsed.candidates[0] &&
                          parsed.candidates[0].content &&
                          parsed.candidates[0].content.parts &&
                          parsed.candidates[0].content.parts.some(p => p.functionCall))
      });
      return parsed;
    } catch (error) {
      Logger.error('GeminiService.callAPI', '呼叫失敗', error);
      return null;
    }
  };

  return service;
})();
