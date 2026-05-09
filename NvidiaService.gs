/**
 * NvidiaService — NVIDIA NIM API 底層通訊（OpenAI 相容格式）
 *
 * 接收 OpenAI 格式 messages，回傳 OpenAI 格式 response。
 * 格式轉換由 AIAdapter 負責，此層純 I/O。
 *
 * 思考模式依模型廠商分流：
 *   z-ai/glm*        → chat_template_kwargs.{enable_thinking, clear_thinking}
 *   deepseek-ai/v4*  → chat_template_kwargs.{enable_thinking, thinking}
 * ⚠️ GLM / DeepSeek 必須明確設定 enable_thinking，否則 NIM 端可能 hang
 */
var NvidiaService = (() => {
    var service = {};

    service.callAPI = (messages, options) => {
        try {
            options = options || {};

            var modelName = options.model || Config.NVIDIA_DEFAULT_MODEL;
            var apiKey    = Config.NVIDIA_API_KEY;

            if (!apiKey) {
                Logger.error('NvidiaService.callAPI', '未設定 NVIDIA_API_KEY', 'Model=' + modelName);
                return null;
            }

            var url = Config.NVIDIA_API_BASE + '/chat/completions';

            var payload = {
                model:       modelName,
                messages:    messages,
                temperature: options.temperature !== undefined ? options.temperature : 0.7,
                max_tokens:  options.maxOutputTokens || 6144
            };

            // 思考模式控制
            if (modelName.indexOf('z-ai/glm') === 0) {
                var glmThinking = options.enableThinking === true;
                payload.chat_template_kwargs = {
                    enable_thinking: glmThinking,
                    clear_thinking:  !glmThinking
                };
            } else if (modelName.indexOf('deepseek-ai/deepseek-v4') === 0) {
                var dsThinking = options.enableThinking === true;
                payload.chat_template_kwargs = {
                    enable_thinking: dsThinking,
                    thinking:        dsThinking
                };
            }

            // Function Calling（OpenAI Tools 格式）
            if (options.tools && options.tools.length > 0) {
                payload.tools = options.tools;
                if (modelName.indexOf('gemma') === -1) {
                    payload.tool_choice = 'auto';
                }
            }

            var fetchOptions = {
                method:  'post',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': 'Bearer ' + apiKey,
                    'Accept':        'application/json'
                },
                payload:            JSON.stringify(payload),
                muteHttpExceptions: true
            };

            var response, responseCode;
            for (var attempt = 0; attempt <= 2; attempt++) {
                response     = UrlFetchApp.fetch(url, fetchOptions);
                responseCode = response.getResponseCode();
                if (responseCode === 200) break;
                if ((responseCode === 429 || responseCode >= 500) && attempt < 2) {
                    var waitMs = 2000 * Math.pow(2, attempt);
                    Logger.warning('NvidiaService.callAPI',
                        'API 錯誤 ' + responseCode + '，第 ' + (attempt + 1) + ' 次重試（' + waitMs + 'ms）',
                        'Model=' + modelName);
                    Utilities.sleep(waitMs);
                } else {
                    Logger.error('NvidiaService.callAPI',
                        'API 錯誤碼: ' + responseCode,
                        'Model=' + modelName + ' | ' + response.getContentText());
                    return null;
                }
            }

            var parsedResponse = JSON.parse(response.getContentText('UTF-8'));

            if (parsedResponse && parsedResponse.choices && parsedResponse.choices[0]) {
                if (parsedResponse.choices[0].finish_reason === 'length') {
                    Logger.warning('NvidiaService.callAPI', 'AI 回應因 token 上限被截斷', 'Model=' + modelName);
                }
            }

            Logger.info('NvidiaService.callAPI', '使用模型: ' + modelName);
            return parsedResponse;
        } catch (error) {
            Logger.error('NvidiaService.callAPI', '呼叫失敗', error);
            return null;
        }
    };

    return service;
})();
