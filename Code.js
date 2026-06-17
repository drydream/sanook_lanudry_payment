var _props = PropertiesService.getScriptProperties().getProperties();
var ACCESS_TOKEN = _props['LINE_ACCESS_TOKEN'];
var FOLDER_ID = '14pP7z5eu5bwB9s5R9CYKS-zlpceXqxuw';
var REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
var PUSH_URL = 'https://api.line.me/v2/bot/message/push';
var GEMINI_API_KEY = _props['GEMINI_API_KEY'];
var SHEET_ID = '1w9ZuQED5dRuQsjbR2UtQ5tzO0hw4YBzsHFo-g5jxcpo';

// ===== รายชื่อโมเดลสำรอง (ลองทีละตัวจากบนลงล่าง) =====
// API key ตัวเดียวกันใช้ได้ทุกโมเดล / โควต้าฟรีนับแยกตามโมเดล
var MODEL_FALLBACK = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
];

// ===== Helper: แปลงปีให้เป็น ค.ศ. เสมอ (ป้องกัน Google Apps Script คืนค่า พ.ศ.) =====
function toCEYear(year) {
  return year > 2500 ? year - 543 : year;
}

// ===== Telegram backup notification =====
var TELEGRAM_BOT_TOKEN = _props['TELEGRAM_BOT_TOKEN'];
var TELEGRAM_CHAT_ID = _props['TELEGRAM_CHAT_ID'];

function sendTelegram(text) {
  try {
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === '#secret') return;
    var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
    UrlFetchApp.fetch(url, {
      'method': 'post',
      'contentType': 'application/json',
      'payload': JSON.stringify({
        'chat_id': TELEGRAM_CHAT_ID,
        'text': text,
        'parse_mode': 'HTML',
        'disable_web_page_preview': true
      }),
      'muteHttpExceptions': true
    });
  } catch (e) {
    Logger.log('sendTelegram error: ' + e);
  }
}

function buildTelegramText(slipData, savedData, dateTimeStr) {
  if (slipData) {
    var typeLabel = (slipData.type === 'bill_payment') ? 'จ่ายบิล' : 'โอนเงิน';
    var noteLine = slipData.note ? ('\n📝 บันทึก: ' + slipData.note) : '';
    return '✅ <b>ตรวจพบสลิป' + typeLabel + '</b>\n' +
      '💰 จำนวน: <b>' + (slipData.amount || '0.00') + '</b> บาท\n' +
      '📅 วันที่: ' + (slipData.date || '-') + '\n' +
      '⏰ เวลา: ' + (slipData.time || '-') + '\n' +
      '🏛 ธนาคาร: ' + (slipData.bankName || '-') + '\n' +
      '👤 ผู้รับ: ' + (slipData.receiverName || '-') +
      noteLine + '\n\n' +
      '🕒 อัปโหลด: ' + dateTimeStr + '\n' +
      '📂 <a href="' + savedData.url + '">เปิดใน Google Drive</a>';
  } else {
    return '📸 <b>บันทึกรูปภาพ</b>\n' +
      'ℹ️ ไม่ใช่สลิปโอนเงิน\n\n' +
      '🕒 อัปโหลด: ' + dateTimeStr + '\n' +
      '📂 <a href="' + savedData.url + '">เปิดใน Google Drive</a>';
  }
}

// ===== ข้อความแจ้งเตือนกรณีอ่านสลิปไม่สำเร็จ (API พลาด ไม่ใช่ "ไม่ใช่สลิป") =====
function buildErrorTelegramText(reason, savedData, dateTimeStr) {
  return '⚠️ <b>อ่านสลิปไม่สำเร็จ</b>\n' +
    '❗ เหตุ: ' + (reason || '-') + '\n' +
    'ℹ️ รูปถูกบันทึกไว้แล้ว ลองส่งใหม่อีกครั้งได้\n\n' +
    '🕒 อัปโหลด: ' + dateTimeStr + '\n' +
    '📂 <a href="' + savedData.url + '">เปิดใน Google Drive</a>';
}

function normalizeMessages(messagePayload) {
  if (Array.isArray(messagePayload)) return messagePayload;
  if (typeof messagePayload === 'string') return [{ 'type': 'text', 'text': messagePayload }];
  return [messagePayload];
}

function sendReply(replyToken, messagePayload) {
  try {
    UrlFetchApp.fetch(REPLY_URL, {
      'headers': {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': 'Bearer ' + ACCESS_TOKEN,
      },
      'method': 'post',
      'payload': JSON.stringify({
        'replyToken': replyToken,
        'messages': normalizeMessages(messagePayload)
      }),
      'muteHttpExceptions': true
    });
  } catch (e) {
    Logger.log('sendReply error: ' + e);
  }
}

function sendPush(to, messagePayload) {
  try {
    UrlFetchApp.fetch(PUSH_URL, {
      'headers': {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': 'Bearer ' + ACCESS_TOKEN,
      },
      'method': 'post',
      'payload': JSON.stringify({
        'to': to,
        'messages': normalizeMessages(messagePayload)
      }),
      'muteHttpExceptions': true
    });
  } catch (e) {
    Logger.log('sendPush error: ' + e);
  }
}

function getImage(id) {
  var url = 'https://api-data.line.me/v2/bot/message/' + id + '/content';
  var data = UrlFetchApp.fetch(url, {
    'headers': { 'Authorization': 'Bearer ' + ACCESS_TOKEN },
    'method': 'get',
    'muteHttpExceptions': true
  });
  if (data.getResponseCode() !== 200) {
    Logger.log('getImage error ' + data.getResponseCode() + ': ' + data.getContentText());
    throw new Error('LINE_FETCH_' + data.getResponseCode());
  }
  return data.getBlob().getAs('image/png').setName(Number(new Date()) + '.png');
}

function saveImage(blob) {
  try {
    var now = new Date();
    var year = toCEYear(now.getFullYear()).toString();
    var month = ('0' + (now.getMonth() + 1)).slice(-2);

    var rootFolder = DriveApp.getFolderById(FOLDER_ID);
    var yearFolders = rootFolder.getFoldersByName(year);
    var yearFolder = yearFolders.hasNext() ? yearFolders.next() : rootFolder.createFolder(year);
    var monthFolders = yearFolder.getFoldersByName(month);
    var monthFolder = monthFolders.hasNext() ? monthFolders.next() : yearFolder.createFolder(month);

    var file = monthFolder.createFile(blob);
    var fileId = file.getId();
    return {
      url: 'https://drive.google.com/file/d/' + fileId + '/view',
      id: fileId
    };
  } catch (e) {
    Logger.log('saveImage error: ' + e);
    return null;
  }
}

// ===== Gemini helpers: shared by serial (extractSlipData) and parallel (batch) paths =====
function buildGeminiRequest(blob, modelName) {
  var base64Image = Utilities.base64Encode(blob.getBytes());
  var mimeType = blob.getContentType() || 'image/png';
  var prompt =
    'Classify this image into exactly one of three categories and return the matching JSON.\n\n' +
    'CATEGORY 1 — BANKING SLIP: A digital screenshot from a Thai banking app (K+, SCB Easy, etc.) ' +
    'showing "โอนเงินสำเร็จ" (Transfer) or "จ่ายบิลสำเร็จ" (Bill Payment). ' +
    'Background graphics or watermarks do NOT disqualify it. Return:\n' +
    '{\n' +
    '  "isSlip": true,\n' +
    '  "date": "DD/MM/YYYY CE year. e.g. 3 มิ.ย. 69 = 2569 BE, subtract 543 = CE 2026 -> 03/06/2026",\n' +
    '  "time": "HH:MM",\n' +
    '  "bankName": "Sender bank (e.g. ธ.กสิกรไทย)",\n' +
    '  "receiverName": "Receiver or Biller name",\n' +
    '  "amount": "Numeric string without commas (e.g. 11683.60)",\n' +
    '  "type": "transfer or bill_payment",\n' +
    '  "note": "Memo if any, else empty string"\n' +
    '}\n\n' +
    'CATEGORY 2 — MACHINE CASH SUMMARY (เงินหลังเครื่อง): ' +
    'A document or image titled "เงินหลังเครื่อง" showing cash denomination breakdown ' +
    '(100 บาท, 50 บาท, 20 บาท amounts) and a grand total labeled "รวม". Return:\n' +
    '{"isSlip": false, "isMachineCash": true, "date": "DD/MM/YYYY CE year", ' +
    '"amount100": "numeric no commas", "amount50": "numeric no commas", ' +
    '"amount20": "numeric no commas", "total": "numeric no commas"}\n\n' +
    'CATEGORY 3 — NEITHER: Return ONLY {"isSlip": false}\n\n' +
    'Return ONLY raw JSON, no markdown formatting.';
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + modelName +
      ':generateContent?key=' + GEMINI_API_KEY,
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      'contents': [{
        'parts': [
          { 'inline_data': { 'mime_type': mimeType, 'data': base64Image } },
          { 'text': prompt }
        ]
      }],
      'safetySettings': [
        { 'category': 'HARM_CATEGORY_HARASSMENT', 'threshold': 'BLOCK_NONE' },
        { 'category': 'HARM_CATEGORY_HATE_SPEECH', 'threshold': 'BLOCK_NONE' },
        { 'category': 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'threshold': 'BLOCK_NONE' },
        { 'category': 'HARM_CATEGORY_DANGEROUS_CONTENT', 'threshold': 'BLOCK_NONE' }
      ]
    }),
    muteHttpExceptions: true
  };
}

// คืนค่า 3 แบบ: object (isSlip:true) / null (ไม่ใช่สลิป) / { error:true, reason } (API พลาด)
function parseGeminiResponse(response, modelName) {
  var code = response.getResponseCode();
  if (code !== 200) {
    Logger.log('[' + modelName + '] error: ' + code + ' ' + response.getContentText());
    return { error: true, reason: 'http_' + code };
  }
  var result;
  try { result = JSON.parse(response.getContentText()); } catch (e) {
    return { error: true, reason: 'json_parse' };
  }
  if (!result.candidates || !result.candidates.length || !result.candidates[0].content) {
    Logger.log('[' + modelName + '] blocked or empty');
    return { error: true, reason: 'blocked_or_empty' };
  }
  var text = result.candidates[0].content.parts[0].text;
  Logger.log('[' + modelName + '] raw: ' + text);
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { error: true, reason: 'no_json' };
  var data;
  try { data = JSON.parse(jsonMatch[0]); } catch (e) {
    return { error: true, reason: 'json_parse' };
  }
  if (!data.isSlip && !data.isMachineCash) return null;
  if (data.isMachineCash) {
    ['amount100', 'amount50', 'amount20', 'total'].forEach(function(k) {
      if (typeof data[k] === 'string') data[k] = data[k].replace(/,/g, '');
    });
    return data;
  }
  if (data.amount && typeof data.amount === 'string') data.amount = data.amount.replace(/,/g, '');
  return data;
}

// ===== เรียก Gemini หนึ่งโมเดล พร้อม retry =====
function extractSlipData(blob, modelName) {
  modelName = modelName || 'gemini-2.5-flash';
  try {
    var req = buildGeminiRequest(blob, modelName);
    var maxRetry = 3;
    var response;
    for (var i = 0; i < maxRetry; i++) {
      response = UrlFetchApp.fetch(req.url, req);
      var code = response.getResponseCode();
      Logger.log('[' + modelName + '] status (try ' + (i + 1) + '): ' + code);
      if (code === 200) break;
      if ((code === 429 || code === 500 || code === 502 || code === 503 || code === 504) && i < maxRetry - 1) {
        var waitMs = Math.pow(2, i + 1) * 1000;
        Logger.log('[' + modelName + '] transient ' + code + '. รอ ' + waitMs + 'ms แล้วลองใหม่...');
        Utilities.sleep(waitMs);
        continue;
      }
      Logger.log('[' + modelName + '] error body: ' + response.getContentText());
      return { error: true, reason: 'http_' + code };
    }
    if (response.getResponseCode() !== 200) return { error: true, reason: 'http_fail' };
    return parseGeminiResponse(response, modelName);
  } catch (e) {
    Logger.log('[' + modelName + '] extractSlipData error: ' + e);
    return { error: true, reason: 'exception:' + e };
  }
}

// ===== ตัวห่อ: ไล่ลองทีละโมเดลใน MODEL_FALLBACK =====
// คืนค่า: object สลิป / null (ไม่ใช่สลิปจริง) / { error:true, reason }
function extractSlipDataWithFallback(blob) {
  for (var m = 0; m < MODEL_FALLBACK.length; m++) {
    var result = extractSlipData(blob, MODEL_FALLBACK[m]);

    // อ่านสลิปได้สำเร็จ
    if (result && !result.error) return result;

    // ไม่ใช่สลิปจริง -> หยุดเลย ลองโมเดลอื่นก็ได้ผลเหมือนเดิม เปลืองโควต้าเปล่า
    if (result === null) return null;

    // error ชั่วคราว -> log แล้วเลื่อนไปลองโมเดลถัดไป
    Logger.log('Model ' + MODEL_FALLBACK[m] + ' failed: ' + result.reason + ' -> ลองตัวถัดไป');
  }
  // ลองครบทุกโมเดลแล้วยังพลาด
  Logger.log('ลองครบทุกโมเดลแล้วยังอ่านไม่สำเร็จ');
  return { error: true, reason: 'all_models_failed' };
}

function recordToSheet(slipData, fileUrl) {
  try {
    if (!slipData || typeof slipData !== 'object') {
      Logger.log('recordToSheet: slipData invalid');
      return;
    }

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('Payment');
    if (!sheet) {
      sheet = ss.insertSheet('Payment');
      sheet.appendRow(['Timestamp (GMT+7)', 'Date', 'Time', 'Bank Name', 'Receiver Name', 'Amount', 'Type', 'Note', 'File URL']);
    }

    var now = new Date();
    var offsetMs = 7 * 60 * 60 * 1000;
    var gmt7 = new Date(now.getTime() + offsetMs);
    var ts = toCEYear(gmt7.getUTCFullYear()) + '/' +
      ('0' + (gmt7.getUTCMonth() + 1)).slice(-2) + '/' +
      ('0' + gmt7.getUTCDate()).slice(-2) + ' ' +
      ('0' + gmt7.getUTCHours()).slice(-2) + ':' +
      ('0' + gmt7.getUTCMinutes()).slice(-2) + ':' +
      ('0' + gmt7.getUTCSeconds()).slice(-2);

    sheet.appendRow([
      ts,
      slipData.date || '',
      slipData.time || '',
      slipData.bankName || '',
      slipData.receiverName || '',
      slipData.amount || '',
      slipData.type || 'transfer',
      slipData.note || '',
      fileUrl || ''
    ]);
  } catch (e) {
    Logger.log('recordToSheet error: ' + e);
  }
}

function getGmt7DateTimeString() {
  var now = new Date();
  var offsetMs = 7 * 60 * 60 * 1000;
  var gmt7 = new Date(now.getTime() + offsetMs);
  return toCEYear(gmt7.getUTCFullYear()) + '/' +
    ('0' + (gmt7.getUTCMonth() + 1)).slice(-2) + '/' +
    ('0' + gmt7.getUTCDate()).slice(-2) + ' ' +
    ('0' + gmt7.getUTCHours()).slice(-2) + ':' +
    ('0' + gmt7.getUTCMinutes()).slice(-2);
}

function flexInfoRow(label, value) {
  return {
    "type": "box",
    "layout": "baseline",
    "spacing": "sm",
    "contents": [
      { "type": "text", "text": label, "size": "sm", "color": "#8c8c8c", "flex": 2 },
      { "type": "text", "text": value || "-", "size": "sm", "color": "#1a1a1a", "weight": "bold", "flex": 5, "wrap": true }
    ]
  };
}

function buildFooterButtons(savedData, dateTimeStr) {
  var encodedTime = encodeURIComponent(dateTimeStr);
  return [
    {
      "type": "button",
      "style": "secondary",
      "height": "sm",
      "action": { "type": "uri", "label": "📂 เปิดใน Google Drive", "uri": savedData.url }
    },
    {
      "type": "button",
      "style": "secondary",
      "color": "#ff4d4f",
      "height": "sm",
      "action": {
        "type": "postback",
        "label": "🗑️ ลบรูปนี้",
        "data": "action=deleteImage&fileId=" + savedData.id + "&time=" + encodedTime,
        "displayText": "ขอลบรูปที่อัปโหลดเมื่อ " + dateTimeStr
      }
    }
  ];
}

function buildSlipBubble(slipData, savedData, dateTimeStr) {
  var typeLabel = (slipData.type === 'bill_payment') ? '✅ ตรวจพบสลิปจ่ายบิล' : '✅ ตรวจพบสลิปโอนเงิน';

  var infoRows = [
    flexInfoRow("📅 วันที่", slipData.date),
    flexInfoRow("⏰ เวลา",   slipData.time),
    flexInfoRow("🏛 ธนาคาร", slipData.bankName),
    flexInfoRow("👤 ผู้รับ",  slipData.receiverName)
  ];

  if (slipData.note && slipData.note.trim() !== '') {
    infoRows.push(flexInfoRow("📝 บันทึก", slipData.note));
  }

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#06C755",
      "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": typeLabel, "color": "#ffffff", "weight": "bold", "size": "md" },
        { "type": "text", "text": "บันทึกเรียบร้อยแล้ว", "color": "#ffffff", "size": "xs", "margin": "xs" }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "md",
      "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "💰 " + (slipData.amount || '0.00') + " บาท", "weight": "bold", "size": "xxl", "color": "#06C755" },
        { "type": "separator", "margin": "md" },
        { "type": "box", "layout": "vertical", "spacing": "sm", "margin": "md", "contents": infoRows },
        { "type": "separator", "margin": "md" },
        { "type": "text", "text": "อัปโหลด: " + dateTimeStr, "size": "xxs", "color": "#aaaaaa", "margin": "md" }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "paddingAll": "12px",
      "contents": buildFooterButtons(savedData, dateTimeStr)
    }
  };
}

function buildNonSlipBubble(savedData, dateTimeStr) {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#3B82F6",
      "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "📸 บันทึกรูปภาพ", "color": "#ffffff", "weight": "bold", "size": "md" },
        { "type": "text", "text": "เก็บเข้า Google Drive แล้ว", "color": "#ffffff", "size": "xs", "margin": "xs" }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "ℹ️ ไม่ใช่สลิปโอนเงิน", "size": "sm", "color": "#8c8c8c" },
        { "type": "text", "text": "อัปโหลด: " + dateTimeStr, "size": "xxs", "color": "#aaaaaa", "margin": "sm" }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "paddingAll": "12px",
      "contents": buildFooterButtons(savedData, dateTimeStr)
    }
  };
}

// ===== Bubble กรณีอ่านสลิปไม่สำเร็จ (API พลาด ไม่ใช่ "ไม่ใช่สลิป") =====
function buildErrorBubble(savedData, dateTimeStr, reason) {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#F59E0B",
      "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "⚠️ อ่านสลิปไม่สำเร็จ", "color": "#ffffff", "weight": "bold", "size": "md" },
        { "type": "text", "text": "ระบบขัดข้องชั่วคราว", "color": "#ffffff", "size": "xs", "margin": "xs" }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "รูปถูกบันทึกไว้แล้ว แต่ยังอ่านข้อมูลสลิปไม่ได้", "size": "sm", "color": "#1a1a1a", "wrap": true },
        { "type": "text", "text": "👉 กรุณาส่งรูปนี้ใหม่อีกครั้ง", "size": "sm", "color": "#8c8c8c", "margin": "sm", "wrap": true },
        { "type": "text", "text": "เหตุ: " + (reason || '-'), "size": "xxs", "color": "#aaaaaa", "margin": "sm" },
        { "type": "text", "text": "อัปโหลด: " + dateTimeStr, "size": "xxs", "color": "#aaaaaa", "margin": "xs" }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "paddingAll": "12px",
      "contents": buildFooterButtons(savedData, dateTimeStr)
    }
  };
}

function recordMachineCashToSheet(data, fileUrl) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('เงินหลังเครื่อง');
    if (!sheet) {
      sheet = ss.insertSheet('เงินหลังเครื่อง');
      sheet.appendRow(['Timestamp (GMT+7)', 'Date', '100 บาท', '50 บาท', '20 บาท', 'รวม', 'File URL']);
    }
    var now = new Date();
    var gmt7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    var ts = toCEYear(gmt7.getUTCFullYear()) + '/' +
      ('0' + (gmt7.getUTCMonth() + 1)).slice(-2) + '/' +
      ('0' + gmt7.getUTCDate()).slice(-2) + ' ' +
      ('0' + gmt7.getUTCHours()).slice(-2) + ':' +
      ('0' + gmt7.getUTCMinutes()).slice(-2) + ':' +
      ('0' + gmt7.getUTCSeconds()).slice(-2);
    sheet.appendRow([ts, data.date || '', data.amount100 || '', data.amount50 || '', data.amount20 || '', data.total || '', fileUrl || '']);
  } catch (e) {
    Logger.log('recordMachineCashToSheet error: ' + e);
  }
}

function buildMachineCashTelegramText(data, savedData, dateTimeStr) {
  return '💵 <b>เงินหลังเครื่อง</b>\n' +
    '📅 วันที่: ' + (data.date || '-') + '\n' +
    '💴 100 บาท: ' + (data.amount100 || '0') + ' บ.\n' +
    '💵 50 บาท: ' + (data.amount50 || '0') + ' บ.\n' +
    '💶 20 บาท: ' + (data.amount20 || '0') + ' บ.\n' +
    '💰 รวม: <b>' + (data.total || '0') + '</b> บ.\n\n' +
    '🕒 อัปโหลด: ' + dateTimeStr + '\n' +
    '📂 <a href="' + savedData.url + '">เปิดใน Google Drive</a>';
}

function buildMachineCashBubble(data, savedData, dateTimeStr) {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#7C3AED",
      "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "💵 เงินหลังเครื่อง", "color": "#ffffff", "weight": "bold", "size": "md" },
        { "type": "text", "text": "บันทึกเรียบร้อยแล้ว", "color": "#ffffff", "size": "xs", "margin": "xs" }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "md",
      "paddingAll": "16px",
      "contents": [
        { "type": "text", "text": "💰 " + (data.total || '0') + " บาท", "weight": "bold", "size": "xxl", "color": "#7C3AED" },
        { "type": "separator", "margin": "md" },
        {
          "type": "box", "layout": "vertical", "spacing": "sm", "margin": "md",
          "contents": [
            flexInfoRow("📅 วันที่", data.date),
            flexInfoRow("💴 100 บาท", data.amount100 ? data.amount100 + ' บ.' : '-'),
            flexInfoRow("💵 50 บาท",  data.amount50  ? data.amount50  + ' บ.' : '-'),
            flexInfoRow("💶 20 บาท",  data.amount20  ? data.amount20  + ' บ.' : '-')
          ]
        },
        { "type": "separator", "margin": "md" },
        { "type": "text", "text": "อัปโหลด: " + dateTimeStr, "size": "xxs", "color": "#aaaaaa", "margin": "md" }
      ]
    },
    "footer": {
      "type": "box", "layout": "vertical", "spacing": "sm", "paddingAll": "12px",
      "contents": buildFooterButtons(savedData, dateTimeStr)
    }
  };
}

function processImageEventToBubble(event) {
  try {
    var img = getImage(event.message.id);
    Logger.log('img fetched: ' + img.getName());

    var imgForDrive  = img.copyBlob();
    var imgForGemini = img.copyBlob();

    var savedData   = saveImage(imgForDrive);
    var dateTimeStr = getGmt7DateTimeString();

    if (!savedData || !savedData.url) {
      Logger.log('saveImage failed');
      sendTelegram('❌ <b>บันทึกรูปล้มเหลว</b>\n🕒 ' + dateTimeStr);
      return null;
    }

    Logger.log('saveImage url: ' + savedData.url);
    var slipData = extractSlipDataWithFallback(imgForGemini);

    // กรณี 1: API พลาด -> แจ้งเตือนให้ส่งใหม่
    if (slipData && slipData.error) {
      sendTelegram(buildErrorTelegramText(slipData.reason, savedData, dateTimeStr));
      return buildErrorBubble(savedData, dateTimeStr, slipData.reason);
    }

    // กรณี 2: เงินหลังเครื่อง
    if (slipData && slipData.isMachineCash) {
      recordMachineCashToSheet(slipData, savedData.url);
      sendTelegram(buildMachineCashTelegramText(slipData, savedData, dateTimeStr));
      return buildMachineCashBubble(slipData, savedData, dateTimeStr);
    }

    // กรณี 3: สลิปโอนเงิน/จ่ายบิล
    if (slipData) {
      recordToSheet(slipData, savedData.url);
      sendTelegram(buildTelegramText(slipData, savedData, dateTimeStr));
      return buildSlipBubble(slipData, savedData, dateTimeStr);
    }

    // กรณี 4: ไม่ใช่ทั้งสอง
    sendTelegram(buildTelegramText(null, savedData, dateTimeStr));
    return buildNonSlipBubble(savedData, dateTimeStr);

  } catch (e) {
    Logger.log('processImageEventToBubble error: ' + e);
    sendTelegram('⚠️ <b>เกิดข้อผิดพลาด</b>\n' + e);
    return null;
  }
}

function wrapBubblesToFlex(bubbles) {
  if (bubbles.length === 1) {
    return { "type": "flex", "altText": "บันทึกรูปภาพเรียบร้อย", "contents": bubbles[0] };
  }
  return {
    "type": "flex",
    "altText": "บันทึกรูปภาพ " + bubbles.length + " รูป",
    "contents": { "type": "carousel", "contents": bubbles.slice(0, 12) }
  };
}

function getRecipientId(event) {
  if (event.source.type === 'group') return event.source.groupId;
  if (event.source.type === 'room')  return event.source.roomId;
  return event.source.userId;
}

function parsePostbackData(dataString) {
  var result = {};
  var pairs = dataString.split('&');
  for (var i = 0; i < pairs.length; i++) {
    var kv = pairs[i].split('=');
    result[kv[0]] = kv[1] || '';
  }
  return result;
}

function handleDeleteImagePostback(event, parsedData) {
  var fileId     = parsedData.fileId;
  var uploadTime = parsedData.time ? decodeURIComponent(parsedData.time) : '';

  if (!fileId) {
    sendReply(event.replyToken, "❌ ไม่พบ ID ของไฟล์");
    return;
  }

  try {
    var file = DriveApp.getFileById(fileId);
    if (file.isTrashed()) {
      sendReply(event.replyToken, "ℹ️ ไฟล์นี้ถูกลบไปก่อนหน้าแล้ว");
      return;
    }
    file.setTrashed(true);
    sendReply(event.replyToken, "🗑️ ลบรูปเรียบร้อยแล้ว");
    sendTelegram('🗑️ <b>ลบรูปแล้ว</b>\n🕒 อัปโหลดเมื่อ: ' + (uploadTime || '-'));
  } catch (err) {
    Logger.log('Delete error: ' + err);
    sendReply(event.replyToken, "❌ ไม่สามารถลบไฟล์ได้ (อาจถูกลบไปแล้ว)");
  }
}

// ===== ฟังก์ชันทดสอบ: ใส่ fileId รูปที่อยากเทสแล้วกด Run แล้วดู Executions log =====
function testWithImage() {
  var fileId = '1C9udtnII26JbaGxJvJ2M1FEvhaQUTYf5'; // เงินหลังเครื่อง sample
  var file   = DriveApp.getFileById(fileId);
  var blob   = file.getBlob().getAs('image/png');
  var slipData = extractSlipDataWithFallback(blob);
  Logger.log('slipData result: ' + JSON.stringify(slipData));
}

function testTelegram() {
  sendTelegram('🔔 <b>ทดสอบการเชื่อมต่อ</b>\nถ้าเห็นข้อความนี้แสดงว่าตั้งค่าถูกต้องแล้วครับ');
  Logger.log('Telegram test sent');
}

function doGet(e) {
  if (e.parameter && e.parameter.action) {
    return handleDashboardRequest(e.parameter);
  }
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

function handleDashboardRequest(body) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('เงินส่วนกลาง');
    if (body.action === 'add') {
      var now = new Date();
      var gmt7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      var ts = toCEYear(gmt7.getUTCFullYear()) + '/' +
        ('0' + (gmt7.getUTCMonth() + 1)).slice(-2) + '/' +
        ('0' + gmt7.getUTCDate()).slice(-2) + ' ' +
        ('0' + gmt7.getUTCHours()).slice(-2) + ':' +
        ('0' + gmt7.getUTCMinutes()).slice(-2) + ':' +
        ('0' + gmt7.getUTCSeconds()).slice(-2);
      var mIn = parseFloat(body.moneyIn) || 0;
      var mOut = parseFloat(body.moneyOut) || 0;
      sheet.appendRow([ts, body.date, mIn, mIn - mOut, body.description || '', mOut]);
    } else if (body.action === 'edit') {
      var row = parseInt(body.row);
      var mIn = parseFloat(body.moneyIn) || 0;
      var mOut = parseFloat(body.moneyOut) || 0;
      sheet.getRange(row, 2).setValue(body.date);
      sheet.getRange(row, 3).setValue(mIn);
      sheet.getRange(row, 4).setValue(mIn - mOut);
      sheet.getRange(row, 5).setValue(body.description || '');
      sheet.getRange(row, 6).setValue(mOut);
    } else if (body.action === 'delete') {
      sheet.deleteRow(parseInt(body.row));
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('handleDashboardRequest error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  Logger.log('doPost called');

  try {
    var body   = JSON.parse(e.postData.contents);

    if (body.action) {
      return handleDashboardRequest(body);
    }

    var events = body.events || [];
    Logger.log('events count: ' + events.length);

    var imageEvents     = [];
    var firstReplyToken = null;

    for (var i = 0; i < events.length; i++) {
      var event = events[i];

      if (event.type === 'message' && event.message && event.message.type === 'image') {
        if (!firstReplyToken) firstReplyToken = event.replyToken;
        imageEvents.push(event);
      } else if (event.type === 'postback') {
        var parsedData = parsePostbackData(event.postback.data);
        if (parsedData.action === 'deleteImage') {
          handleDeleteImagePostback(event, parsedData);
        }
      }
    }

    if (imageEvents.length > 0) {
      var bubbles = [];

      if (imageEvents.length === 1) {
        var bubble = processImageEventToBubble(imageEvents[0]);
        if (bubble) bubbles.push(bubble);
      } else {
        // ponytail: parallel primary model, serial fallback absorbs rate-limits
        // Phase 1: fetch all LINE images in parallel
        var lineRequests = imageEvents.map(function(ev) {
          return {
            url: 'https://api-data.line.me/v2/bot/message/' + ev.message.id + '/content',
            headers: { 'Authorization': 'Bearer ' + ACCESS_TOKEN },
            muteHttpExceptions: true
          };
        });
        var lineResponses = UrlFetchApp.fetchAll(lineRequests);
        var blobs = lineResponses.map(function(r) {
          if (r.getResponseCode() !== 200) {
            Logger.log('LINE batch fetch error: ' + r.getResponseCode() + ' ' + r.getContentText().substring(0, 100));
            return null;
          }
          return r.getBlob().getAs('image/png').setName(Number(new Date()) + '.png');
        });

        // Phase 2: Gemini calls in parallel (primary model, only for successful fetches)
        var primaryModel = MODEL_FALLBACK[0];
        var validIdxs = [], geminiReqsToSend = [];
        blobs.forEach(function(b, i) {
          if (b) { validIdxs.push(i); geminiReqsToSend.push(buildGeminiRequest(b.copyBlob(), primaryModel)); }
        });
        var geminiRespMap = {};
        if (geminiReqsToSend.length > 0) {
          UrlFetchApp.fetchAll(geminiReqsToSend).forEach(function(r, i) {
            geminiRespMap[validIdxs[i]] = r;
          });
        }

        // Phase 3: Drive save + bubble per image (sequential — Drive has no fetchAll)
        var batchDateTimeStr = getGmt7DateTimeString();
        for (var j = 0; j < imageEvents.length; j++) {
          try {
            var blob = blobs[j];
            if (!blob) {
              Logger.log('Batch image ' + j + ' LINE fetch failed, skipping');
              continue;
            }
            var slipData = geminiRespMap[j]
              ? parseGeminiResponse(geminiRespMap[j], primaryModel)
              : { error: true, reason: 'LINE_FETCH_FAILED' };

            // transient error → fall back to full serial retry/model-fallback
            if (slipData && slipData.error) {
              Logger.log('Batch fallback image ' + j + ': ' + slipData.reason);
              slipData = extractSlipDataWithFallback(blob.copyBlob());
            }

            var savedData = saveImage(blob.copyBlob());
            if (!savedData || !savedData.url) {
              sendTelegram('❌ <b>บันทึกรูปล้มเหลว</b>\n🕒 ' + batchDateTimeStr);
              continue;
            }

            var bub;
            if (slipData && slipData.error) {
              sendTelegram(buildErrorTelegramText(slipData.reason, savedData, batchDateTimeStr));
              bub = buildErrorBubble(savedData, batchDateTimeStr, slipData.reason);
            } else if (slipData && slipData.isMachineCash) {
              recordMachineCashToSheet(slipData, savedData.url);
              sendTelegram(buildMachineCashTelegramText(slipData, savedData, batchDateTimeStr));
              bub = buildMachineCashBubble(slipData, savedData, batchDateTimeStr);
            } else if (slipData) {
              recordToSheet(slipData, savedData.url);
              sendTelegram(buildTelegramText(slipData, savedData, batchDateTimeStr));
              bub = buildSlipBubble(slipData, savedData, batchDateTimeStr);
            } else {
              sendTelegram(buildTelegramText(null, savedData, batchDateTimeStr));
              bub = buildNonSlipBubble(savedData, batchDateTimeStr);
            }
            if (bub) bubbles.push(bub);
          } catch (imgErr) {
            Logger.log('Batch image ' + j + ' error: ' + imgErr);
            sendTelegram('⚠️ <b>เกิดข้อผิดพลาด</b> (รูปที่ ' + (j + 1) + ')\n' + imgErr);
          }
        }
      }

      if (bubbles.length > 0) {
        sendReply(firstReplyToken, wrapBubblesToFlex(bubbles));
      }
    }

  } catch (err) {
    Logger.log('doPost fatal error: ' + err);
    sendTelegram('⚠️ <b>doPost fatal error</b>\n' + err);
  }

  return ContentService.createTextOutput(JSON.stringify({ 'content': 'post ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}