/**
 * DevTools
 * @description 所有「在 GAS 編輯器下拉選單手動執行」的進入點，一律集中在這裡
 *
 * 為什麼集中：編輯器的函式下拉選單是扁平的，**不顯示函式定義在哪個檔案**。
 * 散在十個檔案裡時，想跑某支診斷函式卻找不到它在哪，要改也不知道從哪改起。
 *
 * ⚠️ 兩類頂層函式**不可以**搬進來 —— 它們是被名稱綁定的，改名或搬走會靜默失效：
 *
 *   Trigger 進入點   setData / dailyReport / weeklyReport / monthlyReport /
 *                    marketAlert / dailyCleanUp / advisorCheckEvening
 *   Web 進入點       doPost / doGet / dashboardData / miniAppData / miniAppAsk
 *
 * 這裡的每支函式都只做「呼叫模組 + 印結果」，邏輯留在各自的模組裡。
 */

// ─── 系統 ─────────────────────────────────────────────────────────

/**
 * 列出目前所有已註冊的 Trigger。
 * 刪除任何 trigger 進入點之前先跑這支：手動在觸發條件頁面建的 trigger
 * 不會出現在 setupAllTriggers() 的程式碼裡，指向不存在的函式會每天靜默失敗。
 */
function listTriggers() {
  var ts = ScriptApp.getProjectTriggers();
  console.log('共 ' + ts.length + ' 個 Trigger：');
  // ⚠️ getEventType() 回傳列舉物件，直接丟進 console.log 會展開成上百行的
  //    循環結構把記錄擠爆。一定要 String() 轉成字串。
  ts.forEach(t => console.log('  ' + t.getHandlerFunction() + '  |  ' + String(t.getEventType())));
  return ts.map(t => t.getHandlerFunction());
}

/**
 * 初始化系統（首次部署時執行）
 * - 確認試算表各工作表已建立
 * - 列印環境變數狀態
 */
function setup() {
  var requiredSheets = ['env', 'consolelog', 'chat', 'short_term_memory', 'knowledge', 'alert_log'];
  var ss = SpreadsheetApp.openById(Config.SHEET_ID);

  requiredSheets.forEach(name => {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      console.log('⚠️  缺少工作表: ' + name + '，請手動建立。');
    } else {
      console.log('✅  工作表存在: ' + name);
    }
  });

  console.log('--- 環境變數 ---');
  console.log('LINE_CHANNEL_TOKEN:  ' + (Config.LINE_CHANNEL_TOKEN  ? '已設定' : '（選用）'));
  console.log('LINE_CHANNEL_SECRET: ' + (Config.LINE_CHANNEL_SECRET ? '已設定' : '（選用）'));
  console.log('TELEGRAM_API_KEY:    ' + (Config.TELEGRAM_API_KEY    ? '已設定' : '（選用）'));
  console.log('SHEET_ID:            ' + (Config.SHEET_ID            ? '已設定' : '❌ 未設定'));
  console.log('ADMIN_STRING:        ' + (Config.ADMIN_STRING        ? '已設定' : '❌ 未設定'));
  console.log('GEMINI_API_KEY:      ' + (Config.GEMINI_API_KEY      ? '已設定' : '（選用）'));
  console.log('NVIDIA_API_KEY:      ' + (Config.NVIDIA_API_KEY      ? '已設定' : '（選用）'));
  console.log('AI_PROVIDER:         ' + Config.AI_PROVIDER + '  ← env!B3 控制（GEMINI 或 NVIDIA）');
  console.log('DEBUG_MODE:          ' + Config.DEBUG_MODE + '  ← env!B2 控制');
}

/**
 * 重建所有系統 Trigger（首次部署或重設時執行一次）
 * ⚠️ 會先清除**所有**既有 Trigger 再重建，手動建過的也會一起消失。
 */
function setupAllTriggers() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(t => ScriptApp.deleteTrigger(t));
    Logger.info('setupAllTriggers', '已清除 ' + triggers.length + ' 個舊 Trigger');

    // 每日 04:00 — 記憶清理
    ScriptApp.newTrigger('dailyCleanUp').timeBased().atHour(4).everyDays(1).create();

    // 每日 09:00 — 財經早報
    ScriptApp.newTrigger('dailyReport').timeBased().atHour(9).everyDays(1).create();

    // 每日 10:00 / 14:00 — 盤中警報
    ScriptApp.newTrigger('marketAlert').timeBased().atHour(10).everyDays(1).create();
    ScriptApp.newTrigger('marketAlert').timeBased().atHour(14).everyDays(1).create();

    // 每週六 09:00 — 週報
    ScriptApp.newTrigger('weeklyReport').timeBased()
      .onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(9).create();

    // 每月 1 日 10:00 — 月報（避開早報的 09:00）
    ScriptApp.newTrigger('monthlyReport').timeBased().onMonthDay(1).atHour(10).create();

    // 每日 18:00 — 資產快照
    ScriptApp.newTrigger('setData').timeBased().atHour(18).everyDays(1).create();

    // 每日 19:00 — 主動顧問感知（等 setData 寫完快照；atHour 是 1 小時窗口不是精準時間，
    // 所以留 1 小時 buffer）
    ScriptApp.newTrigger('advisorCheckEvening').timeBased().atHour(19).everyDays(1).create();

    console.log('✅ Trigger 設定完成：');
    console.log('   每日 04:00 → dailyCleanUp');
    console.log('   每日 09:00 → dailyReport');
    console.log('   每日 10:00 → marketAlert');
    console.log('   每日 14:00 → marketAlert');
    console.log('   每週六 09:00 → weeklyReport');
    console.log('   每月 1 日 10:00 → monthlyReport');
    console.log('   每日 18:00 → setData');
    console.log('   每日 19:00 → advisorCheckEvening');
  } catch (ex) {
    Logger.error('setupAllTriggers', '設定 Trigger 失敗', ex);
    console.log('❌ 設定失敗：' + ex.message);
  }
}

/**
 * 註冊 Telegram webhook。
 * ⚠️ 網址寫死成固定部署的 /exec，不用 ScriptApp.getService().getUrl() ——
 * 後者從編輯器執行時會回傳 /dev，那個需要 Google 登入，Telegram 打不進來。
 */
function setupTelegramWebhook() {
  var WEB_APP_URL = 'https://script.google.com/macros/s/' +
    'AKfycbxN-6Yx2GEiLvyBIeZ9z0CyZPbUuBXMyoD6xtN3j_XOc38_S2OBrOonVPaxXM4NVRcI' + '/exec';
  console.log('註冊 webhook → ' + WEB_APP_URL);
  console.log(Telegram.setupWebhook(WEB_APP_URL));
}

/** 註冊 Telegram 斜線指令選單。**新增或改名指令後一定要跑這支一次。** */
function setupTelegramCommands() {
  console.log('註冊指令選單：' + JSON.stringify(Commands.getDefinitions()));
  console.log(Telegram.setupCommands());
}

// ─── 每日快照 ─────────────────────────────────────────────────────

/** 只檢查不寫入：今天的快照會寫幾列、狀態是什麼 */
function verifySnapshot() {
  var report = DataSync.verify();
  console.log(report);
  return report;
}

/** 預覽今天 setData 會寫的那一列，不寫入。 */
function dryRunSetData() {
  var result = DataSync.run({ dryRun: true });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ─── 新表：資產管理 ───────────────────────────────────────────────
//
// 首次建置順序：setupAssetSheet → migrateLegacyData → rebuildPositions → verifyAssetSheet
// 四支都是冪等的，重跑不會疊加。

/** 步驟 1：在「資產管理」試算表建立／補齊所有分頁與公式 */
function setupAssetSheet() {
  var r = AssetSchema.build();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

/** 步驟 2：從舊表遷移標的／帳戶／實體資產／交易／每日快照 */
function migrateLegacyData() {
  var r = AssetMigrate.run();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

/** 步驟 3：從「交易」重算持倉、已實現損益、現金、配置、面板 */
function rebuildPositions() {
  var r = Position.rebuild();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

/** 步驟 4：逐項比對新舊兩張表的股數、成本、累計股利、帳戶餘額 */
function verifyAssetSheet() {
  var report = AssetMigrate.verify();
  console.log(report);
  return report;
}

// ─── 儀表板 / 顧問 ────────────────────────────────────────────────

/**
 * 看 doGet 的權限閘門實際拿到什麼身分。
 * 儀表板顯示 Not Found 時先跑這支：activeUser 是空字串代表 Google 沒把
 * 使用者身分交給這次執行 —— 通常是開了 /exec（匿名部署）而不是 /dev，
 * 或是新增 scope 之後還沒重新授權。
 */
function checkDashboardAuth() {
  var active    = '';
  var effective = '';
  try { active    = Session.getActiveUser().getEmail(); }    catch (e) { active    = '（拋錯：' + e.message + '）'; }
  try { effective = Session.getEffectiveUser().getEmail(); } catch (e) { effective = '（拋錯：' + e.message + '）'; }

  console.log('activeUser（存取者）  : ' + (active    || '（空字串）'));
  console.log('effectiveUser（執行者）: ' + (effective || '（空字串）'));
  console.log('isAuthorized          : ' + Dashboard.isAuthorized());
}

/**
 * AdvisorCheck 的手動測試入口：忽略週末跳過與短路檢查，跑完整流程但**不推播**。
 * 要真的推播請執行 advisorCheckEvening()。
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
      console.log('\n（測試模式不實際推送）');
    }

    Logger.info('testAdvisorCheck', '─── 手動測試結束 ───');
  } catch (ex) {
    Logger.error('testAdvisorCheck', '測試失敗', ex);
    console.log('❌ 失敗：' + ex.message);
  }
}
