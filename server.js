import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3030;

// ─── ClickHouse Config ──────────────────────────────────────────────────────
const CH = {
  host: process.env.CH_HOST || '103.13.30.32',
  port: process.env.CH_PORT || '8123',
  user: process.env.CH_USER || 'admin',
  pass: process.env.CH_PASS || 'AdminClickHouse@2025',
};

// ร้านโซลาว (main shop id)
const SHOP = process.env.SHOP_ID || '2OJMVIo1Qi81NqYos3oDPoASziy';
const TZ   = Number(process.env.CH_TZ || 7); // Thai timezone offset

// เมนูขนมถ้วยที่ใช้งานจริง (มีธุรกรรม)
const BARCODES = `'DS0020','HL0371','SOLAO0022'`;

// ── SQL fragments ที่ใช้ซ้ำ ─────────────────────────────────────────────────
// วันที่แบบไทย (+7 ชั่วโมง) จาก doc header
const dateExpr = `toDate(addHours(d.docdatetime, ${TZ}))`;
// filter หลัก: shop + transflag 44 (ขาย) + ไม่ยกเลิก
const docBase  = `d.shopid='${SHOP}' AND d.transflag=44 AND d.iscancel=0`;
// JOIN doc กับ docdetail
const joinDD   = `JOIN dedebi.docdetail dd ON d.shopid=dd.shopid AND d.docno=dd.docno`;
// filter barcode ขนมถ้วย
const bcFilter = `dd.barcode IN(${BARCODES})`;
const ITEM_META = {
  DS0020:  { label: 'ขนมถ้วย',         unit: 'จาน',  color: '#C8941C' },
  HL0371:  { label: 'ขนมถ้วย (ถ้วย)',  unit: 'ถ้วย', color: '#E6AC30' },
  SOLAO0022:{ label: 'ขนมถ้วยพนักงาน', unit: 'จาน',  color: '#9B6F10' },
};

// ─── ClickHouse Query Helper ─────────────────────────────────────────────────
async function chQuery(sql) {
  return new Promise((resolve, reject) => {
    const body = sql.trim() + ' FORMAT JSONEachRow';
    const opts = {
      hostname: CH.host,
      port: parseInt(CH.port),
      path: '/',
      method: 'POST',
      headers: {
        'X-ClickHouse-User': CH.user,
        'X-ClickHouse-Key': CH.pass,
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(data));
        const rows = data.trim()
          ? data.trim().split('\n').map(l => JSON.parse(l))
          : [];
        resolve(rows);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const one = async (sql) => { const r = await chQuery(sql); return r[0] || {}; };
const num = (v) => parseInt(v) || 0;
const flt = (v) => parseFloat(v) || 0;

// ─── Cache (refresh every 5 min) ────────────────────────────────────────────
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchAllData() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  // 1. หาวันล่าสุดที่มี data (ใช้ today() เพราะข้อมูล real-time จาก dedebi)
  const { d: ld } = await one(
    `SELECT toDate(max(addHours(d.docdatetime, ${TZ}))) as d
     FROM dedebi.doc d
     WHERE ${docBase}`
  );

  // 2. วันก่อนหน้าที่มี data
  const { d: pd } = await one(
    `SELECT toDate(max(addHours(d.docdatetime, ${TZ}))) as d
     FROM dedebi.doc d
     WHERE ${docBase} AND ${dateExpr} < '${ld}'`
  );

  // 3. บิลขนมถ้วย วันนี้ / เมื่อวาน (parallel)
  const [tkRow, ttRow, pkRow, ptRow] = await Promise.all([
    // บิลขนมถ้วยวันล่าสุด
    one(`SELECT count(DISTINCT d.docno) as v
         FROM dedebi.doc d ${joinDD}
         WHERE ${docBase} AND ${bcFilter} AND ${dateExpr}='${ld}'`),
    // บิลทั้งหมดวันล่าสุด
    one(`SELECT count(DISTINCT d.docno) as v
         FROM dedebi.doc d
         WHERE ${docBase} AND ${dateExpr}='${ld}'`),
    // บิลขนมถ้วยวันก่อน
    one(`SELECT count(DISTINCT d.docno) as v
         FROM dedebi.doc d ${joinDD}
         WHERE ${docBase} AND ${bcFilter} AND ${dateExpr}='${pd}'`),
    // บิลทั้งหมดวันก่อน
    one(`SELECT count(DISTINCT d.docno) as v
         FROM dedebi.doc d
         WHERE ${docBase} AND ${dateExpr}='${pd}'`),
  ]);

  // 4. จำนวน qty ขนมถ้วยวันล่าสุด
  const { qty: rawQty } = await one(
    `SELECT abs(round(sum(dd.qty), 1)) as qty
     FROM dedebi.doc d ${joinDD}
     WHERE ${docBase} AND ${bcFilter} AND ${dateExpr}='${ld}'`
  );

  // 5. แยกรายเมนูวันล่าสุด
  const items = await chQuery(
    `SELECT dd.barcode,
            any(dd.itemname) as name,
            count(DISTINCT d.docno) as bills,
            abs(round(sum(dd.qty), 1)) as qty
     FROM dedebi.doc d ${joinDD}
     WHERE ${docBase} AND ${bcFilter} AND ${dateExpr}='${ld}'
     GROUP BY dd.barcode ORDER BY dd.barcode`
  );

  // 6. แยกรายเมนูวันก่อน (สำหรับ % change)
  const prevItems = await chQuery(
    `SELECT dd.barcode,
            count(DISTINCT d.docno) as bills,
            abs(round(sum(dd.qty), 1)) as qty
     FROM dedebi.doc d ${joinDD}
     WHERE ${docBase} AND ${bcFilter} AND ${dateExpr}='${pd}'
     GROUP BY dd.barcode`
  );
  const prevItemMap = Object.fromEntries(prevItems.map(i => [i.barcode, i]));

  // 7. แนวโน้ม 30 วัน — บิลขนมถ้วย
  const trend30 = await chQuery(
    `SELECT ${dateExpr} as date,
            count(DISTINCT d.docno) as khanom,
            abs(round(sum(dd.qty), 1)) as qty
     FROM dedebi.doc d ${joinDD}
     WHERE ${docBase} AND ${bcFilter}
       AND ${dateExpr} >= toDate('${ld}') - 29
     GROUP BY date ORDER BY date`
  );

  // 8. แนวโน้ม 30 วัน — บิลทั้งหมด (สำหรับ % overlay)
  const total30 = await chQuery(
    `SELECT ${dateExpr} as date, count(DISTINCT d.docno) as total
     FROM dedebi.doc d
     WHERE ${docBase} AND ${dateExpr} >= toDate('${ld}') - 29
     GROUP BY date ORDER BY date`
  );
  const totalMap = Object.fromEntries(total30.map(r => [r.date, num(r.total)]));

  // 9. ค่าเฉลี่ยรายวันในสัปดาห์ (90 วัน)
  const weekday = await chQuery(
    `SELECT dow, round(avg(dc), 1) as avg
     FROM (
       SELECT toDayOfWeek(${dateExpr}) as dow,
              ${dateExpr} as d,
              count(DISTINCT d.docno) as dc
       FROM dedebi.doc d ${joinDD}
       WHERE ${docBase} AND ${bcFilter}
         AND ${dateExpr} >= toDate('${ld}') - 89
       GROUP BY d, dow
     )
     GROUP BY dow ORDER BY dow`
  );

  // 10. สถิติ 30 วัน (avg, สูงสุด, ต่ำสุด, วันดีสุด/แย่สุด)
  const stats30 = await one(
    `SELECT round(avg(dc), 1) as avg, max(dc) as peak, min(dc) as low,
            argMax(d, dc) as peak_date, argMin(d, dc) as low_date
     FROM (
       SELECT ${dateExpr} as d, count(DISTINCT d.docno) as dc
       FROM dedebi.doc d ${joinDD}
       WHERE ${docBase} AND ${bcFilter}
         AND ${dateExpr} >= toDate('${ld}') - 29
       GROUP BY d
     )`
  );

  // 11. สรุปรายเดือน (6 เดือน)
  const monthly = await chQuery(
    `SELECT toStartOfMonth(${dateExpr}) as month,
            count(DISTINCT d.docno) as khanom,
            abs(round(sum(dd.qty), 1)) as qty
     FROM dedebi.doc d ${joinDD}
     WHERE ${docBase} AND ${bcFilter}
       AND ${dateExpr} >= toDate('${ld}') - 180
     GROUP BY month ORDER BY month`
  );

  // ─── Compute derived values ─────────────────────────────────────────────
  const tk = num(tkRow.v);
  const tt = num(ttRow.v);
  const pk = num(pkRow.v);
  const pt = num(ptRow.v);
  const tpct = tt > 0 ? +((tk / tt) * 100).toFixed(1) : 0;
  const ppct = pt > 0 ? +((pk / pt) * 100).toFixed(1) : 0;

  const enrichedItems = items.map(i => {
    const prev = prevItemMap[i.barcode] || {};
    const pb = num(prev.bills);
    const tb = num(i.bills);
    return {
      barcode: i.barcode,
      name: i.name,
      bills: tb,
      qty: flt(i.qty),
      prevBills: pb,
      change: tb - pb,
      changePct: pb > 0 ? +(((tb - pb) / pb) * 100).toFixed(1) : null,
      meta: ITEM_META[i.barcode] || { label: i.name, unit: 'หน่วย', color: '#888' },
    };
  });

  // Fill missing items with 0
  const presentCodes = new Set(enrichedItems.map(i => i.barcode));
  for (const bc of ['DS0020', 'HL0371', 'SOLAO0022']) {
    if (!presentCodes.has(bc)) {
      enrichedItems.push({
        barcode: bc, name: ITEM_META[bc].label, bills: 0, qty: 0,
        prevBills: 0, change: 0, changePct: null, meta: ITEM_META[bc],
      });
    }
  }
  enrichedItems.sort((a, b) => a.barcode.localeCompare(b.barcode));

  const trendData = trend30.map(r => ({
    date: r.date,
    khanom: num(r.khanom),
    qty: flt(r.qty),
    total: totalMap[r.date] || 0,
    pct: totalMap[r.date] > 0
      ? +((num(r.khanom) / totalMap[r.date]) * 100).toFixed(1)
      : 0,
  }));

  cache = {
    latestDate: ld,
    prevDate: pd,
    fetchedAt: new Date().toISOString(),
    today: {
      khanomBills: tk,
      totalBills: tt,
      qty: flt(rawQty),
      pct: tpct,
      items: enrichedItems,
    },
    prev: { khanomBills: pk, totalBills: pt, pct: ppct },
    change: {
      bills: tk - pk,
      billsPct: pk > 0 ? +(((tk - pk) / pk) * 100).toFixed(1) : null,
      pctDelta: +(tpct - ppct).toFixed(1),
    },
    stats30: {
      avg: flt(stats30.avg),
      peak: num(stats30.peak),
      low: num(stats30.low),
      peakDate: stats30.peak_date,
      lowDate: stats30.low_date,
    },
    trend: trendData,
    weekday: weekday.map(r => ({ dow: num(r.dow), avg: flt(r.avg) })),
    monthly: monthly.map(r => ({
      month: r.month,
      khanom: num(r.khanom),
      qty: flt(r.qty),
    })),
  };
  cacheTime = now;
  return cache;
}

// ─── HTTP Server (no express, zero deps) ────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── API endpoints ──────────────────────────────────────────────────────
  if (url.pathname === '/api/data') {
    try {
      const data = await fetchAllData();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/refresh') {
    cache = null;
    try {
      const data = await fetchAllData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, fetchedAt: data.fetchedAt }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`🍮 ขนมถ้วย Dashboard → http://localhost:${PORT}`);
  console.log(`   Shop: ${SHOP}`);
  console.log(`   ClickHouse: ${CH.host}:${CH.port}`);
});
