/**
 * ChatBot
 * @description Iris 的對話核心，使用 ReAct 框架處理工具呼叫
 */
var ChatBot = (() => {
  var chatBot = {};

  /**
   * 回覆使用者訊息（支援 Function Calling）
   * @param {object} event - LINE 事件物件
   * @returns {string} AI 回覆文字
   */
  chatBot.reply = (event) => {
    try {
      var userId  = event.source.userId;
      var message = event.message.text;

      // 取得對話歷史
      var history = HistoryManager.getUserHistory(userId, Config.CHAT_MAX_TURNS);

      // 組裝 contents
      var nowStr = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');

      // 讀取短期記憶與知識（搜尋與當前訊息相關的知識）
      var stm            = GoogleSheet.getValidShortTermMemories();
      var relevantKnowledge = GoogleSheet.searchKnowledge(message);

      var systemContext = Config.SYSTEM_PROMPT +
        '\n\n[System Info]\nCurrent Time: ' + nowStr +
        '\nUser: ' + (event.isMaster ? '主人 (Master)' : '訪客 (Guest)');

      if (relevantKnowledge && !relevantKnowledge.includes('沒有找到') && !relevantKnowledge.includes('尚無資料')) {
        systemContext += '\n\n[相關長期知識]:\n' + relevantKnowledge;
      }
      if (stm) {
        systemContext += '\n\n[短期記憶 / 當前脈絡]:\n' + stm;
      }
      systemContext +=
        '\n\n[工具使用準則]\n' +
        '- 資訊足夠時立即回覆，勿重複呼叫相同工具\n' +
        '- 使用者分享偏好、計畫或重要事實時，主動使用 rememberShortTerm 或 saveKnowledge 記下來';

      var contents = [];
      contents.push({ role: 'user',  parts: [{ text: systemContext }] });
      contents.push({ role: 'model', parts: [{ text: Prompt.ACKNOWLEDGEMENT }] });
      contents = contents.concat(history);
      contents.push({ role: 'user',  parts: [{ text: message }] });

      var toolDefinitions = Tools.getDefinitions();
      var maxTurns  = Config.TOOL_MAX_ITERATIONS || 3;
      var finalResponse = '';
      var lastToolResult = null;
      var calledTools = {};
      var startTime = new Date().getTime();
      var MAX_EXEC_MS = 270000; // 4.5 分鐘

      for (var turn = 0; turn < maxTurns; turn++) {
        if (new Date().getTime() - startTime > MAX_EXEC_MS) {
          Logger.warning('ChatBot.reply', 'GAS 執行接近時限，提前結束', 'Turn=' + turn);
          break;
        }

        var isLastTurn = (turn === maxTurns - 1);
        var apiOptions = { model: 'FAST', caller: 'ChatBot.reActLoop' };
        if (!isLastTurn) apiOptions.tools = toolDefinitions;

        var data = AIServiceFactory.callAPI(contents, apiOptions);
        if (!data || !data.candidates || !data.candidates[0]) {
          Logger.error('ChatBot.reply', '無效回應', data);
          break;
        }

        var candidate = data.candidates[0];
        var parts = (candidate.content && candidate.content.parts) || [];

        var textPart         = parts.find(p => p.text);
        var functionCallPart = parts.find(p => p.functionCall);

        // 工具呼叫
        if (functionCallPart && !isLastTurn) {
          var fc   = functionCallPart.functionCall;
          var name = fc.name;
          var args = fc.args || {};

          var callKey = name + '|' + JSON.stringify(args);
          var result;
          if (calledTools[callKey] !== undefined) {
            result = calledTools[callKey];
            Logger.info('ChatBot.reply', '使用快取工具結果: ' + name);
          } else {
            result = Tools.execute(name, args);
            calledTools[callKey] = result;
          }
          lastToolResult = result;

          contents.push({ role: 'model', parts: parts });
          contents.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: name,
                response: {
                  result: result + '\n\n（若資訊已足夠，請直接以繁體中文回覆，勿再呼叫工具。）'
                }
              }
            }]
          });
          continue;
        }

        // 文字回應
        if (textPart && textPart.text) {
          finalResponse = textPart.text;
          break;
        }

        break;
      }

      // 工具結果總結
      if (!finalResponse && lastToolResult) {
        contents.push({
          role: 'user',
          parts: [{ text: '（工具迴圈結束）請根據上述工具結果，用繁體中文給出最終回覆，不要再呼叫工具。' }]
        });
        var summary = AIServiceFactory.callAPI(contents, { model: 'FAST', caller: 'ChatBot.forceSummary' });
        finalResponse = Utils.extractText(summary) || '已完成查詢，但無法整理出完整回覆。';
      }

      if (!finalResponse) return '抱歉，我有點混亂，請再試一次。';

      // 儲存對話
      HistoryManager.saveMessage(userId, 'user', message);
      HistoryManager.saveMessage(userId, 'assistant', finalResponse);

      return finalResponse;
    } catch (error) {
      Logger.error('ChatBot.reply', '回覆失敗', error);
      return '抱歉，處理您的訊息時發生錯誤，請稍後再試。';
    }
  };

  return chatBot;
})();
