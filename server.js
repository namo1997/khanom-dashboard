import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3030;

// ─── ClickHouse Config ───────────────────────────────────────────────────────
const CH = {
  host: process.env.CH_HOST || '103.13.30.32',
  port: process.env.CH_PORT || '8123',
  user: process.env.CH_USER || 'admin',
  pass: process.env.CH_PASS || 'AdminClickHouse@2025',
};

const SHOP = process.env.SHOP_ID || '2OJMVIo1Qi81NqYos3oDPoASziy';
const TZ   = Number(process.env.CH_TZ || 7);

const BARCODES = `'DS0020','HL0371','SOLAO0022'`;

// ── SQL fragments ────────────────────────────────────────────────────────────
const dateExpr = `toDate(addHours(d.docdatetime, ${TZ}))`;
const docBase  = `d.shopid='${SHOP}' AND d.transflag=44 AND d.iscancel=0`;
const joinDD   = `JOIN dedebi.docdetail dd ON d.shopid=dd.shopid AND d.docno=dd.docno`;
const bcFilter = `dd.barcode IN(${BARCODES})`;

const ITEM_META = {
  DS0020:   { label: 'ขนมถ้วย',          unit: 'จาน',  color: '#C8941C' },
  HL0371:   { label: 'ขนมถ้วย (ถ้วย)',   unit: 'ถ้วย', color: '#E6AC30' },
  SOLAO0022:{ label: 'ขนมถ้วยพนักงาน',  unit: 'จาน',  color: '#9B6F10' },
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
        resolve(data.trim() ? data.trim().split('\n').map(l => JSON.parse(l)) : []);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const one  = async (sql) => { const r = await chQuery(sql); return r[0] || {}; };
const num  = (v) => parseInt(v)   || 0;
const flt  = (v) => parseFloat(v) || 0;

// ─── Multi-key Cache ─────────────────────────────────────────────────────────
const cacheStore    = {};
const cacheTimeStore = {};
const CACHE_TTL     = 5 * 60 * 1000;

// คำนวณช่วงเวลาก่อนหน้าที่ความยาวเท่ากัน
function prevPeriod(start, end) {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end   + 'T00:00:00');
  const days = Math.round((e - s) / 86400000) + 1;
  const pe = new Date(s.getTime() - 86400000);
  const ps = new Date(pe.getTime() - (days - 1) * 86400000);
  const fmt = (d) => d.toISOString().split('T')[0];
  return { ps: fmt(ps), pe: fmt(pe) };
}

// ─── Main Data Fetcher ───────────────────────────────────────────────────────
async function fetchAllData(start, end) {
  const key = `${start}|${end}`;
  const now = Date.now();
  if (cacheStore[key] && now - cacheTimeStore[key] < CACHE_TTL) return cacheStore[key];

  const { ps, pe } = prevPeriod(start, end);

  // Date range filters
  const pf  = `${dateExpr} BETWEEN toDate('${start}') AND toDate('${end}')`;
  const ppf = `${dateExpr} BETWEEN toDate('${ps}') AND toDate('${pe}')`;

  // ── Run all queries in parallel ──────────────────────────────────────────
  const [
    cur, prev,
    curTotalRow, prevTotalRow,
    items, prevItems,
    trend, totalTrend,
    weekday, monthly, hourly,
  ] = await Promise.all([

    // 1. สรุปช่วงปัจจุบัน (qty หลัก + bills + revenue)
    one(`SELECT count(DISTINCT d.docno) as bills,
                abs(round(sum(dd.qty), 1)) as qty,
                round(sum(dd.sumamount), 2) as revenue
         FROM dedebi.doc d ${joinDD}
         WHERE ${docBase} AND ${bcFilter} AND ${pf}`),

    // 2. สรุปช่วงก่อนหน้า
    one(`SELECT count(DISTINCT d.docno) as bills,
                abs(round(sum(dd.qty), 1)) as qty,
                round(sum(dd.sumamount), 2) as revenue
         FROM dedebi.doc d ${joinDD}
         WHERE ${docBase} AND ${bcFilter} AND ${ppf}`),

    // 3. บิลทั้งหมดช่วงปัจจุบัน (สำหรับ % คำนวณ)
    one(`SELECT count(DISTINCT d.docno) as bills
         FROM dedebi.doc d WHERE ${docBase} AND ${pf}`),

    // 4. บิลทั้งหมดช่วงก่อนหน้า
    one(`SELECT count(DISTINCT d.docno) as bills
         FROM dedebi.doc d WHERE ${docBase} AND ${ppf}`),

    // 5. แยกรายเมนู — ช่วงปัจจุบัน
    chQuery(`SELECT dd.barcode,
                    any(dd.itemname) as name,
                    count(DISTINCT d.docno) as bills,
                    abs(round(sum(dd.qty), 1)) as qty,
                    round(sum(dd.sumamount), 2) as revenue
             FROM dedebi.doc d ${joinDD}
             WHERE ${docBase} AND ${bcFilter} AND ${pf}
             GROUP BY dd.barcode`),

    // 6. แยกรายเมนู — ช่วงก่อนหน้า
    chQuery(`SELECT dd.barcode,
                    count(DISTINCT d.docno) as bills,
                    abs(round(sum(dd.qty), 1)) as qty,
                    round(sum(dd.sumamount), 2) as revenue
             FROM dedebi.doc d ${joinDD}
             WHERE ${docBase} AND ${bcFilter} AND ${ppf}
             GROUP BY dd.barcode`),

    // 7. แนวโน้มรายวัน (30 วัน จาก end)
    chQuery(`SELECT ${dateExpr} as date,
                    count(DISTINCT d.docno) as bills,
                    abs(round(sum(dd.qty), 1)) as qty,
                    round(sum(dd.sumamount), 2) as revenue
             FROM dedebi.doc d ${joinDD}
             WHERE ${docBase} AND ${bcFilter}
               AND ${dateExpr} >= toDate('${end}') - 29
             GROUP BY date ORDER BY date`),

    // 8. บิลทั้งหมดรายวัน (30 วัน) — สำหรับ % overlay
    chQuery(`SELECT ${dateExpr} as date, count(DISTINCT d.docno) as total
             FROM dedebi.doc d
             WHERE ${docBase} AND ${dateExpr} >= toDate('${end}') - 29
             GROUP BY date ORDER BY date`),

    // 9. ค่าเฉลี่ย qty รายวันในสัปดาห์ (90 วัน)
    chQuery(`SELECT dow, round(avg(dq), 1) as avg_qty, round(avg(dr), 0) as avg_rev
             FROM (
               SELECT toDayOfWeek(${dateExpr}) as dow,
                      ${dateExpr} as d,
                      abs(round(sum(dd.qty), 1)) as dq,
                      round(sum(dd.sumamount), 2) as dr
               FROM dedebi.doc d ${joinDD}
               WHERE ${docBase} AND ${bcFilter}
                 AND ${dateExpr} >= toDate('${end}') - 89
               GROUP BY d, dow
             ) GROUP BY dow ORDER BY dow`),

    // 10. สรุปรายเดือน (6 เดือน)
    chQuery(`SELECT toStartOfMonth(${dateExpr}) as month,
                    count(DISTINCT d.docno) as bills,
                    abs(round(sum(dd.qty), 1)) as qty,
                    round(sum(dd.sumamount), 2) as revenue
             FROM dedebi.doc d ${joinDD}
             WHERE ${docBase} AND ${bcFilter}
               AND ${dateExpr} >= toDate('${end}') - 180
             GROUP BY month ORDER BY month`),

    // 11. ช่วงเวลาขาย รายชั่วโมง (ใช้ช่วงเลือก)
    chQuery(`SELECT toHour(addHours(d.docdatetime, ${TZ})) as hour,
                    count(DISTINCT d.docno) as bills,
                    abs(round(sum(dd.qty), 1)) as qty,
                    round(sum(dd.sumamount), 2) as revenue
             FROM dedebi.doc d ${joinDD}
             WHERE ${docBase} AND ${bcFilter} AND ${pf}
             GROUP BY hour ORDER BY hour`),
  ]);

  // ── Compute derived values ───────────────────────────────────────────────
  const curQty  = flt(cur.qty);   const prevQty  = flt(prev.qty);
  const curRev  = flt(cur.revenue); const prevRev  = flt(prev.revenue);
  const curBills = num(cur.bills);  const prevBills = num(prev.bills);
  const curTotal = num(curTotalRow.bills);
  const billPct  = curTotal > 0 ? +((curBills / curTotal) * 100).toFixed(1) : 0;

  // เติมเมนูที่หายไป (qty=0)
  const prevMap = Object.fromEntries(prevItems.map(i => [i.barcode, i]));
  const enriched = [];
  for (const bc of ['DS0020', 'HL0371', 'SOLAO0022']) {
    const cur_i  = items.find(i => i.barcode === bc) || {};
    const prev_i = prevMap[bc] || {};
    const cq = flt(cur_i.qty);
    const pq = flt(prev_i.qty);
    const cr = flt(cur_i.revenue);
    const pr = flt(prev_i.revenue);
    enriched.push({
      barcode: bc,
      name: ITEM_META[bc].label,
      bills: num(cur_i.bills),
      qty: cq, revenue: cr,
      prevQty: pq, prevRevenue: pr,
      qtyChange: +(cq - pq).toFixed(1),
      qtyChangePct: pq > 0 ? +(((cq - pq) / pq) * 100).toFixed(1) : null,
      revChange: +(cr - pr).toFixed(2),
      revChangePct: pr > 0 ? +(((cr - pr) / pr) * 100).toFixed(1) : null,
      meta: ITEM_META[bc],
    });
  }

  const totalMap = Object.fromEntries(totalTrend.map(r => [r.date, num(r.total)]));
  const trendData = trend.map(r => ({
    date: r.date,
    qty: flt(r.qty),
    bills: num(r.bills),
    revenue: flt(r.revenue),
    total: totalMap[r.date] || 0,
    billPct: totalMap[r.date] > 0
      ? +((num(r.bills) / totalMap[r.date]) * 100).toFixed(1) : 0,
    inRange: r.date >= start && r.date <= end,
  }));

  const result = {
    start, end, prevStart: ps, prevEnd: pe,
    fetchedAt: new Date().toISOString(),
    summary: { qty: curQty, bills: curBills, totalBills: curTotal, revenue: curRev, billPct },
    prevSummary: { qty: prevQty, bills: prevBills, totalBills: num(prevTotalRow.bills), revenue: prevRev },
    change: {
      qty: +(curQty - prevQty).toFixed(1),
      qtyPct: prevQty > 0 ? +(((curQty - prevQty) / prevQty) * 100).toFixed(1) : null,
      revenue: +(curRev - prevRev).toFixed(2),
      revenuePct: prevRev > 0 ? +(((curRev - prevRev) / prevRev) * 100).toFixed(1) : null,
      bills: curBills - prevBills,
    },
    items: enriched,
    trend: trendData,
    weekday: weekday.map(r => ({ dow: num(r.dow), avgQty: flt(r.avg_qty), avgRev: flt(r.avg_rev) })),
    monthly: monthly.map(r => ({ month: r.month, bills: num(r.bills), qty: flt(r.qty), revenue: flt(r.revenue) })),
    hourly: hourly.map(r => ({ hour: num(r.hour), bills: num(r.bills), qty: flt(r.qty), revenue: flt(r.revenue) })),
  };

  cacheStore[key] = result;
  cacheTimeStore[key] = now;
  return result;
}

// ─── Static MIME Types ───────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
};

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── GET /api/latest  — หาวันล่าสุดที่มี data ──────────────────────────────
  if (url.pathname === '/api/latest') {
    try {
      const { d } = await one(
        `SELECT toString(toDate(max(addHours(d.docdatetime, ${TZ})))) as d
         FROM dedebi.doc d WHERE ${docBase}`
      );
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ latestDate: d }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/data?start=YYYY-MM-DD&end=YYYY-MM-DD ─────────────────────────
  if (url.pathname === '/api/data') {
    try {
      // หาวันล่าสุดก่อน (ใช้เป็น default)
      const { d: ld } = await one(
        `SELECT toString(toDate(max(addHours(d.docdatetime, ${TZ})))) as d
         FROM dedebi.doc d WHERE ${docBase}`
      );
      const start = url.searchParams.get('start') || ld;
      const end   = url.searchParams.get('end')   || ld;
      const data  = await fetchAllData(start, end);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ ...data, latestDate: ld }));
    } catch (e) {
      console.error('[API Error]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/refresh — ล้าง cache ─────────────────────────────────────────
  if (url.pathname === '/api/refresh') {
    Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
    Object.keys(cacheTimeStore).forEach(k => delete cacheTimeStore[k]);
    try {
      const { d: ld } = await one(
        `SELECT toString(toDate(max(addHours(d.docdatetime, ${TZ})))) as d
         FROM dedebi.doc d WHERE ${docBase}`
      );
      const data = await fetchAllData(ld, ld);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, fetchedAt: data.fetchedAt }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`🍮 ขนมถ้วย Dashboard → http://localhost:${PORT}`);
  console.log(`   Shop: ${SHOP} | ClickHouse: ${CH.host}:${CH.port}`);
});
