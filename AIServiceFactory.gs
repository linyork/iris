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
                if (provider === 'NVIDIA' && options.topP === undefined) {
                    options.topP = modelConfig.topP;
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

                // N-1 可用性保底：NvidiaService 已自帶 429/5xx/連線例外的退避重試，
                // 走到 null 多半代表主模型持續過載或已下架（deepseek-v4-flash 在 NIM 上很熱門）。
                // 此時改用備援模型重試一次，上游只吃 Gemini shape，完全無感。
                // openaiOptions 是 options 的複本，改 model 不影響呼叫端；
                // enableThinking 沿用原 tier 的值，由 NvidiaService 依新模型的形狀重新詮釋
                // （備援 gpt-oss 走 top-level reasoning_effort，high/low 對應同一組語意）。
                //
                // ⚠️ 備援也要看錶。主模型「慢速失敗」（NIM gateway 504，實測單次 300s）時，
                //    剩下的預算可能連一次呼叫都裝不下 —— 硬打下去不會換來備援的答案，
                //    只會讓整支執行撞上 GAS 6 分鐘上限被砍掉，連 return null 都跑不到，
                //    呼叫端因此也沒機會發出失敗通知。寧可明確地兩手空空，也不要靜默消失。
                var FALLBACK_MIN_MS = 90000; // 備援是關思考的小模型，夠快；但 90s 是底線
                if (!openaiResponse && Config.AI_FALLBACK_ENABLED &&
                    Config.NVIDIA_FALLBACK_MODEL &&
                    openaiOptions.model !== Config.NVIDIA_FALLBACK_MODEL) {
                    var leftMs = Utils.execTimeLeftMs();
                    if (leftMs < FALLBACK_MIN_MS) {
                        Logger.error('AIServiceFactory.callAPI',
                            '主模型失敗，且時間預算不足以啟用備援',
                            'From=' + openaiOptions.model + ' | 剩餘=' + leftMs +
                            'ms | 需要≥' + FALLBACK_MIN_MS + 'ms');
                    } else {
                        Logger.warning('AIServiceFactory.callAPI', '主模型失敗，改用備援模型重試',
                            'From=' + openaiOptions.model + ' | To=' + Config.NVIDIA_FALLBACK_MODEL +
                            ' | 剩餘=' + leftMs + 'ms');
                        openaiOptions.model = Config.NVIDIA_FALLBACK_MODEL;
                        openaiResponse = NvidiaService.callAPI(openaiMessages, openaiOptions);
                        if (openaiResponse) {
                            Logger.info('AIServiceFactory.callAPI', '備援模型接手成功',
                                'Model=' + Config.NVIDIA_FALLBACK_MODEL);
                        }
                    }
                }

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
