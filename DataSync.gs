/**
 * DataSync
 * @description 每日資產快照任務
 * 每天下午 18:00 由 Trigger 自動執行，將當日股價與現金部位寫入 @所有股票紀錄
 */

function setData() {
  var ss = SpreadsheetApp.openById(Config.SHEET_ID);
  var dashboardStocksSheet = ss.getSheetByName("面板");
  var allStocksSheet       = ss.getSheetByName("所有股票");
  var recordSheet          = ss.getSheetByName("@所有股票紀錄");

  // 一次讀取所有需要的股價
  var lastRow     = allStocksSheet.getLastRow();
  var stockPrices = allStocksSheet.getRange("G3:G" + lastRow).getValues();

  // 一次讀取所有現金部位
  var cashValues = dashboardStocksSheet.getRange("F1:F8").getValues();

  // 股票總價值
  var stockValue = dashboardStocksSheet.getRange("B3").getValue();

  var ktsValue      = cashValues[0][0]; // F1
  var ktcValue      = cashValues[1][0]; // F2
  var ktoUSAValue   = cashValues[2][0]; // F3
  var ktoJPValue    = cashValues[3][0]; // F4
  var fstcValue     = cashValues[4][0]; // F5
  var fstoUSAValue  = cashValues[5][0]; // F6
  var pstofficeValue= cashValues[6][0]; // F7
  var goldValue     = cashValues[7][0]; // F8

  // 準備日期與資料
  var today         = new Date();
  var dateFormatted = Utilities.formatDate(today, ss.getSpreadsheetTimeZone(), "yyyy-MM-dd");
  var currentLine   = recordSheet.getLastRow() + 1;

  // 動態計算總價值公式欄位範圍（A=日期, B=公式, C~=各股價, 之後=各項價值）
  var numStocks   = stockPrices.flat().length;
  var sumStartCol = 2 + numStocks + 1; // A(1) + B(1) + stockPrices + stockValue 從下一欄開始
  var sumEndCol   = sumStartCol + 8;   // stockValue + 8 個現金帳戶 = 9 欄
  var colToLetter = function(col) {
    var letter = '';
    while (col > 0) {
      var mod = (col - 1) % 26;
      letter = String.fromCharCode(65 + mod) + letter;
      col = Math.floor((col - 1) / 26);
    }
    return letter;
  };
  var totalValue = '=SUM(' + colToLetter(sumStartCol) + currentLine + ':' + colToLetter(sumEndCol) + currentLine + ')';

  var dataToRecord = [
    dateFormatted,
    totalValue,
    ...stockPrices.flat(),
    stockValue,
    ktsValue,
    ktcValue,
    ktoUSAValue,
    ktoJPValue,
    fstcValue,
    fstoUSAValue,
    pstofficeValue,
    goldValue
  ];

  recordSheet.getRange(currentLine, 1, 1, dataToRecord.length).setValues([dataToRecord]);
  Logger.info('setData', '每日資產快照完成', 'Date=' + dateFormatted);
}
