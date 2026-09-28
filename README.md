# sanook-payment

LINE bot ร้านซักรีด: พนักงานส่งรูปสลิป/สรุปเงินหลังเครื่องเข้า LINE → OCR → บันทึก Google Sheets + Drive + แจ้ง Telegram
Dashboard อยู่อีก repo: [sanook_laundry_report](https://github.com/drydream/sanook_laundry_report)

## โครงสร้าง

- `Code.js` — Google Apps Script ทั้งหมด (webhook `doPost`, OCR, Sheet, Telegram, dashboard read/CRUD)
- `appsscript.json` — manifest / scopes

> โค้ด GAS มี **2 ชุด**: ที่นี่ และ `sanook_laundry_report/gas/Code.js` (ชุดนั้นมี unit test: `npm run test:ocr`)
> แก้ที่ไหนต้อง copy ไปอีกที่ให้ตรงกัน แล้วรัน test ก่อน deploy

## Deploy

> โค้ดบน GAS คือตัวจริง ถ้ามีคนแก้ใน editor ต้อง `clasp pull` ก่อนแก้ในเครื่องเสมอ

```bash
clasp pull
# แก้ Code.js
clasp push -f
clasp deployments          # หา ID ของ deployment ที่ LINE webhook ใช้ (ตัวที่มีเลขเวอร์ชันล่าสุด)
clasp deploy -i <DEPLOYMENT_ID> -d "คำอธิบาย"
```

- `clasp push` อย่างเดียว บอทยังไม่เปลี่ยน ต้อง `clasp deploy` ด้วย
- clasp 3 **ไม่ลบไฟล์บน server** ที่ลบในเครื่อง → หลังลบไฟล์ ให้ `clasp pull` ในโฟลเดอร์อื่นเช็กก่อน deploy

## Script Properties (GAS editor → Project Settings)

| ชื่อ | ใช้ทำอะไร |
|---|---|
| `LINE_ACCESS_TOKEN` | ตอบกลับ / ดึงรูปจาก LINE |
| `GROQ_API_KEY` | OCR ตัวหลัก |
| `OPENROUTER_API_KEY` | OCR ตัวสำรอง (เสียเงิน, เติมล่วงหน้า) |
| `GEMINI_API_KEY` | OCR ตัวสำรองสุดท้าย (ฟรี) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | แจ้งเตือน / backup |
| `DASHBOARD_API_SECRET` | auth ของ dashboard CRUD |
| `OCR_MODELS` (ไม่บังคับ) | override ลำดับโมเดล OCR โดยไม่ต้อง deploy |

ห้ามใส่ key ในโค้ด

## OCR model chain

ค่า default (`DEFAULT_OCR_MODELS` ใน `Code.js`):

```
groq:qwen/qwen3.8-27b,openrouter:google/gemini-3.1-flash-lite,gemini:gemini-flash-lite-latest
```

ลองทีละตัวจากซ้ายไปขวา เวลารวมไม่เกิน 35 วินาที (Groq 8s, OpenRouter 15s, Gemini 20s)

- Groq ฟรีจำกัด 7,000 input token/นาที (~3 รูป) → เกินได้ 429 → ไป OpenRouter
- OpenRouter: ~฿0.017/รูป, เลือก provider ที่ตอบเร็วสุด; qwen บน OpenRouter อ่าน ก.ย. เป็น ก.พ. จึงใช้ Gemini แทน
- Gemini ฟรีตอบ 503 "high demand" บ่อย (~5s/ครั้ง) → เป็นแค่ตัวสุดท้าย (เอาขึ้นก่อน OpenRouter แล้ว batch หมดเวลา)
- Gemini ใช้ alias `*-latest` → Google เลื่อนรุ่นให้เอง
- Groq รุ่นที่อ่านรูปได้มีแต่ preview → **ถูกถอดบ่อย**

### เมื่อ Groq ถอดโมเดล (เจอ `http_404` หรือ Telegram แจ้ง "OCR model หาย")

1. ดูชื่อตัวแทนที่ https://console.groq.com/docs/deprecations
2. Script Properties → ตั้ง `OCR_MODELS` = `groq:<ชื่อใหม่>,openrouter:google/gemini-3.1-flash-lite,gemini:gemini-flash-lite-latest`
3. Save — มีผลทันที ไม่ต้อง deploy
4. ส่งสลิปจริงเทส 1 รูป เช็กว่า **วันที่** ถูก (เคยมีโมเดลอ่าน ก.ย. เป็น ก.พ.)

รูปแบบใน `OCR_MODELS` ผิด → รายการนั้นถูกข้าม ถ้าผิดหมด → ใช้ค่า default

### OpenRouter (ตัวสำรองเสียเงิน)

- เติมเงินล่วงหน้าที่ openrouter.ai → Credits (เงินหมดแล้วหยุด ไม่มีบิลตามหลัง) · ดูยอด/ค่าใช้จริงต่อรูปที่หน้า **Activity**
- เครดิตหมดอายุใน 1 ปี · ~฿0.017/รูป และใช้เฉพาะตอน Groq ติด → ปกติไม่ถึง ฿1/เดือน
- เงินหมด / key เสีย → ข้ามไป Gemini ฟรีเอง (อาจช้าหรือล้มถ้า Gemini ก็ 503)
- ห้ามใช้โมเดล `:free` (50 ครั้ง/วัน, ล่มบ่อย) และถ้าเปลี่ยนโมเดล ต้องเทสกับสลิปจริงเรื่อง **เดือนไทย** ก่อน

### ดู log ตอนดีบัก

Executions ของ Web App ไม่แสดง log (ไม่ได้ผูก GCP project) → เขียนฟังก์ชันทดสอบชั่วคราว **ไว้บนสุดของ `Code.js`** (dropdown ใน editor จะเลือกให้เอง) → `clasp push` (ไม่ต้อง deploy, บอทไม่กระทบ) → กด Run ใน editor → อ่าน Execution log → ลบฟังก์ชันแล้ว push อีกรอบ

### เช็กสุขภาพอัตโนมัติ

`checkOcrModels()` เช็กว่าโมเดลใน chain ยังมีอยู่ (ถาม metadata ไม่เสียโควต้า) ถ้าหาย → Telegram
ตั้ง trigger: GAS editor → Triggers → Add Trigger → `checkOcrModels` → Time-driven → Day timer

## ความปลอดภัย

- **Sheet เป็น private (Restricted)** — dashboard อ่านผ่าน GAS action `read` (ต้องมี `DASHBOARD_API_SECRET`) ไม่ใช้ gviz แล้ว อย่าเปิด Sheet กลับเป็น public
- **Dashboard ต้องใส่รหัส** — env `DASHBOARD_PASSWORD` (ถ้าไม่ตั้งใช้ `DELETE_PASSWORD`) ใน Vercel
- **ปุ่มลบรูปใน LINE มีลายเซ็น HMAC** — webhook ตรวจ `X-Line-Signature` ไม่ได้ (GAS อ่าน header ไม่ได้) จึงเซ็น fileId ด้วย `DASHBOARD_API_SECRET` กันคนยิงคำสั่งลบปลอม การ์ดก่อน v58 กดลบไม่ได้
- **เปลี่ยน `DASHBOARD_API_SECRET`** = ปุ่มลบในการ์ดทั้งหมดที่ส่งไปแล้วใช้ไม่ได้ และต้องแก้ทั้งใน GAS + Vercel พร้อมกัน
- Gemini key ส่งทาง header `x-goog-api-key` เท่านั้น ห้ามใส่ใน URL (เคยหลุดไปกับ error message ใน LINE)

## ประวัติเหตุการณ์

**28 ก.ย. 69 — "อ่านสลิปไม่สำเร็จ" (แก้ใน v60–v62)**
- สาเหตุ: Groq ติดลิมิตต่อนาที (429) พร้อมกับ Gemini ฟรีคนใช้เยอะจนตอบ 503 → ไม่มีตัวไหนอ่านได้
- แก้: เพิ่ม OpenRouter (Gemini แบบเสียเงิน) เป็นตัวสำรองที่ 2 ก่อน Gemini ฟรี
- ลองแล้วไม่เวิร์ก: qwen บน OpenRouter (อ่านเดือนผิด), gemini-3.5-flash-lite (บังคับเปิด thinking), เอา Gemini ฟรีขึ้นก่อนตัวเสียเงิน (ส่ง 5 รูปพร้อมกันแล้วหมดเวลา 1 รูป)

## เช็กข้อมูลวันที่ผิด

สลิปที่ OCR อ่านเดือนผิด จะมี `Date` ห่างจาก `Timestamp` มาก ดู Sheet `Payment` แถวที่ห่างเกิน 7 วัน แล้วเทียบกับรูปใน `File URL`
