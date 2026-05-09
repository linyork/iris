/**
 * AIServiceFactory
 * @description AI 服務統一入口
 *
 * 業務層固定使用 Gemini 格式（contents / options.model = 'LITE'|'FAST'|'SMART'）。
 * Factory 依 env!B3 的 AI_PROVIDER 路由至 GeminiService 或 NvidiaService；
 * 走 NVIDIA 時前後各做一次 AIAdapter 格式轉換，呼叫端完全無感。
 *
 * env!B3 值：
 *   GEMINI → 使用 Gemini API（預設）
 *   NVIDIA → 使用 NVIDIA NIM API
 */
var AIServiceFactory = (() => {
    var factory = {};

    factory.callAPI = (contents, options) => {
        var startTime = Date.now();
        try {
            options = options || {};

            var provider  = (Config.AI_PROVIDER || 'GEMINI').toUpperCase();
            var modelKey  = options.model || 'FAST';
            var models    = provider === 'NVIDIA' ? Config.NVIDIA_MODELS : Config.GEMINI_MODELS;
            var modelConfig = models && models[modelKey];

            if (modelConfig) {
                options.model           = modelConfig.model;
                options.maxOutputTokens = options.maxOutputTokens || modelConfig.maxOutputTokens;
                if (options.temperature === undefined) options.temperature = modelConfig.temperature;
                if (provider === 'NVIDIA' && options.enableThinking === undefined) {
                    options.enableThinking = modelConfig.enableThinking;
                }
            }

            var caller = options.caller || 'AIServiceFactory';
            delete options.caller;

            Logger.ai('REQUEST', caller, '送出 AI 請求', {
                provider: provider,
                model:    options.model || modelKey,
                turns:    contents ? contents.length : 0,
                tools:    (options.tools && options.tools.length) ? options.tools.length : 0
            });

            var response;

            if (provider === 'NVIDIA') {
                // ── NVIDIA 路徑：Gemini → OpenAI → NVIDIA → OpenAI → Gemini ──

                var openaiMessages = AIAdapter.toOpenAIMessages(contents);
                if (!openaiMessages || openaiMessages.length === 0) {
                    Logger.error('AIServiceFactory.callAPI', 'NVIDIA 格式轉換失敗：messages 為空');
                    return null;
                }

                var openaiOptions = Object.assign({}, options);
                if (options.tools && options.tools.length > 0) {
                    openaiOptions.tools = AIAdapter.convertToolsToOpenAI(options.tools);
                }

                var openaiResponse = NvidiaService.callAPI(openaiMessages, openaiOptions);
                if (!openaiResponse) return null;

                response = AIAdapter.fromOpenAIResponse(openaiResponse);

            } else {
                // ── Gemini 路徑：直接呼叫，無需轉換 ────────────────────────
                response = GeminiService.callAPI(contents, options);
            }

            Logger.ai('RESPONSE', caller, '收到 AI 回應', {
                latencyMs: Date.now() - startTime,
                hasText: !!(response && response.candidates && response.candidates[0] &&
                            response.candidates[0].content &&
                            response.candidates[0].content.parts &&
                            response.candidates[0].content.parts.some(p => p.text))
            });

            return response;
        } catch (error) {
            Logger.error('AIServiceFactory.callAPI', '服務呼叫失敗', error);
            return null;
        }
    };

    return factory;
})();
