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

      // 取得對話歷史，轉成 Gemini 的 contents 形狀（NVIDIA 路徑由 AIAdapter 再轉一次）
      var history = GoogleSheet.getChatHistory(userId, Config.CHAT_MAX_TURNS * 2)
        .map(r => ({
          role:  r.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: r.message }]
        }));

      // 讀取短期記憶與知識（搜尋與當前訊息相關的知識）
      var stm               = GoogleSheet.getValidShortTermMemories();
      var relevantKnowledge = GoogleSheet.searchKnowledge(message);

      Logger.info('ChatBot.reply', '記憶注入', {
        stm:       stm ? stm.split('\n').length + ' 筆 STM' : '無',
        knowledge: (relevantKnowledge && !/沒有找到|尚無資料/.test(relevantKnowledge))
                   ? relevantKnowledge.slice(0, 60) + '...' : '無相關知識'
      });

      var systemContext = Prompt.systemContext({
        scope:     '回覆',
        user:      event.isMaster ? '主人 (Master)' : '訪客 (Guest)',
        knowledge: relevantKnowledge,
        stm:       stm
      });

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
      var wroteViaTool   = false;  // 這一輪有沒有真的執行過寫入工具（見 Utils.claimsWriteDone）
      var claimCorrected = false;  // 攔截只做一次，避免模型跟提示詞互相頂到把輪數燒光
      var elapsed  = () => Utils.execElapsedMs();
      var timedOut = false;

      // 時間預算：GAS 硬上限為 6 分鐘（360s），超過會被直接砍掉。
      // 被砍掉的後果比中途放棄嚴重得多 —— doPost 來不及回 200，平台會重送 webhook，
      // 但去重快取在處理前就寫入了，重送會被擋掉，使用者最後什麼都收不到（靜默失敗）。
      // 因此兩道關卡都往前抓，寧可少跑一輪也要留時間把話講完：
      var NEW_TURN_DEADLINE_MS  = 200000; // 200s 後不再開新一輪（單輪思考可能要 60~90s）
      var TAIL_CALL_DEADLINE_MS = 280000; // 280s 後不再做補救型 API 呼叫，留 80s 收尾

      // ⚠️ 錶要跟底下兩層同一支：`Utils.execElapsedMs()` 從**檔案載入**起算，
      // 那才是本次執行的真正起點。以前這裡自己 `new Date()` 從進 reply() 起算，
      // 於是「280s + 留 80s 收尾 = 360s」這個算式少掉了前面那一段 —— GAS 載入
      // 三十個 .gs、doPost 去重、checkMaster、一次 indicateTyping，走 miniAppAsk
      // 還要多一次驗簽與一次 push。少多少沒人量過，而 NvidiaService 與
      // AIServiceFactory 判斷「還夠不夠再打一次」用的一直都是 Utils 這支錶。
      // 同一次執行裡有兩個對剩餘時間意見不同的來源，正是 Utils 那段註解要消滅的。

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
            if (Tools.isWrite(name)) wroteViaTool = true;
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
          // 「說做完了，但一個寫入工具都沒叫過」—— 把話打回去，讓它在還有工具可用的
          // 這一輪去執行。這裡不直接改寫模型的字：改字只是把那句話藏起來，帳一樣沒記。
          if (!wroteViaTool && !claimCorrected && !isLastTurn &&
              Utils.claimsWriteDone(textPart.text)) {
            claimCorrected = true;
            Logger.warning('ChatBot.reply', '宣稱已完成但沒有呼叫寫入工具，打回重做',
              textPart.text.slice(0, 120));
            contents.push({ role: 'model', parts: parts });
            contents.push({ role: 'user', parts: [{ text:
              '（系統攔截）你剛才說已經完成了，但這一輪沒有任何寫入工具被執行 —— ' +
              '帳本一個字都沒有改到。\n' +
              '若主人要的是記錄／校正／作廢／建帳戶，現在立刻呼叫對應的工具，不要再問一次確認：' +
              '參數齊全就直接寫，工具回傳的結果才是確認，寫錯了還能用 voidTrade 撤銷。\n' +
              '若這件事本來就不需要寫入，請重新回覆一次，並且不要用「已記錄／已校正／已完成」這類說法。'
            }] });
            continue;
          }
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

      // 清除模型誤輸出的 <tool_call> XML —— 最後一輪沒有掛工具，有些模型會改用
      // 文字形式把工具呼叫「講」出來。這道清理不綁任何特定模型（當初是 GLM-5.1
      // 撞出來的，那顆早就換掉了），換模型時不必重新評估，留著就對了。
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

      // 打回去之後還是那樣講（或根本沒機會打回去 —— 最後一輪沒有工具可用），
      // 那就至少不要讓主人以為記好了。這裡用加註而不是整段換掉：萬一是誤判
      // （模型只是在轉述查詢結果），原本的內容還在，加註本身也仍然是實話。
      if (!wroteViaTool && Utils.claimsWriteDone(finalResponse)) {
        Logger.error('ChatBot.reply', '宣稱已完成但整輪都沒有寫入工具，加註警告',
          finalResponse.slice(0, 200));
        finalResponse =
          '⚠️ 底下這段話我沒有真的寫進帳本 —— 這一輪沒有任何寫入工具被執行。\n' +
          '如果你要的是記錄／校正／作廢，請再講一次，我會實際執行。\n\n' + finalResponse;
      }

      // 儲存對話
      GoogleSheet.saveChatMessage(userId, 'user', message);
      GoogleSheet.saveChatMessage(userId, 'assistant', finalResponse);

      return finalResponse;
    } catch (error) {
      Logger.error('ChatBot.reply', '回覆失敗', error);
      return '抱歉，處理您的訊息時發生錯誤，請稍後再試。';
    }
  };

  return chatBot;
})();
