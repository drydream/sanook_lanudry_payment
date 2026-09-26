# sanook-payment

LINE bot ร้านซักรีด: พนักงานส่งรูปสลิป/สรุปเงินหลังเครื่องเข้า LINE → OCR → บันทึก Google Sheets + Drive + แจ้ง Telegram
Dashboard อยู่อีก repo: [sanook_laundry_report](https://github.com/drydream/sanook_laundry_report)

## โครงสร้าง

- `Code.js` — Google Apps Script ทั้งหมด (webhook `doPost`, OCR, Sheet, Telegram, dashboard CRUD)
- `appsscript.json` — manifest / scopes

## Deploy

> โค้ดบน GAS คือตัวจริง ถ้ามีคนแก้ใน editor ต้อง `clasp pull` ก่อนแก้ในเครื่องเสมอ

```bash
clasp pull
# แก้ Code.js
clasp push -f
clasp deploy -i AKfycbyqYRGDwB3iuCdgqJAdKQgka1CDC_UHaMRqurA56vToiOsBhIGcdYYHfO4MEU7i9b0lNg -d "คำอธิบาย"
```

- `clasp push` อย่างเดียว บอทยังไม่เปลี่ยน ต้อง `clasp deploy` ด้วย
- clasp 3 **ไม่ลบไฟล์บน server** ที่ลบในเครื่อง → หลังลบไฟล์ ให้ `clasp pull` ในโฟลเดอร์อื่นเช็กก่อน deploy

## Script Properties (GAS editor → Project Settings)

| ชื่อ | ใช้ทำอะไร |
|---|---|
| `LINE_ACCESS_TOKEN` | ตอบกลับ / ดึงรูปจาก LINE |
| `GROQ_API_KEY` | OCR ตัวหลัก |
| `GEMINI_API_KEY` | OCR ตัวสำรอง |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | แจ้งเตือน / backup |
| `DASHBOARD_API_SECRET` | auth ของ dashboard CRUD |
| `OCR_MODELS` (ไม่บังคับ) | override ลำดับโมเดล OCR โดยไม่ต้อง deploy |

ห้ามใส่ key ในโค้ด

## OCR model chain

ค่า default (`DEFAULT_OCR_MODELS` ใน `Code.js`):

```
groq:qwen/qwen3.8-27b,gemini:gemini-flash-lite-latest,gemini:gemini-flash-latest
```

ลองทีละตัวจากซ้ายไปขวา เวลารวมไม่เกิน 35 วินาที (Groq 8s, Gemini 20s)

- Gemini ใช้ alias `*-latest` → Google เลื่อนรุ่นให้เอง
- Groq รุ่นที่อ่านรูปได้มีแต่ preview → **ถูกถอดบ่อย**

### เมื่อ Groq ถอดโมเดล (เจอ `http_404` หรือ Telegram แจ้ง "OCR model หาย")

1. ดูชื่อตัวแทนที่ https://console.groq.com/docs/deprecations
2. Script Properties → ตั้ง `OCR_MODELS` = `groq:<ชื่อใหม่>,gemini:gemini-flash-lite-latest,gemini:gemini-flash-latest`
3. Save — มีผลทันที ไม่ต้อง deploy
4. ส่งสลิปจริงเทส 1 รูป เช็กว่า **วันที่** ถูก (เคยมีโมเดลอ่าน ก.ย. เป็น ก.พ.)

รูปแบบใน `OCR_MODELS` ผิด → รายการนั้นถูกข้าม ถ้าผิดหมด → ใช้ค่า default

### เช็กสุขภาพอัตโนมัติ

`checkOcrModels()` เช็กว่าโมเดลใน chain ยังมีอยู่ (ถาม metadata ไม่เสียโควต้า) ถ้าหาย → Telegram
ตั้ง trigger: GAS editor → Triggers → Add Trigger → `checkOcrModels` → Time-driven → Day timer

## เช็กข้อมูลวันที่ผิด

สลิปที่ OCR อ่านเดือนผิด จะมี `Date` ห่างจาก `Timestamp` มาก ดู Sheet `Payment` แถวที่ห่างเกิน 7 วัน แล้วเทียบกับรูปใน `File URL`
