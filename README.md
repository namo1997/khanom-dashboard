# 🍮 ขนมถ้วย Dashboard — โซลาว

Mobile-first read-only dashboard สำหรับติดตามยอดเมนูขนมถ้วย

## เมนูที่ติดตาม
| Barcode | ชื่อ | หน่วย |
|---------|------|-------|
| DS0020 | ขนมถ้วย | จาน |
| HL0371 | ขนมถ้วย | ถ้วย |
| SOLAO0022 | ขนมถ้วยพนักงาน | จาน |

## Local Development

```bash
# ตั้ง env
cp .env.example .env
# แก้ไข .env ใส่ credentials จริง

# รัน server
node server.js
# เปิด http://localhost:3030
```

## Railway Deployment

1. Push code ขึ้น GitHub
2. สร้าง Railway project → Connect repo
3. ตั้ง Environment Variables:
   - `CH_HOST` = ClickHouse host
   - `CH_PORT` = 8123
   - `CH_USER` = admin
   - `CH_PASS` = password
   - `SHOP_ID` = shop id

## Features
- 📊 บิลวันล่าสุด + สัดส่วน % ต่อยอดรวม
- 📈 เปรียบเทียบกับวันก่อน (เพิ่ม/ลด %)
- 🍮 แยกตามเมนู: DS0020 / HL0371 / SOLAO0022
- 📅 กราฟแนวโน้ม 30 วัน
- 📆 ค่าเฉลี่ยรายวันในสัปดาห์ (90 วัน)
- 📊 สรุปรายเดือน 6 เดือน
- 🔄 Auto-refresh ทุก 5 นาที
- 📱 Mobile-first design
