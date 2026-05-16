/**
 * AdvisorCheck
 * @description 主動顧問感知層：依 Trigger 執行，
 * 把 Snapshot + 決策 + 通知史餵給 LLM，由 LLM 判斷是否主動推送通知。
 *
 * 設計理念：
 *   - 程式碼負責「備料」與「短路檢查」
 *   - LLM 負責「判斷與表達」
 *   - alert_log 負責「去重與可追溯」
 */
var AdvisorCheck = (() => {
  var ac = {};

  /**
   * 統一入口：根據觸發來源跑完整檢查
   * @param {string} triggerSource - '10:00' / '14:00' / '18:00' / 'manual'
   */
  ac.run = (triggerSource) => {
    try {
      triggerSource = triggerSource || 'manual';

      // 週六日跳過（非交易日，盤中觸發無意義；18:00 也跳過以省 token）
      var dow = new Date().getDay();
      if (dow === 0 || dow === 6) {
        Logger.info('AdvisorCheck.run', '週末跳過', { source: triggerSource });
        return;
      }

      Logger.info('AdvisorCheck.run', '開始感知檢查', { source: triggerSource });

      // 1. 收集快照
      var snapshot = Snapshot.collectAll();

      // 2. 短路檢查：明顯平靜就跳過 LLM
      if (Snapshot.isQuiet(snapshot)) {
        Logger.info('AdvisorCheck.run', '短路通過：市場平靜，跳過 LLM', {
          dayChangePct: snapshot.totals && snapshot.totals.dayChangePct
        });
        return;
      }

      // 3. 讀全部決策（不用 keyword 搜尋，直接全餵）
      var decisions = ac._loadDecisions();

      // 4. 讀最近通知史（去重用）
      var recentAlerts = AlertLog.formatForPrompt(7);

      // 5. 組 prompt 呼叫 LLM
      var llmResult = ac._askLLM(snapshot, decisions, recentAlerts, triggerSource);
      if (!llmResult) {
        Logger.info('AdvisorCheck.run', 'LLM 無回應或解析失敗');
        return;
      }

      // 6. LLM 判斷無事
      if (!llmResult.shouldAlert) {
        Logger.info('AdvisorCheck.run', 'LLM 判定無需通知', { reason: llmResult.reason });
        return;
      }

      // 7. 推送
      var message = llmResult.message;
      if (!message) {
        Logger.warning('AdvisorCheck.run', 'LLM 判斷要通知但無訊息內容');
        return;
      }

      var masters = String(Config.ADMIN_STRING || '').split(',')
        .map(s => s.trim()).filter(s => s);
      masters.forEach(userId => Line.pushMsg(userId, message));

      // 8. 記錄到 alert_log
      var summary = ac._summarizeSnapshot(snapshot);
      AlertLog.record(triggerSource, llmResult.decisionRef || '', message, summary);

      Logger.info('AdvisorCheck.run', '通知已發送', {
        source: triggerSource,
        ref:    llmResult.decisionRef,
        len:    message.length
      });

    } catch (ex) {
      Logger.error('AdvisorCheck.run', '感知檢查失敗', ex);
    }
  };

  // ─── 內部 ──────────────────────────────────────────────────

  /**
   * 讀 knowledge sheet 中所有決策類條目
   * 慣例：tags 開頭含「決策」「目標」「偏好」「計畫」之一
   */
  ac._loadDecisions = () => {
    try {
      var sheet = SpreadsheetApp.openById(Config.SHEET_ID).getSheetByName('knowledge');
      if (!sheet) return [];
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
      var keywords = ['決策', '目標', '偏好', '計畫'];
      return data
        .filter(r => r[0] && r[1])
        .filter(r => keywords.some(k => String(r[0]).indexOf(k) >= 0 || String(r[1]).indexOf(k) >= 0))
        .map(r => ({
          tags:    String(r[0]),
          content: String(r[1]),
          updated: r[2] ? String(r[2]) : ''
        }));
    } catch (ex) {
      Logger.warning('AdvisorCheck._loadDecisions', '讀取決策失敗', ex.message);
      return [];
    }
  };

  /**
   * 組 prompt 呼叫 LLM，期待回傳 JSON
   */
  ac._askLLM = (snapshot, decisions, recentAlerts, triggerSource) => {
    var systemPrompt = Prompt.ADVISOR_PROMPT || '';

    var userPrompt =
      '【觸發時機】' + triggerSource + '\n\n' +
      '【目前財務快照】\n```json\n' +
      JSON.stringify(snapshot, null, 2) + '\n```\n\n' +
      '【主人的決策與偏好清單】\n' +
      (decisions.length === 0
        ? '（尚無記錄）'
        : decisions.map((d, i) => (i + 1) + '. [' + d.tags + '] ' + d.content).join('\n')
      ) + '\n\n' +
      '【最近 7 天已通知過的內容】\n' + recentAlerts + '\n\n' +
      '請依系統提示詞判斷，並回傳純 JSON：\n' +
      '{"shouldAlert": true/false, "decisionRef": "對應的決策標籤或空字串", ' +
      '"message": "通知訊息全文（若不通知則空）", "reason": "判斷理由（簡短，僅供日誌）"}';

    var contents = [
      { role: 'user',  parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: '了解，我會以財務顧問角度判斷並回傳 JSON。' }] },
      { role: 'user',  parts: [{ text: userPrompt }] }
    ];

    var response = AIServiceFactory.callAPI(contents, {
      model: 'SMART',
      caller: 'AdvisorCheck',
      temperature: 0.3
    });

    var text = Utils.extractText(response);
    if (!text) return null;

    return ac._parseJSON(text);
  };

  /**
   * 容錯 JSON 解析（LLM 可能會包 ```json ... ``` 或加額外文字）
   */
  ac._parseJSON = (text) => {
    try {
      var cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      var firstBrace = cleaned.indexOf('{');
      var lastBrace  = cleaned.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < 0) return null;
      var jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
      var obj = JSON.parse(jsonStr);
      return {
        shouldAlert: !!obj.shouldAlert,
        decisionRef: String(obj.decisionRef || ''),
        message:     String(obj.message || ''),
        reason:      String(obj.reason || '')
      };
    } catch (ex) {
      Logger.warning('AdvisorCheck._parseJSON', 'JSON 解析失敗', text.slice(0, 200));
      return null;
    }
  };

  /**
   * 為 alert_log 製作關鍵指標摘要（用於日後追溯為什麼通知）
   */
  ac._summarizeSnapshot = (s) => {
    var parts = [];
    if (s.totals) {
      parts.push('總資產 ' + s.totals.today +
        (s.totals.dayChangePct !== null ? ' (日 ' + (s.totals.dayChangePct * 100).toFixed(2) + '%)' : '')
      );
    }
    var movers = (s.holdings || [])
      .filter(h => h.dayChangePct !== null && Math.abs(h.dayChangePct) >= 0.02)
      .slice(0, 3)
      .map(h => h.code + ' ' + (h.dayChangePct * 100).toFixed(2) + '%');
    if (movers.length > 0) parts.push('異動: ' + movers.join(', '));
    return parts.join(' | ');
  };

  // ─── Trigger 入口（GAS Time-based Trigger 直接呼叫）────────

  ac.runMorning = () => ac.run('10:00');
  ac.runAfternoon = () => ac.run('14:00');
  ac.runEvening = () => ac.run('18:00');

  return ac;
})();

// ─── Trigger 入口：必須是頂層函式，GAS Time-based Trigger 才抓得到 ──

function advisorCheckMorning()   { AdvisorCheck.runMorning(); }
function advisorCheckAfternoon() { AdvisorCheck.runAfternoon(); }
function advisorCheckEvening()   { AdvisorCheck.runEvening(); }

/**
 * 手動測試入口（忽略週末跳過、忽略短路檢查、強制跑完整流程）
 * 在 GAS 編輯器選此函式執行，可直接看到 LLM 判斷結果
 */
function testAdvisorCheck() {
  try {
    Logger.info('testAdvisorCheck', '─── 手動測試開始 ───');

    var snapshot = Snapshot.collectAll();
    console.log('【Snapshot】');
    console.log(JSON.stringify(snapshot, null, 2));

    var quiet = Snapshot.isQuiet(snapshot);
    console.log('\n【短路檢查】isQuiet = ' + quiet);

    var decisions = AdvisorCheck._loadDecisions();
    console.log('\n【決策清單】共 ' + decisions.length + ' 條');
    decisions.forEach((d, i) => console.log((i + 1) + '. [' + d.tags + '] ' + d.content));

    var recentAlerts = AlertLog.formatForPrompt(7);
    console.log('\n【最近通知】\n' + recentAlerts);

    var llmResult = AdvisorCheck._askLLM(snapshot, decisions, recentAlerts, 'manual-test');
    console.log('\n【LLM 判斷】');
    console.log(JSON.stringify(llmResult, null, 2));

    if (llmResult && llmResult.shouldAlert) {
      console.log('\n→ 如果是正式執行，會推送下列訊息：\n' + llmResult.message);
      console.log('\n（測試模式不實際推送，如需推送請呼叫 advisorCheckEvening()）');
    }

    Logger.info('testAdvisorCheck', '─── 手動測試結束 ───');
  } catch (ex) {
    Logger.error('testAdvisorCheck', '測試失敗', ex);
    console.log('❌ 失敗：' + ex.message);
  }
}
