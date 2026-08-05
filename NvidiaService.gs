/**
 * NvidiaService — NVIDIA NIM API 底層通訊（OpenAI 相容格式）
 *
 * 接收 OpenAI 格式 messages，回傳 OpenAI 格式 response。
 * 格式轉換由 AIAdapter 負責，此層純 I/O。
 *
 * 思考模式依模型廠商分流。**NIM 沒有統一開關，每家形狀都不一樣**：
 *   deepseek-ai/deepseek-v4* → chat_template_kwargs.{thinking(bool)[, reasoning_effort]}（現役預設）
 *   z-ai/glm*                → chat_template_kwargs.{enable_thinking, clear_thinking}
 *   openai/gpt-oss*          → **top-level** reasoning_effort（現役備援）
 *   minimaxai/*              → 無開關，恆為 reasoning 模式（該模型已退役，保留說明備查）
 *
 * ⚠️ DeepSeek V4 系列必須明確送出 chat_template_kwargs，否則 NIM 端會 hang（不是回錯，是不回）。
 *    因此該分支無論開或關思考都一定送出這個欄位，不可因 thinking=false 就省略。
 *
 * ⚠️ gpt-oss 的 reasoning_effort 只有放在 **top-level** 才生效。2026-08-05 實測，
 *    放進 chat_template_kwargs、或改用 system 訊息 `Reasoning: low`，推理量都不降反升
 *    （1036 → 1063 字元）；改成 top-level 後才真的降下來（→ 68 字元）。
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

            // top_p — NVIDIA 官方範例對 deepseek-v4-flash 建議搭配 temperature 1.0 使用 0.95
            // （未指定就不送，維持各模型自身預設值）
            if (options.topP !== undefined) {
                payload.top_p = options.topP;
            }

            // 思考模式控制
            if (modelName.indexOf('deepseek-ai/deepseek-v4') === 0) {
                // DeepSeek V4 系列：thinking 為布林開關，開啟時附 reasoning_effort。
                // 這個欄位一定要送 —— 缺了 NIM 會 hang 住不回應（見檔頭警告）。
                var dsThinking = options.enableThinking === true;
                payload.chat_template_kwargs = { thinking: dsThinking };
                if (dsThinking) payload.chat_template_kwargs.reasoning_effort = 'high';
            } else if (modelName.indexOf('z-ai/glm') === 0) {
                var glmThinking = options.enableThinking === true;
                payload.chat_template_kwargs = {
                    enable_thinking: glmThinking,
                    clear_thinking:  !glmThinking
                };
            } else if (modelName.indexOf('openai/gpt-oss') === 0) {
                // gpt-oss 沒有 on/off，只有強度；沿用各 tier 的 enableThinking 語意
                // （FAST 求快 → low，SMART 求質 → high），保持與主模型一致的分流。
                // 位置必須是 top-level，見檔頭警告。
                payload.reasoning_effort = options.enableThinking === true ? 'high' : 'low';
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

            // 重試策略：首次 + 2 次退避重試（2s → 4s）。
            // deepseek-v4-flash 在 NIM 上很熱門，實測會回 503 ResourceExhausted 與 504，
            // 也會直接把連線斷掉 —— 後者讓 UrlFetchApp.fetch 直接丟例外而非回傳狀態碼。
            // 舊版沒有逐次 try/catch，這類連線層失敗會一路衝到最外層 catch，
            // 等於「最該重試的情況反而一次都不重試」。這裡把例外也納入可重試範圍。
            var MAX_ATTEMPTS = 3;
            var response = null;

            for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                var responseCode = 0;
                var failReason   = '';

                try {
                    response     = UrlFetchApp.fetch(url, fetchOptions);
                    responseCode = response.getResponseCode();
                    if (responseCode === 200) break;

                    // 4xx（429 除外）屬請求本身的問題，重試無意義
                    if (responseCode !== 429 && responseCode < 500) {
                        Logger.error('NvidiaService.callAPI',
                            'API 錯誤碼: ' + responseCode + '（不可重試）',
                            'Model=' + modelName + ' | ' + response.getContentText());
                        return null;
                    }
                    failReason = 'HTTP ' + responseCode;
                } catch (fetchEx) {
                    // 連線被斷／逾時／DNS 失敗 —— 過載時最常見的形態，值得重試
                    response   = null;
                    failReason = '連線例外: ' + fetchEx;
                }

                if (attempt === MAX_ATTEMPTS) {
                    Logger.error('NvidiaService.callAPI',
                        'API 呼叫最終失敗（已試 ' + MAX_ATTEMPTS + ' 次）',
                        'Model=' + modelName + ' | ' + failReason);
                    return null;
                }

                var waitMs = 2000 * Math.pow(2, attempt - 1);
                Logger.warning('NvidiaService.callAPI',
                    failReason + '，第 ' + attempt + '/' + MAX_ATTEMPTS + ' 次後重試（等待 ' + waitMs + 'ms）',
                    'Model=' + modelName);
                Utilities.sleep(waitMs);
            }

            var parsedResponse = JSON.parse(response.getContentText('UTF-8'));

            // 200 但沒有 choices —— NIM 過載時偶爾會回錯誤 body 卻帶 200。
            // 回 null 讓 AIServiceFactory 的備援模型接手，比丟例外有用。
            if (!parsedResponse || !parsedResponse.choices || !parsedResponse.choices[0]) {
                Logger.error('NvidiaService.callAPI', '回應缺少 choices',
                    'Model=' + modelName + ' | ' + response.getContentText().slice(0, 300));
                return null;
            }

            var choice = parsedResponse.choices[0];
            if (choice.finish_reason === 'length') {
                Logger.warning('NvidiaService.callAPI', 'AI 回應因 token 上限被截斷', 'Model=' + modelName);
            }

            Logger.info('NvidiaService.callAPI', '使用模型: ' + modelName, {
              finish_reason: choice.finish_reason,
              usage:         parsedResponse.usage || null,
              hasToolCalls:  !!(choice.message && choice.message.tool_calls),
              thinking:      options.enableThinking === true
            });
            return parsedResponse;
        } catch (error) {
            Logger.error('NvidiaService.callAPI', '呼叫失敗', error);
            return null;
        }
    };

    return service;
})();
