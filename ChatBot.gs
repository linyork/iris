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
      var now = new Date();
      var nowStr = Utilities.formatDate(now, 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
      var todayStr = Utilities.formatDate(now, 'GMT+8', 'yyyy-MM-dd');
      var currentYear = Utilities.formatDate(now, 'GMT+8', 'yyyy');

      // 讀取短期記憶與知識（搜尋與當前訊息相關的知識）
      var stm               = GoogleSheet.getValidShortTermMemories();
      var relevantKnowledge = GoogleSheet.searchKnowledge(message);

      Logger.info('ChatBot.reply', '記憶注入', {
        stm:       stm ? stm.split('\n').length + ' 筆 STM' : '無',
        knowledge: (relevantKnowledge && !relevantKnowledge.includes('沒有找到') && !relevantKnowledge.includes('尚無資料'))
                   ? relevantKnowledge.slice(0, 60) + '...' : '無相關知識'
      });

      var systemContext = Config.SYSTEM_PROMPT +
        '\n\n[System Info]\nCurrent Time: ' + nowStr +
        '\nToday: ' + todayStr + '（今天的日期，年份為 ' + currentYear + '）' +
        '\nUser: ' + (event.isMaster ? '主人 (Master)' : '訪客 (Guest)') +
        '\n\n[重要：日期與年份規則]\n' +
        '- 凡是查詢「今日/最近/本週/近期」相關資訊（如 searchWeb），必須使用上方 Today 的實際年份 ' + currentYear + '\n' +
        '- 禁止在查詢字串或回覆內容中自行假設、寫死、沿用其他年份\n' +
        '- 工具回傳結果若日期與 Today 不符（例如撈到去年同日新聞），須誠實告知主人「未取得當日資訊」，不可當成今日資訊呈現';

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
      var elapsed   = () => new Date().getTime() - startTime;
      var timedOut  = false;

      // 時間預算：GAS 硬上限為 6 分鐘（360s），超過會被直接砍掉。
      // 被砍掉的後果比中途放棄嚴重得多 —— doPost 來不及回 200，平台會重送 webhook，
      // 但去重快取在處理前就寫入了，重送會被擋掉，使用者最後什麼都收不到（靜默失敗）。
      // 因此兩道關卡都往前抓，寧可少跑一輪也要留時間把話講完：
      var NEW_TURN_DEADLINE_MS  = 200000; // 200s 後不再開新一輪（單輪思考可能要 60~90s）
      var TAIL_CALL_DEADLINE_MS = 280000; // 280s 後不再做補救型 API 呼叫，留 80s 收尾

      for (var turn = 0; turn < maxTurns; turn++) {
        if (elapsed() > NEW_TURN_DEADLINE_MS) {
          Logger.warning('ChatBot.reply', 'GAS 執行接近時限，提前結束',
            'Turn=' + turn + ' Elapsed=' + elapsed() + 'ms');
          timedOut = true;
          break;
        }

        // 續命「正在輸入…」：Telegram 的 typing 狀態只維持約 5 秒，而單輪 LLM 呼叫
        // 遠比這久（M2.7 時代實測 74~77 秒；改用關思考的 deepseek-v4-flash 後大幅縮短，
        // 但過載重試與備援接手仍可能拉長）。不每輪重送的話，使用者會看到提示閃一下
        // 就消失、接著長時間全無動靜，觀感等同當機。
        MessagingServiceFactory.indicateTyping(event);

        var isLastTurn = (turn === maxTurns - 1);
        Logger.info('ChatBot.reply', 'ReAct Turn ' + turn, {
          isLastTurn: isLastTurn,
          contextTurns: contents.length
        });

        var apiOptions = { model: 'FAST', caller: 'ChatBot.reActLoop' };
        if (!isLastTurn) apiOptions.tools = toolDefinitions;

        var data = AIServiceFactory.callAPI(contents, apiOptions);
        if (!data || !data.candidates || !data.candidates[0]) {
          Logger.error('ChatBot.reply', '無效回應', data);
          break;
        }

        var candidate    = data.candidates[0];
        var finishReason = candidate.finishReason || 'UNKNOWN';
        var parts        = (candidate.content && candidate.content.parts) || [];

        var textPart          = parts.find(p => p.text);
        var functionCallParts = parts.filter(p => p.functionCall);

        Logger.info('ChatBot.reply', 'Turn ' + turn + ' 回應', {
          finishReason:  finishReason,
          toolCallCount: functionCallParts.length,
          toolNames:     functionCallParts.map(p => p.functionCall.name),
          hasText:       !!textPart
        });

        // 工具呼叫 —— 模型可能一次要求多個（M2.7 很常平行丟出好幾個 searchWeb）。
        // 舊版只取第一個、其餘丟棄，模型下一輪得重問一次，等於白白多燒一輪 75 秒的思考。
        // 這裡全部執行，回應順序必須與呼叫順序一致，AIAdapter 靠順序配對 tool_call_id。
        if (functionCallParts.length > 0 && !isLastTurn) {
          var responseParts = [];

          functionCallParts.forEach((p, i) => {
            var fc   = p.functionCall;
            var name = fc.name;
            var args = fc.args || {};

            var callKey = name + '|' + JSON.stringify(args);
            var result;
            if (calledTools[callKey] !== undefined) {
              result = calledTools[callKey];
              Logger.info('ChatBot.reply', '使用快取工具結果: ' + name);
            } else {
              Logger.info('ChatBot.reply', '呼叫工具', { name: name, args: args });
              result = Tools.execute(name, args);
              calledTools[callKey] = result;
              Logger.info('ChatBot.reply', '工具回傳', {
                name:   name,
                length: String(result).length,
                preview: String(result).slice(0, 100)
              });
            }
            lastToolResult = result;

            // 收斂提示只掛在最後一筆，避免同一輪內重複疊加同樣的句子
            var isLastCall = (i === functionCallParts.length - 1);
            responseParts.push({
              functionResponse: {
                name: name,
                response: {
                  result: result + (isLastCall
                    ? '\n\n（若資訊已足夠，請直接以繁體中文回覆，勿再呼叫工具。）'
                    : '')
                }
              }
            });
          });

          contents.push({ role: 'model', parts: parts });
          contents.push({ role: 'user', parts: responseParts });
          continue;
        }

        // 文字回應
        if (textPart && textPart.text) {
          finalResponse = textPart.text;
          break;
        }

        break;
      }

      Logger.info('ChatBot.reply', 'ReAct 迴圈結束', {
        finalResponse: !!finalResponse,
        totalTurns:    turn,
        timedOut:      timedOut,
        elapsedMs:     elapsed()
      });

      // 工具結果總結
      if (!finalResponse && lastToolResult) {
        if (elapsed() > TAIL_CALL_DEADLINE_MS) {
          // 沒時間再叫一次模型了。資料其實已經拿到，與其硬跑總結而被 GAS 砍掉、
          // 讓使用者什麼都收不到，不如直接把原始工具結果交出去。
          Logger.warning('ChatBot.reply', '時間不足，略過總結呼叫，直接回傳工具結果',
            'Elapsed=' + elapsed() + 'ms');
          finalResponse = '（這次查詢花的時間比預期久，來不及整理，先把原始結果給你）\n\n' + lastToolResult;
        } else {
          // 迴圈是因為逾時才結束的，代表已經等很久了，而總結呼叫還要再等一輪思考。
          // 先送一則實體訊息（不是只有 5 秒的 typing 狀態）出去：萬一收尾階段真的
          // 被 GAS 砍掉，使用者至少知道發生什麼事，而不是對著空氣等一則永遠不會來的回覆。
          if (timedOut) {
            MessagingServiceFactory.reply(event, '（這次要查的東西有點多，還在整理，再稍等一下…）');
          }
          MessagingServiceFactory.indicateTyping(event);
          contents.push({
            role: 'user',
            parts: [{ text: '（工具迴圈結束）請根據上述工具結果，用繁體中文給出最終回覆，不要再呼叫工具。' }]
          });
          var summary = AIServiceFactory.callAPI(contents, { model: 'FAST', caller: 'ChatBot.forceSummary' });
          finalResponse = Utils.extractText(summary) || '已完成查詢，但無法整理出完整回覆。';
        }
      }

      if (!finalResponse) {
        return timedOut
          ? '這次查詢花的時間超過我的處理上限，已經先停下來了。請再問一次，或把問題範圍縮小一點。'
          : '抱歉，我有點混亂，請再試一次。';
      }

      // 清除模型誤輸出的 <tool_call> XML（GLM-5.1 在最後一輪有時會用 XML 格式輸出工具呼叫）
      var cleanedResponse = Utils.stripToolCallXml(finalResponse);
      if (!cleanedResponse && finalResponse) {
        // 整個回覆都是 XML，強制要求文字回覆
        if (elapsed() > TAIL_CALL_DEADLINE_MS) {
          Logger.warning('ChatBot.reply', '時間不足，略過 XML 重試', 'Elapsed=' + elapsed() + 'ms');
          cleanedResponse = '抱歉，這次沒能整理出可讀的回覆，請再問一次。';
        } else {
          Logger.warning('ChatBot.reply', '偵測到純 XML 工具呼叫回應，強制重新取得文字', finalResponse.slice(0, 100));
          MessagingServiceFactory.indicateTyping(event);
          contents.push({
            role: 'user',
            parts: [{ text: '請直接用繁體中文文字回答，不要輸出任何 XML 或工具呼叫格式。' }]
          });
          var retryResp = AIServiceFactory.callAPI(contents, { model: 'FAST', caller: 'ChatBot.xmlRetry' });
          cleanedResponse = Utils.extractText(retryResp) || '抱歉，我有點混亂，請再試一次。';
        }
      }
      finalResponse = Utils.formatForLine(cleanedResponse || finalResponse);

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
