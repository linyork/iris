/**
 * AIAdapter — Gemini ↔ OpenAI 格式雙向轉換
 *
 * 唯一被 AIServiceFactory 在 NVIDIA 路徑呼叫，業務層永遠看不到 OpenAI 格式。
 * 處理四類轉換：contents↔messages、functionDeclarations↔tools、回應結構、inlineData↔image_url。
 *
 * fromOpenAIResponse 負責清洗 NVIDIA 模型偶爾混進 content 的 <think>...</think> 區塊。
 */
var AIAdapter = (() => {
    var adapter = {};

    /**
     * Gemini contents → OpenAI messages
     */
    adapter.toOpenAIMessages = (geminiContents) => {
        try {
            if (!geminiContents || !Array.isArray(geminiContents)) return [];

            // tool_call id 必須讓 assistant 的 tool_calls 與後續的 tool 訊息一一配對。
            // 舊版用 'call_' + 工具名，模型平行呼叫同一個工具時（M2.7 很常一次丟三個
            // searchWeb）三個 id 會完全相同，配對就壞了。改成「序號 + 名稱」，
            // 兩邊都以「同一則訊息內的第幾個」為準，只要 ChatBot 回應時維持與呼叫
            // 相同的順序就能對上。
            var callId = (name, i) => 'call_' + i + '_' + name;

            // 一則 Gemini content 可能展開成多則 OpenAI 訊息（多個 functionResponse
            // 各自要一則 tool 訊息），所以不能用 map 一對一轉換。
            var messages = [];

            geminiContents.forEach((item, index) => {
                // 第一筆永遠是 ChatBot 注入的 system context，轉為 system role 讓模型更嚴格遵守
                if (index === 0 && item.role === 'user') {
                    var sysContent = item.parts ? item.parts.filter(p => p.text).map(p => p.text).join('\n') : '';
                    messages.push({ role: 'system', content: sysContent });
                    return;
                }

                var role = item.role === 'model' ? 'assistant' : item.role;

                if (!item.parts || !Array.isArray(item.parts)) {
                    messages.push({ role: role, content: null });
                    return;
                }

                // functionResponse → tool message（每筆回應各自一則）
                var funcResParts = item.parts.filter(p => p.functionResponse);
                if (funcResParts.length > 0) {
                    funcResParts.forEach((p, i) => {
                        messages.push({
                            role:         'tool',
                            content:      JSON.stringify(p.functionResponse.response),
                            tool_call_id: callId(p.functionResponse.name, i)
                        });
                    });
                    return;
                }

                // functionCall → assistant with tool_calls（平行呼叫全部保留）
                var funcCallParts = item.parts.filter(p => p.functionCall);
                if (funcCallParts.length > 0) {
                    var tool_calls = funcCallParts.map((p, i) => ({
                        id:       callId(p.functionCall.name, i),
                        type:     'function',
                        function: {
                            name:      p.functionCall.name,
                            arguments: JSON.stringify(p.functionCall.args || {})
                        }
                    }));
                    var textParts = item.parts.filter(p => p.text).map(p => p.text).join('\n');
                    messages.push({ role: role, content: textParts || null, tool_calls: tool_calls });
                    return;
                }

                // 一般文字（含圖片 fallback）
                var content;
                var hasImage = item.parts.some(p => p.inlineData);
                if (hasImage) {
                    content = item.parts.map(p => {
                        if (p.text) return { type: 'text', text: p.text };
                        if (p.inlineData) return {
                            type:      'image_url',
                            image_url: { url: 'data:' + p.inlineData.mimeType + ';base64,' + p.inlineData.data }
                        };
                        return null;
                    }).filter(p => p !== null);
                } else {
                    content = item.parts.filter(p => p.text).map(p => p.text).join('\n');
                }
                messages.push({ role: role, content: content });
            });

            return messages;
        } catch (error) {
            Logger.error('AIAdapter.toOpenAIMessages', '格式轉換失敗', error);
            return [];
        }
    };

    /**
     * OpenAI response → Gemini-shape response
     */
    adapter.fromOpenAIResponse = (openaiResponse) => {
        try {
            if (!openaiResponse || !openaiResponse.choices || openaiResponse.choices.length === 0) return null;

            var responseModel = openaiResponse.model || 'unknown';
            var choice  = openaiResponse.choices[0];
            var message = choice.message;
            if (!message) return null;

            var parts = [];

            // 思考過程（reasoning_content / reasoning）
            if (message.reasoning_content) {
                var rawThought = message.reasoning_content;
                var normalized = rawThought;
                if (rawThought.includes('**')) {
                    normalized = rawThought
                        .replace(/\*\*情境識別\*\*[:：]?/g, 'Context:')
                        .replace(/\*\*情緒分析\*\*[:：]?/g, 'Sentiment:')
                        .replace(/\*\*意圖\*\*[:：]?/g, 'Intent:')
                        .replace(/\*\*記憶提取\*\*[:：]?/g, 'Memory:')
                        .replace(/\*\*策略\*\*[:：]?/g, 'Strategy:');
                    normalized = '[GLM_NORMALIZED]\n' + normalized;
                }
                parts.push({ thought: normalized });
            } else if (message.reasoning) {
                parts.push({ thought: message.reasoning });
            }

            // 文字內容（清除混入的 <think> 區塊）
            if (message.content) {
                var cleaned = message.content;
                cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
                var closeIdx = cleaned.toLowerCase().indexOf('</think>');
                if (closeIdx !== -1) cleaned = cleaned.substring(closeIdx + 8);
                cleaned = cleaned.trim();
                if (cleaned) parts.push({ text: cleaned });
            }

            // 工具呼叫 tool_calls → functionCall
            if (message.tool_calls && message.tool_calls.length > 0) {
                Logger.info('AIAdapter.fromOpenAIResponse', '偵測到工具呼叫', {
                    tools: message.tool_calls.map(tc => tc.function ? tc.function.name : tc.type)
                });
                message.tool_calls.forEach(tc => {
                    if (tc.type === 'function') {
                        parts.push({
                            functionCall: {
                                name: tc.function.name,
                                args: JSON.parse(tc.function.arguments || '{}')
                            }
                        });
                    }
                });
            }

            return {
                candidates: [{
                    content:      { role: 'model', parts: parts },
                    finishReason: choice.finish_reason === 'stop'       ? 'STOP' :
                                  choice.finish_reason === 'length'     ? 'MAX_TOKENS' :
                                  choice.finish_reason === 'tool_calls' ? 'FUNCTION_CALL' : 'OTHER',
                    _openai_metadata: {
                        model: openaiResponse.model,
                        usage: openaiResponse.usage
                    }
                }]
            };
        } catch (error) {
            Logger.error('AIAdapter.fromOpenAIResponse', '格式轉換失敗', error);
            return null;
        }
    };

    /**
     * Gemini functionDeclarations → OpenAI tools
     */
    adapter.convertToolsToOpenAI = (geminiTools) => {
        try {
            if (!geminiTools || !Array.isArray(geminiTools)) return [];
            return geminiTools.map(tool => ({
                type:     'function',
                function: {
                    name:        tool.name,
                    description: tool.description,
                    parameters:  tool.parameters || { type: 'object', properties: {}, required: [] }
                }
            }));
        } catch (error) {
            Logger.error('AIAdapter.convertToolsToOpenAI', '工具格式轉換失敗', error);
            return [];
        }
    };

    return adapter;
})();
