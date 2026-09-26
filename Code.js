var _scriptProperties = PropertiesService.getScriptProperties();
var _props = _scriptProperties.getProperties();
var ACCESS_TOKEN = _props['LINE_ACCESS_TOKEN'];
var FOLDER_ID = '14pP7z5eu5bwB9s5R9CYKS-zlpceXqxuw';
var REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
var PUSH_URL = 'https://api.line.me/v2/bot/message/push';
var LOADING_URL = 'https://api.line.me/v2/bot/chat/loading/start';
var GEMINI_API_KEY = _props['GEMINI_API_KEY'];
var GROQ_API_KEY = _props['GROQ_API_KEY'];
var DASHBOARD_API_SECRET = _props['DASHBOARD_API_SECRET'];
var SHEET_ID = '1w9ZuQED5dRuQsjbR2UtQ5tzO0hw4YBzsHFo-g5jxcpo';
var OCR_TOTAL_BUDGET_MS = 35000;
var LINE_FETCH_TIMEOUT_SECONDS = 10;
var MESSAGE_FETCH_TIMEOUT_SECONDS = 5;
var OCR_DATE_WARN_DAYS = 7;

// ===== รายชื่อโมเดลสำรอง (ลองทีละตัวจากบนลงล่าง ข้ามผู้ให้บริการได้) =====
// Groq เป็นตัวหลัก: ~2s/รูป และไม่โดน capacity-shed แบบ Gemini free tier (ส.ค. 69 เจอ 503 ทั้ง 2 โมเดลพร้อมกัน)
// Gemini เป็นตัวสำรอง: ช้ากว่า (20-60s) แต่คนละบริษัท ล่มพร้อมกันยาก
// ถ้า provider ไม่มี API key จะถูกตัดจาก chain และแจ้งเตือน config แบบ deduplicate ทาง Telegram
// Gemini ใช้ alias *-latest: Google เลื่อนรุ่นให้เอง ไม่โดนถอดรุ่นแบบ Groq
// เปลี่ยนโมเดลได้โดยไม่ต้อง deploy: ตั้ง Script Property OCR_MODELS เช่น
//   groq:qwen/qwen3.8-27b,gemini:gemini-flash-lite-latest,gemini:gemini-flash-latest
var PROVIDER_TIMEOUT_SECONDS = { groq: 8, gemini: 20 };
var DEFAULT_OCR_MODELS = 'groq:qwen/qwen3.8-27b,gemini:gemini-flash-lite-latest,gemini:gemini-flash-latest';

function parseOcrModels(spec) {
  return String(spec || '').split(',').map(function(item) {
    var s = item.trim();
    var i = s.indexOf(':');
    var provider = s.slice(0, i);
    return { provider: provider, model: s.slice(i + 1), timeoutSeconds: PROVIDER_TIMEOUT_SECONDS[provider] };
  }).filter(function(e) { return e.timeoutSeconds && e.model; });
}

var MODEL_CANDIDATES = parseOcrModels(_props['OCR_MODELS']);
if (!MODEL_CANDIDATES.length) MODEL_CANDIDATES = parseOcrModels(DEFAULT_OCR_MODELS);
var MODEL_FALLBACK = MODEL_CANDIDATES.filter(function(e) {
  if (e.provider === 'groq') return !!GROQ_API_KEY;
  if (e.provider === 'gemini') return !!GEMINI_API_KEY;
  return false;
});

function modelLabel(entry) { return entry.provider + ':' + entry.model; }

function entryWithDeadline(entry, deadlineAt) {
  if (!deadlineAt) return entry;
  var remainingSeconds = Math.max(1, Math.floor((deadlineAt - Date.now()) / 1000));
  return {
    provider: entry.provider,
    model: entry.model,
    timeoutSeconds: Math.min(entry.timeoutSeconds || remainingSeconds, remainingSeconds)
  };
}

function escapeTelegramHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== Helper: แปลงปีให้เป็น ค.ศ. เสมอ (ป้องกัน Google Apps Script คืนค่า พ.ศ.) =====
function toCEYear(year) {
  return year > 2500 ? year - 543 : year;
}

var THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

// ===== รอบบิลอัตโนมัติจากวันที่ "บันทึกเข้ามา" (ไม่ใช่วันที่ในสลิป) สำหรับรายการจากระบบอัตโนมัติ =====
function autoCycleFromDate(d) {
  return THAI_MONTHS[d.getUTCMonth()] + ' ' + toCEYear(d.getUTCFullYear());
}

// ===== Telegram backup notification =====
var TELEGRAM_BOT_TOKEN = _props['TELEGRAM_BOT_TOKEN'];
var TELEGRAM_CHAT_ID = _props['TELEGRAM_CHAT_ID'];

function sendTelegram(text) {
  try {
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === '#secret' || !TELEGRAM_CHAT_ID) {
      return { ok: false, reason: 'telegram_not_configured' };
    }
    var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
    var response = UrlFetchApp.fetch(url, {
      'method': 'post',
      'contentType': 'application/json',
      'payload': JSON.stringify({
        'chat_id': TELEGRAM_CHAT_ID,
        'text': text,
        'parse_mode': 'HTML',
        'disable_web_page_preview': true
      }),
      'muteHttpExceptions': true,
      'timeoutSeconds': MESSAGE_FETCH_TIMEOUT_SECONDS
    });
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('sendTelegram HTTP ' + code + ': ' + response.getContentText().slice(0, 300));
      return { ok: false, code: code };
    }
    return { ok: true, code: code };
  } catch (e) {
    Logger.log('sendTelegram error: ' + e);
    return { ok: false, reason: String(e) };
  }
}

function getOcrConfigWarnings() {
  var warnings = [];
  if (!GROQ_API_KEY) warnings.push('GROQ_API_KEY missing: running without the primary provider');
  if (!GEMINI_API_KEY) warnings.push('GEMINI_API_KEY missing: running without Gemini fallback');
  if (!MODEL_FALLBACK.length) warnings.push('No OCR provider is configured');
  return warnings;
}

function reportOcrConfigIfNeeded() {
  var warnings = getOcrConfigWarnings();
  if (!warnings.length) return;
  var fingerprint = warnings.join('|');
  var now = Date.now();
  var lastFingerprint = _scriptProperties.getProperty('OCR_CONFIG_ALERT_FINGERPRINT') || '';
  var lastAt = Number(_scriptProperties.getProperty('OCR_CONFIG_ALERT_AT') || 0);
  if (fingerprint === lastFingerprint && now - lastAt < 24 * 60 * 60 * 1000) return;
  var alertResult = sendTelegram('⚠️ <b>OCR configuration degraded</b>\n' + escapeTelegramHtml(warnings.join('\n')));
  if (alertResult && alertResult.ok) {
    _scriptProperties.setProperty('OCR_CONFIG_ALERT_FINGERPRINT', fingerprint);
    _scriptProperties.setProperty('OCR_CONFIG_ALERT_AT', String(now));
  }
}

// ===== เช็กทุกเช้าว่าโมเดลใน chain ยังมีอยู่ (ถามแค่ metadata ไม่เสียโควต้าอ่านรูป) =====
// ตั้ง trigger เองใน editor: Triggers > Add Trigger > checkOcrModels > Time-driven > Day timer
function checkOcrModels() {
  var problems = [];
  var groqIds = null;
  MODEL_FALLBACK.forEach(function(entry) {
    try {
      if (entry.provider === 'groq') {
        if (!groqIds) {
          var r = UrlFetchApp.fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY }, muteHttpExceptions: true
          });
          if (r.getResponseCode() !== 200) { problems.push('groq /models -> http_' + r.getResponseCode()); groqIds = []; return; }
          groqIds = JSON.parse(r.getContentText()).data.map(function(m) { return m.id; });
        }
        if (groqIds.length && groqIds.indexOf(entry.model) < 0) problems.push(modelLabel(entry) + ' -> ไม่มีในรายชื่อโมเดลแล้ว');
      } else {
        var g = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + entry.model, {
          headers: { 'x-goog-api-key': GEMINI_API_KEY }, muteHttpExceptions: true
        });
        if (g.getResponseCode() !== 200) problems.push(modelLabel(entry) + ' -> http_' + g.getResponseCode());
      }
    } catch (e) {
      problems.push(modelLabel(entry) + ' -> ' + e);
    }
  });
  Logger.log(problems.length ? problems.join('\n') : 'all OCR models OK: ' + MODEL_FALLBACK.map(modelLabel).join(', '));
  if (problems.length) {
    sendTelegram('⚠️ <b>OCR model หาย/ใช้ไม่ได้</b>\n' + escapeTelegramHtml(problems.join('\n')) +
      '\n\nแก้: ตั้ง Script Property <code>OCR_MODELS</code> เป็นโมเดลตัวใหม่ (ไม่ต้อง deploy)' +
      '\nGroq: console.groq.com/docs/deprecations');
  }
}

// บรรทัดสรุปว่า OCR ใช้โมเดลไหน กี่วินาที — ไว้ follow ว่าเริ่มช้า/ต้องพึ่งตัวสำรองรึยัง
function ocrMetaLine(data) {
  if (!data || !data._ocr) return '';
  var o = data._ocr;
  var line = '\n🤖 OCR: ' + o.model + ' · ' + (o.ms / 1000).toFixed(1) + 's';
  if (o.attempt > 1) line += ' ⚠️ (ตัวสำรอง ' + o.attempt + '/' + o.of + ')';
  if (o.route === 'batch_capacity_split') line += ' · แบ่งโหลด batch';
  if (data._validationWarnings && data._validationWarnings.length) {
    line += '\n⚠️ ตรวจสอบข้อมูล: ' + escapeTelegramHtml(data._validationWarnings.join(', '));
  }
  return line;
}

function buildTelegramText(slipData, savedData, dateTimeStr) {
  if (slipData) {
    var typeLabel = (slipData.type === 'bill_payment') ? 'จ่ายบิล' : 'โอนเงิน';
    var noteLine = slipData.note ? ('\n📝 บันทึก: ' + escapeTelegramHtml(slipData.note)) : '';
    return '✅ <b>ตรวจพบสลิป' + typeLabel + '</b>\n' +
      '💰 จำนวน: <b>' + escapeTelegramHtml(slipData.amount || '0.00') + '</b> บาท\n' +
      '📅 วันที่: ' + escapeTelegramHtml(slipData.date || '-') + '\n' +
      '⏰ เวลา: ' + escapeTelegramHtml(slipData.time || '-') + '\n' +
      '🏛 ธนาคาร: ' + escapeTelegramHtml(slipData.bankName || '-') + '\n' +
      '👤 ผู้รับ: ' + escapeTelegramHtml(slipData.receiverName || '-') +
      noteLine + '\n\n' +
      '🕒 อัปโหลด: ' + escapeTelegramHtml(dateTimeStr) +
      ocrMetaLine(slipData) + '\n' +
      '📂 <a href="' + escapeTelegramHtml(savedData.url) + '">เปิดใน Google Drive</a>';
  } else {
    return '📸 <b>บันทึกรูปภาพ</b>\n' +
      'ℹ️ ไม่ใช่สลิปโอนเงิน\n\n' +
      '🕒 อัปโหลด: ' + escapeTelegramHtml(dateTimeStr) + '\n' +
      '📂 <a href="' + escapeTelegramHtml(savedData.url) + '">เปิดใน Google Drive</a>';
  }
}

// ===== ข้อความแจ้งเตือนกรณีอ่านสลิปไม่สำเร็จ (API พลาด ไม่ใช่ "ไม่ใช่สลิป") =====
function buildErrorTelegramText(slipDataOrReason, savedData, dateTimeStr) {
  var reason = slipDataOrReason;
  var detail = '';
  if (slipDataOrReason && typeof slipDataOrReason === 'object') {
    reason = slipDataOrReason.reason;
    detail = slipDataOrReason.detail || '';
  }
  return '⚠️ <b>อ่านสลิปไม่สำเร็จ</b>\n' +
    '❗ เหตุ: ' + escapeTelegramHtml(reason || '-') + '\n' +
    (detail ? '🔎 รายละเอียด: ' + escapeTelegramHtml(detail) + '\n' : '') +
    'ℹ️ รูปถูกบันทึกไว้แล้ว ลองส่งใหม่อีกครั้งได้\n\n' +
    '🕒 อัปโหลด: ' + escapeTelegramHtml(dateTimeStr) + '\n' +
    '📂 <a href="' + escapeTelegramHtml(savedData.url) + '">เปิดใน Google Drive</a>';
}

function normalizeMessages(messagePayload) {
  if (Array.isArray(messagePayload)) return messagePayload;
  if (typeof messagePayload === 'string') return [{ 'type': 'text', 'text': messagePayload }];
  return [messagePayload];
}

function sendReply(replyToken, messagePayload) {
  try {
    var response = UrlFetchApp.fetch(REPLY_URL, {
      'headers': {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': 'Bearer ' + ACCESS_TOKEN,
      },
      'method': 'post',
      'payload': JSON.stringify({
        'replyToken': replyToken,
        'messages': normalizeMessages(messagePayload)
      }),
      'muteHttpExceptions': true,
      'timeoutSeconds': MESSAGE_FETCH_TIMEOUT_SECONDS
    });
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('sendReply HTTP ' + code + ': ' + response.getContentText().slice(0, 300));
      return { ok: false, code: code, detail: response.getContentText().slice(0, 300) };
    }
    return { ok: true, code: code };
  } catch (e) {
    Logger.log('sendReply error: ' + e);
    return { ok: false, reason: String(e) };
  }
}

function sendPush(to, messagePayload) {
  try {
    var response = UrlFetchApp.fetch(PUSH_URL, {
      'headers': {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': 'Bearer ' + ACCESS_TOKEN,
      },
      'method': 'post',
      'payload': JSON.stringify({
        'to': to,
        'messages': normalizeMessages(messagePayload)
      }),
      'muteHttpExceptions': true,
      'timeoutSeconds': MESSAGE_FETCH_TIMEOUT_SECONDS
    });
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('sendPush HTTP ' + code + ': ' + response.getContentText().slice(0, 300));
      return { ok: false, code: code };
    }
    return { ok: true, code: code };
  } catch (e) {
    Logger.log('sendPush error: ' + e);
    return { ok: false, reason: String(e) };
  }
}

function showLoadingIfSupported(event) {
  try {
    if (!event || !event.source || event.source.type !== 'user' || !event.source.userId) return;
    UrlFetchApp.fetch(LOADING_URL, {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': 'Bearer ' + ACCESS_TOKEN
      },
      method: 'post',
      payload: JSON.stringify({ chatId: event.source.userId, loadingSeconds: 40 }),
      muteHttpExceptions: true,
      timeoutSeconds: MESSAGE_FETCH_TIMEOUT_SECONDS
    });
  } catch (e) {
    Logger.log('showLoadingIfSupported error: ' + e);
  }
}

function getImage(id) {
  var url = 'https://api-data.line.me/v2/bot/message/' + id + '/content';
  var data = UrlFetchApp.fetch(url, {
    'headers': { 'Authorization': 'Bearer ' + ACCESS_TOKEN },
    'method': 'get',
    'muteHttpExceptions': true,
    'timeoutSeconds': LINE_FETCH_TIMEOUT_SECONDS
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
var OCR_PROMPT =
    'Classify this image into exactly one of three categories and return the matching JSON.\n\n' +
    'CATEGORY 1 — BANKING SLIP: A digital screenshot from a Thai banking app (K+, SCB Easy, etc.) ' +
    'showing "โอนเงินสำเร็จ" (Transfer) or "จ่ายบิลสำเร็จ" (Bill Payment). ' +
    'Background graphics or watermarks do NOT disqualify it. Return:\n' +
    '{\n' +
    '  "isSlip": true,\n' +
    '  "date": "DD/MM/YYYY CE year. e.g. 3 มิ.ย. 69 = 2569 BE, subtract 543 = CE 2026 -> 03/06/2026. Thai month abbr: ม.ค.=01 ก.พ.=02 มี.ค.=03 เม.ย.=04 พ.ค.=05 มิ.ย.=06 ก.ค.=07 ส.ค.=08 ก.ย.=09 ต.ค.=10 พ.ย.=11 ธ.ค.=12",\n' +
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

function buildGeminiRequest(blob, modelName, timeoutSeconds) {
  var base64Image = Utilities.base64Encode(blob.getBytes());
  var mimeType = blob.getContentType() || 'image/png';
  var prompt = OCR_PROMPT;
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + modelName +
      ':generateContent',
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': GEMINI_API_KEY }, // key ใน header: ไม่หลุดไปกับ error message ที่ส่งเข้า LINE
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
      ],
      'generationConfig': { 'responseMimeType': 'application/json', 'temperature': 0, 'thinkingConfig': { 'thinkingLevel': 'low' } }
    }),
    muteHttpExceptions: true,
    timeoutSeconds: timeoutSeconds || 12
  };
}

// Groq (OpenAI-compatible). response_format บังคับ JSON เลยไม่ต้องลุ้นว่าโมเดลจะห่อ markdown มา
function buildGroqRequest(blob, modelName, timeoutSeconds) {
  var base64Image = Utilities.base64Encode(blob.getBytes());
  var mimeType = blob.getContentType() || 'image/png';
  return {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY },
    payload: JSON.stringify({
      'model': modelName,
      'messages': [{
        'role': 'user',
        'content': [
          { 'type': 'image_url', 'image_url': { 'url': 'data:' + mimeType + ';base64,' + base64Image } },
          { 'type': 'text', 'text': OCR_PROMPT }
        ]
      }],
      'response_format': { 'type': 'json_object' },
      'temperature': 0
    }),
    muteHttpExceptions: true,
    timeoutSeconds: timeoutSeconds || 8
  };
}

function buildOcrRequest(blob, entry) {
  return entry.provider === 'groq'
    ? buildGroqRequest(blob, entry.model, entry.timeoutSeconds)
    : buildGeminiRequest(blob, entry.model, entry.timeoutSeconds);
}

// หา part แรกที่มี .text (part แรกอาจเป็น thought/inline data ซึ่งไม่มี .text)
function firstTextPart(cand) {
  var parts = (cand.content && cand.content.parts) || [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] && typeof parts[i].text === 'string' && parts[i].text) return parts[i].text;
  }
  return '';
}

function validationError(detail) {
  return { error: true, reason: 'validation_failed', detail: detail };
}

function normalizeOcrNumber(value, field, allowNegative) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { error: field + ' must be numeric' };
  }
  var normalized = String(value).replace(/,/g, '').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return { error: field + ' has invalid numeric format' };
  }
  var numberValue = Number(normalized);
  if (!isFinite(numberValue) || (!allowNegative && numberValue <= 0)) {
    return { error: field + ' is out of range' };
  }
  return { value: normalized, number: numberValue };
}

function normalizeOcrDate(value, warnings) {
  if (typeof value !== 'string') return { error: 'date must be DD/MM/YYYY' };
  var match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return { error: 'date must be DD/MM/YYYY' };
  var day = Number(match[1]);
  var month = Number(match[2]);
  var year = toCEYear(Number(match[3]));
  var date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { error: 'date is not a real calendar date' };
  }
  var nowGmt7 = new Date(Date.now() + 7 * 60 * 60 * 1000);
  var today = Date.UTC(nowGmt7.getUTCFullYear(), nowGmt7.getUTCMonth(), nowGmt7.getUTCDate());
  var ageDays = Math.round((today - date.getTime()) / (24 * 60 * 60 * 1000));
  if (Math.abs(ageDays) > OCR_DATE_WARN_DAYS) {
    warnings.push('วันที่ห่างจากวันอัปโหลด ' + ageDays + ' วัน');
  }
  return {
    value: ('0' + day).slice(-2) + '/' + ('0' + month).slice(-2) + '/' + year
  };
}

function validateAndNormalizeOcrData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return validationError('root must be a JSON object');
  }
  if (typeof data.isSlip !== 'boolean') {
    return validationError('isSlip must be a boolean');
  }

  if (data.isSlip === false && data.isMachineCash !== true) {
    if (data.isMachineCash != null && data.isMachineCash !== false) {
      return validationError('isMachineCash must be a boolean');
    }
    return null;
  }

  var warnings = [];
  var dateResult = normalizeOcrDate(data.date, warnings);
  if (dateResult.error) return validationError(dateResult.error);
  data.date = dateResult.value;

  if (data.isMachineCash === true) {
    if (data.isSlip !== false) return validationError('machine cash must have isSlip=false');
    var machineFields = ['amount100', 'amount50', 'amount20', 'total'];
    var parsed = {};
    for (var i = 0; i < machineFields.length; i++) {
      var field = machineFields[i];
      parsed[field] = normalizeOcrNumber(data[field], field, true);
      if (parsed[field].error) return validationError(parsed[field].error);
      data[field] = parsed[field].value;
    }
    var calculatedCents = Math.round((parsed.amount100.number + parsed.amount50.number + parsed.amount20.number) * 100);
    var totalCents = Math.round(parsed.total.number * 100);
    if (calculatedCents !== totalCents) {
      return validationError('machine cash total mismatch: expected ' + (calculatedCents / 100) + ', got ' + parsed.total.number);
    }
    if (warnings.length) data._validationWarnings = warnings;
    return data;
  }

  if (data.isSlip !== true) return validationError('unrecognized OCR category');
  if (data.isMachineCash != null && data.isMachineCash !== false) {
    return validationError('isMachineCash must be false for a banking slip');
  }
  if (data.type !== 'transfer' && data.type !== 'bill_payment') {
    return validationError('type must be transfer or bill_payment');
  }
  if (typeof data.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data.time.trim())) {
    return validationError('time must be HH:MM');
  }
  data.time = data.time.trim();
  if (typeof data.bankName !== 'string' || !data.bankName.trim()) {
    return validationError('bankName is required');
  }
  if (typeof data.receiverName !== 'string' || !data.receiverName.trim()) {
    return validationError('receiverName is required');
  }
  data.bankName = data.bankName.trim();
  data.receiverName = data.receiverName.trim();
  data.note = typeof data.note === 'string' ? data.note.trim() : '';
  var amount = normalizeOcrNumber(data.amount, 'amount', false);
  if (amount.error) return validationError(amount.error);
  data.amount = amount.value;
  if (warnings.length) data._validationWarnings = warnings;
  return data;
}

// คืนค่า 3 แบบ: object (isSlip:true) / null (ไม่ใช่สลิป) / { error:true, reason } (API พลาด)
function parseOcrResponse(response, entry) {
  var modelName = modelLabel(entry);
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) {
    console.error('[OCR] ' + modelName + ' HTTP ' + code + ' — ' + body.slice(0, 600));
    return { error: true, reason: 'http_' + code };
  }
  var result;
  try { result = JSON.parse(body); } catch (e) {
    console.error('[OCR] ' + modelName + ' response body is not JSON — ' + body.slice(0, 600));
    return { error: true, reason: 'json_parse' };
  }
  var text;
  if (entry.provider === 'groq') {
    var choice = result.choices && result.choices[0];
    text = choice && choice.message && choice.message.content;
    if (!text) {
      console.error('[OCR] ' + modelName + ' no message content — ' + body.slice(0, 600));
      return { error: true, reason: 'blocked_or_empty' };
    }
  } else {
    var cand = result.candidates && result.candidates[0];
    if (!cand || !cand.content) {
      var blockReason = result.promptFeedback && result.promptFeedback.blockReason;
      console.error('[OCR] ' + modelName + ' no usable candidate. finishReason=' +
        (cand && cand.finishReason) + ' promptBlockReason=' + blockReason +
        ' — ' + body.slice(0, 600));
      return { error: true, reason: 'blocked_or_empty' };
    }
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      console.warn('[OCR] ' + modelName + ' finishReason=' + cand.finishReason + ' (output may be truncated)');
    }
    text = firstTextPart(cand);
    if (!text) {
      console.error('[OCR] ' + modelName + ' candidate has no text part — ' + body.slice(0, 600));
      return { error: true, reason: 'blocked_or_empty' };
    }
  }
  Logger.log('[OCR] ' + modelName + ' returned ' + text.length + ' chars');
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[OCR] ' + modelName + ' model output has no JSON object — ' + text.slice(0, 600));
    return { error: true, reason: 'no_json' };
  }
  var data;
  try { data = JSON.parse(jsonMatch[0]); } catch (e) {
    console.error('[OCR] ' + modelName + ' model JSON is malformed — ' + jsonMatch[0].slice(0, 600));
    return { error: true, reason: 'json_parse' };
  }
  return validateAndNormalizeOcrData(data);
}

// ===== เรียกหนึ่งโมเดล (ไม่ retry) =====
function extractSlipData(blob, entry) {
  entry = entry || MODEL_FALLBACK[0];
  if (!entry) return { error: true, reason: 'no_provider_configured', ms: 0 };
  var modelName = modelLabel(entry);
  var t0 = Date.now();
  try {
    var req = buildOcrRequest(blob, entry);
    // ponytail: no retry — a shed free-tier 503 can take ~60s to even return,
    // so retrying just burns the LINE reply-token window. Fall through to next model.
    var response = UrlFetchApp.fetch(req.url, req);
    var ms = Date.now() - t0;
    var code = response.getResponseCode();
    if (code !== 200) {
      console.error('[OCR] ' + modelName + ' HTTP ' + code + ' after ' + ms + 'ms — ' +
        response.getContentText().slice(0, 600));
      return { error: true, reason: 'http_' + code, ms: ms };
    }
    console.log('[OCR] ' + modelName + ' HTTP 200 in ' + ms + 'ms');
    var parsed = parseOcrResponse(response, entry);
    if (parsed && parsed.error) parsed.ms = ms;
    return parsed;
  } catch (e) {
    var msErr = Date.now() - t0;
    console.error('[OCR] ' + modelName + ' threw after ' + msErr + 'ms — ' + e);
    return { error: true, reason: 'exception:' + e, ms: msErr };
  }
}

// ===== ตัวห่อ: ไล่ลองทีละโมเดลใน MODEL_FALLBACK =====
// คืนค่า: object สลิป / null (ไม่ใช่สลิปจริง) / { error:true, reason }
function extractSlipDataWithFallback(blob, startIdx, deadlineAt) {
  var t0 = Date.now();
  var attempts = [];
  var firstIdx = typeof startIdx === 'number' ? startIdx : 0;
  if (!MODEL_FALLBACK.length) {
    return { error: true, reason: 'no_provider_configured', detail: 'MODEL_FALLBACK is empty' };
  }
  for (var m = firstIdx; m < MODEL_FALLBACK.length; m++) {
    if (deadlineAt && Date.now() >= deadlineAt) {
      attempts.push('deadline exceeded before ' + modelLabel(MODEL_FALLBACK[m]));
      break;
    }
    var model = modelLabel(MODEL_FALLBACK[m]);
    var result = extractSlipData(blob, entryWithDeadline(MODEL_FALLBACK[m], deadlineAt));

    // อ่านสลิปได้สำเร็จ
    if (result && !result.error) {
      var totalMs = Date.now() - t0;
      console.log('[OCR] success via ' + model + ' (model ' + (m + 1) + '/' +
        MODEL_FALLBACK.length + ', ' + totalMs + 'ms total)');
      result._ocr = {
        model: model,
        ms: totalMs,
        attempt: m - firstIdx + 1,
        of: MODEL_FALLBACK.length - firstIdx
      };
      return result;
    }

    // ไม่ใช่สลิปจริง -> หยุดเลย ลองโมเดลอื่นก็ได้ผลเหมือนเดิม เปลืองโควต้าเปล่า
    if (result === null) {
      console.log('[OCR] ' + model + ' classified image as not-a-slip — stopping (' +
        (Date.now() - t0) + 'ms)');
      return null;
    }

    // error -> เก็บเหตุผลไว้ แล้วเลื่อนไปลองโมเดลถัดไป
    attempts.push(model + ' -> ' + result.reason +
      (result.detail ? ': ' + result.detail : '') +
      (result.ms ? ' (' + result.ms + 'ms)' : ''));
    console.warn('[OCR] ' + model + ' failed: ' + result.reason + ' -> ลองโมเดลถัดไป');
  }
  // ลองครบทุกโมเดลแล้วยังพลาด — สรุปทุก attempt ไว้ในบรรทัดเดียว
  console.error('[OCR] ALL MODELS FAILED after ' + (Date.now() - t0) + 'ms | ' + attempts.join(' | '));
  return { error: true, reason: 'all_models_failed', detail: attempts.join(' ; ') };
}

function extractBatchWithFallback(blobs, deadlineAt) {
  var now = Date.now();
  var canSplitAcrossProviders = MODEL_FALLBACK.length > 1 &&
    MODEL_FALLBACK[0].provider === 'groq' && MODEL_FALLBACK[1].provider !== 'groq';
  var groqAssigned = 0;
  var states = blobs.map(function(blob) {
    if (!blob) return { done: true, result: { error: true, reason: 'LINE_FETCH_FAILED' } };
    var startIdx = 0;
    var route = 'primary';
    if (canSplitAcrossProviders && groqAssigned >= 3) {
      startIdx = 1;
      route = 'batch_capacity_split';
    } else if (MODEL_FALLBACK[0] && MODEL_FALLBACK[0].provider === 'groq') {
      groqAssigned++;
    }
    return {
      blob: blob,
      startedAt: now,
      startIdx: startIdx,
      nextIdx: startIdx,
      route: route,
      attempts: [],
      done: false,
      result: undefined
    };
  });

  if (!MODEL_FALLBACK.length) {
    states.forEach(function(state) {
      if (!state.done) {
        state.done = true;
        state.result = { error: true, reason: 'no_provider_configured' };
      }
    });
    return states.map(function(state) { return state.result; });
  }

  while (true) {
    var activeIdxs = [];
    var requests = [];
    states.forEach(function(state, idx) {
      if (state.done) return;
      if (state.nextIdx >= MODEL_FALLBACK.length) {
        state.done = true;
        state.result = {
          error: true,
          reason: 'all_models_failed',
          detail: state.attempts.join(' ; ')
        };
        return;
      }
      if (deadlineAt && Date.now() >= deadlineAt) {
        state.done = true;
        state.result = {
          error: true,
          reason: 'ocr_deadline_exceeded',
          detail: state.attempts.join(' ; ')
        };
        return;
      }
      activeIdxs.push(idx);
      requests.push(buildOcrRequest(
        state.blob.copyBlob(),
        entryWithDeadline(MODEL_FALLBACK[state.nextIdx], deadlineAt)
      ));
    });
    if (!requests.length) break;

    var responses;
    var waveStartedAt = Date.now();
    var waveException = null;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      waveException = String(e);
      responses = [];
      Logger.log('[OCR] batch wave exception: ' + waveException);
    }
    var waveMs = Date.now() - waveStartedAt;

    activeIdxs.forEach(function(stateIdx, responseIdx) {
      var state = states[stateIdx];
      var entry = MODEL_FALLBACK[state.nextIdx];
      var label = modelLabel(entry);
      var parsed = waveException
        ? { error: true, reason: 'batch_fetch_exception', detail: waveException }
        : (responses[responseIdx]
          ? parseOcrResponse(responses[responseIdx], entry)
          : { error: true, reason: 'batch_response_missing' });

      if (parsed === null) {
        state.done = true;
        state.result = null;
        return;
      }
      if (parsed && !parsed.error) {
        parsed._ocr = {
          model: label,
          ms: Date.now() - state.startedAt,
          attempt: state.attempts.length + 1,
          of: MODEL_FALLBACK.length - state.startIdx,
          route: state.route
        };
        state.done = true;
        state.result = parsed;
        return;
      }

      var reason = parsed && parsed.reason ? parsed.reason : 'unknown_error';
      var detail = parsed && parsed.detail ? ': ' + parsed.detail : '';
      state.attempts.push(label + ' -> ' + reason + detail + ' (' + waveMs + 'ms)');
      state.nextIdx++;
    });
  }

  return states.map(function(state) { return state.result; });
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
    return true;
  } catch (e) {
    Logger.log('recordToSheet error: ' + e);
    return false;
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
        "data": "action=deleteImage&fileId=" + savedData.id + "&time=" + encodedTime + "&sig=" + deleteImageSig(savedData.id),
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
      sheet.appendRow(['Timestamp (GMT+7)', 'Date', '100 บาท', '50 บาท', '20 บาท', 'รวม', 'File URL', 'Note', 'รอบบิล']);
    }
    var now = new Date();
    var gmt7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    var ts = toCEYear(gmt7.getUTCFullYear()) + '/' +
      ('0' + (gmt7.getUTCMonth() + 1)).slice(-2) + '/' +
      ('0' + gmt7.getUTCDate()).slice(-2) + ' ' +
      ('0' + gmt7.getUTCHours()).slice(-2) + ':' +
      ('0' + gmt7.getUTCMinutes()).slice(-2) + ':' +
      ('0' + gmt7.getUTCSeconds()).slice(-2);
    sheet.appendRow([ts, data.date || '', data.amount100 || '', data.amount50 || '', data.amount20 || '', data.total || '', fileUrl || '', '', autoCycleFromDate(gmt7)]);
    return true;
  } catch (e) {
    Logger.log('recordMachineCashToSheet error: ' + e);
    return false;
  }
}

function buildMachineCashTelegramText(data, savedData, dateTimeStr) {
  return '💵 <b>เงินหลังเครื่อง</b>\n' +
    '📅 วันที่: ' + escapeTelegramHtml(data.date || '-') + '\n' +
    '💴 100 บาท: ' + escapeTelegramHtml(data.amount100 || '0') + ' บ.\n' +
    '💵 50 บาท: ' + escapeTelegramHtml(data.amount50 || '0') + ' บ.\n' +
    '💶 20 บาท: ' + escapeTelegramHtml(data.amount20 || '0') + ' บ.\n' +
    '💰 รวม: <b>' + escapeTelegramHtml(data.total || '0') + '</b> บ.\n\n' +
    '🕒 อัปโหลด: ' + escapeTelegramHtml(dateTimeStr) +
    ocrMetaLine(data) + '\n' +
    '📂 <a href="' + escapeTelegramHtml(savedData.url) + '">เปิดใน Google Drive</a>';
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

function queueTelegram(queue, text) {
  if (queue) queue.push(text);
  else sendTelegram(text);
}

function processImageEventToBubble(event, telegramQueue, deadlineAt) {
  try {
    var img = getImage(event.message.id);
    Logger.log('img fetched: ' + img.getName());

    var imgForDrive = img.copyBlob();
    var imgForOcr = img.copyBlob();

    var savedData   = saveImage(imgForDrive);
    var dateTimeStr = getGmt7DateTimeString();

    if (!savedData || !savedData.url) {
      Logger.log('saveImage failed');
      queueTelegram(telegramQueue, '❌ <b>บันทึกรูปล้มเหลว</b>\n🕒 ' + escapeTelegramHtml(dateTimeStr));
      return null;
    }

    Logger.log('saveImage url: ' + savedData.url);
    var slipData = extractSlipDataWithFallback(imgForOcr, 0, deadlineAt);

    // กรณี 1: API พลาด -> แจ้งเตือนให้ส่งใหม่
    if (slipData && slipData.error) {
      queueTelegram(telegramQueue, buildErrorTelegramText(slipData, savedData, dateTimeStr));
      return buildErrorBubble(savedData, dateTimeStr, slipData.reason);
    }

    // กรณี 2: เงินหลังเครื่อง
    if (slipData && slipData.isMachineCash) {
      if (!recordMachineCashToSheet(slipData, savedData.url)) {
        var machineWriteError = { reason: 'sheet_write_failed', detail: 'เงินหลังเครื่อง' };
        queueTelegram(telegramQueue, buildErrorTelegramText(machineWriteError, savedData, dateTimeStr));
        return buildErrorBubble(savedData, dateTimeStr, machineWriteError.reason);
      }
      queueTelegram(telegramQueue, buildMachineCashTelegramText(slipData, savedData, dateTimeStr));
      return buildMachineCashBubble(slipData, savedData, dateTimeStr);
    }

    // กรณี 3: สลิปโอนเงิน/จ่ายบิล
    if (slipData) {
      if (!recordToSheet(slipData, savedData.url)) {
        var paymentWriteError = { reason: 'sheet_write_failed', detail: 'Payment' };
        queueTelegram(telegramQueue, buildErrorTelegramText(paymentWriteError, savedData, dateTimeStr));
        return buildErrorBubble(savedData, dateTimeStr, paymentWriteError.reason);
      }
      queueTelegram(telegramQueue, buildTelegramText(slipData, savedData, dateTimeStr));
      return buildSlipBubble(slipData, savedData, dateTimeStr);
    }

    // กรณี 4: ไม่ใช่ทั้งสอง
    queueTelegram(telegramQueue, buildTelegramText(null, savedData, dateTimeStr));
    return buildNonSlipBubble(savedData, dateTimeStr);

  } catch (e) {
    Logger.log('processImageEventToBubble error: ' + e);
    queueTelegram(telegramQueue, '⚠️ <b>เกิดข้อผิดพลาด</b>\n' + escapeTelegramHtml(e));
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

// webhook ไม่ได้ตรวจ X-Line-Signature (GAS อ่าน header ไม่ได้) และ fileId เห็นได้จาก Sheet public
// -> ปุ่มลบต้องมีลายเซ็น HMAC ที่บอทสร้างเอง ไม่งั้นใครก็ยิง postback ปลอมมา trash ไฟล์ใน Drive ได้
function deleteImageSig(fileId) {
  if (!DASHBOARD_API_SECRET) return '';
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature('deleteImage:' + fileId, DASHBOARD_API_SECRET)
  ).replace(/=+$/, '');
}

function handleDeleteImagePostback(event, parsedData) {
  var fileId     = parsedData.fileId;
  var uploadTime = parsedData.time ? decodeURIComponent(parsedData.time) : '';

  if (!fileId) {
    sendReply(event.replyToken, "❌ ไม่พบ ID ของไฟล์");
    return;
  }
  var expectedSig = deleteImageSig(fileId);
  if (!expectedSig || parsedData.sig !== expectedSig) {
    Logger.log('deleteImage rejected: bad signature for ' + fileId);
    sendReply(event.replyToken, "❌ ปุ่มนี้ใช้ไม่ได้แล้ว (การ์ดเก่า) กรุณาลบใน Google Drive โดยตรง");
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
    sendTelegram('🗑️ <b>ลบรูปแล้ว</b>\n🕒 อัปโหลดเมื่อ: ' + escapeTelegramHtml(uploadTime || '-'));
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
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

var DASHBOARD_SHEETS = { payment: 'Payment', machineCash: 'เงินหลังเครื่อง', commonFund: 'เงินส่วนกลาง' };

// Dashboard อ่านผ่านตรงนี้แทน gviz เพื่อให้ Sheet เป็น private ได้
// format วันที่ให้ตรงกับที่ dashboard เคยได้จาก gviz: yyyy/MM/dd, yyyy/MM/dd HH:mm, คอลัมน์ Time = HH:mm
function formatDashboardCell(value, header, tz) {
  if (!(value instanceof Date)) return value;
  var p = Utilities.formatDate(value, tz, 'yyyy|MM|dd|HH|mm').split('|');
  var hm = p[3] + ':' + p[4];
  if (header === 'Time') return hm;
  var ymd = toCEYear(Number(p[0])) + '/' + p[1] + '/' + p[2];
  return hm === '00:00' ? ymd : ymd + ' ' + hm;
}

function readDashboardSheet(sheetKey) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(DASHBOARD_SHEETS[sheetKey]);
  if (!sheet || sheet.getLastRow() < 1) return { headers: [], rows: [] };
  var tz = ss.getSpreadsheetTimeZone();
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(String);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i].some(function(v) { return v !== '' && v !== null; })) continue;
    rows.push({
      row: i + 1,
      values: values[i].map(function(v, c) { return formatDashboardCell(v, headers[c], tz); })
    });
  }
  return { headers: headers, rows: rows };
}

function validateDashboardRequest(body) {
  var allowed = {
    machineCash: { read: true, add: true, edit: true, delete: true, setCycle: true },
    payment: { read: true, delete: true },
    commonFund: { read: true, add: true, edit: true, delete: true }
  };
  if (!DASHBOARD_API_SECRET || body.apiSecret !== DASHBOARD_API_SECRET) {
    return 'unauthorized';
  }
  if (!allowed[body.sheet] || !allowed[body.sheet][body.action]) {
    return 'invalid sheet/action';
  }
  if (body.action === 'edit' || body.action === 'delete') {
    var row = Number(body.row);
    if (!Number.isInteger(row) || row < 2) return 'invalid row';
  }
  if (body.action === 'setCycle') {
    var rows = String(body.rows || '').split(',');
    if (!rows.length || rows.some(function(value) {
      var row = Number(value);
      return !Number.isInteger(row) || row < 2;
    })) return 'invalid rows';
  }
  return '';
}

function handleDashboardRequest(body) {
  var lock = null;
  try {
    var validationMessage = validateDashboardRequest(body);
    if (validationMessage) return jsonOutput({ error: validationMessage });
    if (body.action === 'read') return jsonOutput(readDashboardSheet(body.sheet));
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return jsonOutput({ error: 'dashboard_busy' });

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var now = new Date();
    var gmt7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    var ts = toCEYear(gmt7.getUTCFullYear()) + '/' +
      ('0' + (gmt7.getUTCMonth() + 1)).slice(-2) + '/' +
      ('0' + gmt7.getUTCDate()).slice(-2) + ' ' +
      ('0' + gmt7.getUTCHours()).slice(-2) + ':' +
      ('0' + gmt7.getUTCMinutes()).slice(-2) + ':' +
      ('0' + gmt7.getUTCSeconds()).slice(-2);

    if (body.sheet === 'machineCash') {
      var sheet = ss.getSheetByName('เงินหลังเครื่อง');
      var h = parseFloat(body.hundred) || 0;
      var f = parseFloat(body.fifty) || 0;
      var t = parseFloat(body.twenty) || 0;
      var total = parseFloat(body.total) || (h + f + t);
      if (body.action === 'add') {
        sheet.appendRow([ts, body.date, h, f, t, total, '', body.note || '', body.cycle || '']);
      } else if (body.action === 'edit') {
        var row = parseInt(body.row);
        sheet.getRange(row, 2).setValue(body.date);
        sheet.getRange(row, 3).setValue(h);
        sheet.getRange(row, 4).setValue(f);
        sheet.getRange(row, 5).setValue(t);
        sheet.getRange(row, 6).setValue(total);
        sheet.getRange(row, 8).setValue(body.note || '');
        sheet.getRange(row, 9).setValue(body.cycle || '');
      } else if (body.action === 'delete') {
        sheet.deleteRow(parseInt(body.row));
      } else if (body.action === 'setCycle') {
        var rows = String(body.rows || '').split(',')
          .map(function (r) { return parseInt(r); })
          .filter(function (r) { return r; });
        rows.forEach(function (row) {
          sheet.getRange(row, 9).setValue(body.cycle || '');
        });
      }
    } else if (body.sheet === 'payment') {
      var sheet = ss.getSheetByName('Payment');
      if (body.action === 'delete') {
        sheet.deleteRow(parseInt(body.row));
      }
    } else if (body.sheet === 'commonFund') {
      var sheet = ss.getSheetByName('เงินส่วนกลาง');
      var mIn = parseFloat(body.moneyIn) || 0;
      var mOut = parseFloat(body.moneyOut) || 0;
      if (body.action === 'add') {
        sheet.appendRow([ts, body.date, mIn, mIn - mOut, body.description || '', mOut, body.note || '']);
      } else if (body.action === 'edit') {
        var row = parseInt(body.row);
        sheet.getRange(row, 2).setValue(body.date);
        sheet.getRange(row, 3).setValue(mIn);
        sheet.getRange(row, 4).setValue(mIn - mOut);
        sheet.getRange(row, 5).setValue(body.description || '');
        sheet.getRange(row, 6).setValue(mOut);
        sheet.getRange(row, 7).setValue(body.note || '');
      } else if (body.action === 'delete') {
        sheet.deleteRow(parseInt(body.row));
      }
    }
    return jsonOutput({ ok: true });
  } catch (err) {
    Logger.log('handleDashboardRequest error: ' + err);
    return jsonOutput({ error: String(err) });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function claimLineEvent(event) {
  try {
    var eventId = event.webhookEventId || (event.message && event.message.id);
    if (!eventId) return true;
    var cache = CacheService.getScriptCache();
    var key = 'line_event_' + eventId;
    if (cache.get(key)) return false;
    cache.put(key, '1', 21600);
    return true;
  } catch (e) {
    Logger.log('claimLineEvent error: ' + e);
    return true;
  }
}

function buildBatchOutcomeBubble(slipData, savedData, dateTimeStr, telegramQueue) {
  if (slipData && slipData.error) {
    telegramQueue.push(buildErrorTelegramText(slipData, savedData, dateTimeStr));
    return buildErrorBubble(savedData, dateTimeStr, slipData.reason);
  }
  if (slipData && slipData.isMachineCash) {
    if (!recordMachineCashToSheet(slipData, savedData.url)) {
      var machineError = { reason: 'sheet_write_failed', detail: 'เงินหลังเครื่อง' };
      telegramQueue.push(buildErrorTelegramText(machineError, savedData, dateTimeStr));
      return buildErrorBubble(savedData, dateTimeStr, machineError.reason);
    }
    telegramQueue.push(buildMachineCashTelegramText(slipData, savedData, dateTimeStr));
    return buildMachineCashBubble(slipData, savedData, dateTimeStr);
  }
  if (slipData) {
    if (!recordToSheet(slipData, savedData.url)) {
      var paymentError = { reason: 'sheet_write_failed', detail: 'Payment' };
      telegramQueue.push(buildErrorTelegramText(paymentError, savedData, dateTimeStr));
      return buildErrorBubble(savedData, dateTimeStr, paymentError.reason);
    }
    telegramQueue.push(buildTelegramText(slipData, savedData, dateTimeStr));
    return buildSlipBubble(slipData, savedData, dateTimeStr);
  }
  telegramQueue.push(buildTelegramText(null, savedData, dateTimeStr));
  return buildNonSlipBubble(savedData, dateTimeStr);
}

function doPost(e) {
  Logger.log('doPost called');
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action) return handleDashboardRequest(body);

    reportOcrConfigIfNeeded();
    var events = body.events || [];
    Logger.log('events count: ' + events.length);
    var imageEvents = [];
    var firstReplyToken = null;

    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      if (event.type === 'message' && event.message && event.message.type === 'image') {
        if (!claimLineEvent(event)) {
          Logger.log('Skipping duplicate LINE event ' + (event.webhookEventId || event.message.id));
          continue;
        }
        if (!firstReplyToken) firstReplyToken = event.replyToken;
        imageEvents.push(event);
      } else if (event.type === 'postback') {
        var parsedData = parsePostbackData(event.postback.data);
        if (parsedData.action === 'deleteImage') handleDeleteImagePostback(event, parsedData);
      }
    }

    if (!imageEvents.length) return jsonOutput({ content: 'post ok' });

    var deadlineAt = Date.now() + OCR_TOTAL_BUDGET_MS;
    var bubbles = [];
    var telegramQueue = [];
    showLoadingIfSupported(imageEvents[0]);

    if (imageEvents.length === 1) {
      var bubble = processImageEventToBubble(imageEvents[0], telegramQueue, deadlineAt);
      if (bubble) bubbles.push(bubble);
    } else {
      var lineRequests = imageEvents.map(function(ev) {
        return {
          url: 'https://api-data.line.me/v2/bot/message/' + ev.message.id + '/content',
          headers: { 'Authorization': 'Bearer ' + ACCESS_TOKEN },
          muteHttpExceptions: true,
          timeoutSeconds: LINE_FETCH_TIMEOUT_SECONDS
        };
      });
      var lineResponses = [];
      try {
        lineResponses = UrlFetchApp.fetchAll(lineRequests);
      } catch (lineFetchError) {
        Logger.log('LINE batch fetch exception: ' + lineFetchError);
      }
      var blobs = imageEvents.map(function(_, idx) {
        var response = lineResponses[idx];
        if (!response || response.getResponseCode() !== 200) {
          Logger.log('LINE batch fetch failed for image ' + idx);
          return null;
        }
        return response.getBlob().getAs('image/png').setName(Number(new Date()) + '-' + idx + '.png');
      });

      var batchDateTimeStr = getGmt7DateTimeString();
      var savedItems = blobs.map(function(blob) {
        if (!blob) return null;
        return saveImage(blob.copyBlob());
      });
      var ocrBlobs = blobs.map(function(blob, idx) {
        return blob && savedItems[idx] && savedItems[idx].url ? blob : null;
      });
      var batchResults = extractBatchWithFallback(ocrBlobs, deadlineAt);

      for (var j = 0; j < imageEvents.length; j++) {
        try {
          var savedData = savedItems[j];
          if (!savedData || !savedData.url) {
            telegramQueue.push('❌ <b>บันทึกรูปล้มเหลว</b> (รูปที่ ' + (j + 1) + ')\n🕒 ' + escapeTelegramHtml(batchDateTimeStr));
            continue;
          }
          var bub = buildBatchOutcomeBubble(batchResults[j], savedData, batchDateTimeStr, telegramQueue);
          if (bub) bubbles.push(bub);
        } catch (imgErr) {
          Logger.log('Batch image ' + j + ' error: ' + imgErr);
          telegramQueue.push('⚠️ <b>เกิดข้อผิดพลาด</b> (รูปที่ ' + (j + 1) + ')\n' + escapeTelegramHtml(imgErr));
        }
      }
    }

    var messagePayload = bubbles.length
      ? wrapBubblesToFlex(bubbles)
      : '⚠️ ไม่สามารถประมวลผลรูปภาพได้ กรุณาส่งใหม่อีกครั้ง';
    var replyResult = sendReply(firstReplyToken, messagePayload);
    if (!replyResult || !replyResult.ok) {
      var recipientId = getRecipientId(imageEvents[0]);
      var pushResult = recipientId ? sendPush(recipientId, messagePayload) : { ok: false };
      telegramQueue.push('⚠️ <b>LINE reply failed</b> — push fallback: ' +
        escapeTelegramHtml(pushResult && pushResult.ok ? 'success' : 'failed'));
    }
    telegramQueue.forEach(function(text) { sendTelegram(text); });
  } catch (err) {
    Logger.log('doPost fatal error: ' + err);
    sendTelegram('⚠️ <b>doPost fatal error</b>\n' + escapeTelegramHtml(err));
  }
  return jsonOutput({ content: 'post ok' });
}
