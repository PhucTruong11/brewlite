import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3001/api';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    scenario: 'all', // all | menu | login | cart | promo | order
    concurrency: 100, // Mặc định 100 phiên đồng thời theo NFR-01
    requests: 200,    // Tổng số request mỗi kịch bản
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scenario' && args[i + 1]) opts.scenario = args[++i];
    if (args[i] === '--concurrency' && args[i + 1]) opts.concurrency = Number(args[++i]);
    if (args[i] === '--requests' && args[i + 1]) opts.requests = Number(args[++i]);
  }
  return opts;
}

function readCsv(fileName) {
  const filePath = path.join(__dirname, fileName);
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] ?? '').trim();
    });
    return row;
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runPool(totalRequests, concurrency, workerFn) {
  const latencies = [];
  const statusCounts = {};
  let okCount = 0;
  let failCount = 0;
  let cursor = 0;

  const startWall = performance.now();

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= totalRequests) break;
      const t0 = performance.now();
      try {
        const { status, ok } = await workerFn(idx);
        const dt = performance.now() - t0;
        latencies.push(dt);
        statusCounts[status] = (statusCounts[status] || 0) + 1;
        if (ok) okCount++;
        else failCount++;
      } catch (err) {
        const dt = performance.now() - t0;
        latencies.push(dt);
        const key = err?.code || 'ERR';
        statusCounts[key] = (statusCounts[key] || 0) + 1;
        failCount++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, totalRequests) }, () => worker());
  await Promise.all(workers);

  const totalTimeMs = performance.now() - startWall;
  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((s, v) => s + v, 0) / (latencies.length || 1);

  return {
    totalRequests,
    concurrency,
    okCount,
    failCount,
    rps: Number(((totalRequests / totalTimeMs) * 1000).toFixed(1)),
    minMs: Number((latencies[0] || 0).toFixed(1)),
    avgMs: Number(avg.toFixed(1)),
    p50Ms: Number(percentile(latencies, 50).toFixed(1)),
    p95Ms: Number(percentile(latencies, 95).toFixed(1)),
    p99Ms: Number(percentile(latencies, 99).toFixed(1)),
    maxMs: Number((latencies[latencies.length - 1] || 0).toFixed(1)),
    statusCounts,
  };
}

async function main() {
  const opts = parseArgs();
  const loginRows = readCsv('login_data.csv');
  const cartRows = readCsv('cart_validate_data.csv');
  const promoRows = readCsv('promo_apply_data.csv');
  const orderRows = readCsv('create_order_data.csv');

  console.log('================================================================================');
  console.log(`🚀 BREWLITE PERFORMANCE BENCHMARK (Target: ${BASE_URL})`);
  console.log(`   Cấu hình: concurrency = ${opts.concurrency} luồng đồng thời | requests = ${opts.requests}/kịch bản`);
  console.log('================================================================================\n');

  const summaryRows = [];

  // 1. Menu Read (GET /api/products)
  if (opts.scenario === 'all' || opts.scenario === 'menu') {
    const res = await runPool(opts.requests, opts.concurrency, async () => {
      const r = await fetch(`${BASE_URL}/products`);
      await r.arrayBuffer();
      return { status: r.status, ok: r.status === 200 };
    });
    summaryRows.push({
      KichBan: '1. GET /api/products (Xem Menu)',
      FileCSV: '(Read-only)',
      Concurrency: res.concurrency,
      Samples: res.totalRequests,
      'RPS (req/s)': res.rps,
      'p50 (ms)': res.p50Ms,
      'p95 (ms)': res.p95Ms,
      'p99 (ms)': res.p99Ms,
      'Max (ms)': res.maxMs,
      Pass: `${res.okCount}/${res.totalRequests}`,
      'NFR-01': res.p95Ms <= 2000 && res.failCount === 0 ? 'ĐẠT (<=2000ms)' : 'CẦN XEM LẠI',
    });
  }

  // 2. Task 5: Cart Validate (POST /api/cart/validate) từ cart_validate_data.csv
  if (opts.scenario === 'all' || opts.scenario === 'cart') {
    const res = await runPool(opts.requests, opts.concurrency, async (i) => {
      const row = cartRows[i % cartRows.length];
      const body = {
        items: [
          {
            productId: row.productId,
            size: row.size,
            qty: Number(row.qty),
            toppings: row.toppingName ? [row.toppingName] : [],
            lineTotal: Number(row.lineTotal),
          },
        ],
      };
      const r = await fetch(`${BASE_URL}/cart/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => null);
      const actualAvailable = String(json?.available ?? json?.data?.available);
      return {
        status: r.status,
        ok: (r.status === 200 || r.status === 201) && actualAvailable === row.expectedAvailable,
      };
    });
    summaryRows.push({
      KichBan: '2. POST /api/cart/validate (Task 5 Giỏ hàng)',
      FileCSV: 'cart_validate_data.csv',
      Concurrency: res.concurrency,
      Samples: res.totalRequests,
      'RPS (req/s)': res.rps,
      'p50 (ms)': res.p50Ms,
      'p95 (ms)': res.p95Ms,
      'p99 (ms)': res.p99Ms,
      'Max (ms)': res.maxMs,
      Pass: `${res.okCount}/${res.totalRequests}`,
      'NFR-01': res.p95Ms <= 3000 && res.failCount === 0 ? 'ĐẠT (<=3000ms)' : 'CẦN XEM LẠI',
    });
  }

  // 3. Task 5: Promotions Apply (POST /api/promotions/apply) từ promo_apply_data.csv
  if (opts.scenario === 'all' || opts.scenario === 'promo') {
    const res = await runPool(opts.requests, opts.concurrency, async (i) => {
      const row = promoRows[i % promoRows.length];
      const r = await fetch(`${BASE_URL}/promotions/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: row.code, subtotal: Number(row.subtotal) }),
      });
      await r.arrayBuffer();
      return {
        status: r.status,
        ok: r.status === Number(row.expectedStatus),
      };
    });
    summaryRows.push({
      KichBan: '3. POST /api/promotions/apply (Task 5 Voucher)',
      FileCSV: 'promo_apply_data.csv',
      Concurrency: res.concurrency,
      Samples: res.totalRequests,
      'RPS (req/s)': res.rps,
      'p50 (ms)': res.p50Ms,
      'p95 (ms)': res.p95Ms,
      'p99 (ms)': res.p99Ms,
      'Max (ms)': res.maxMs,
      Pass: `${res.okCount}/${res.totalRequests}`,
      'NFR-01': res.p95Ms <= 3000 && res.failCount === 0 ? 'ĐẠT (<=3000ms)' : 'CẦN XEM LẠI',
    });
  }

  // 4. Auth Login (POST /api/auth/login) từ login_data.csv (CPU-heavy do bcrypt cost=10)
  if (opts.scenario === 'all' || opts.scenario === 'login') {
    const loginSamples = Math.min(opts.requests, 100);
    const loginConcurrency = Math.min(opts.concurrency, 50);
    const res = await runPool(loginSamples, loginConcurrency, async (i) => {
      const row = loginRows[i % loginRows.length];
      const r = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: row.email, password: row.password }),
      });
      await r.arrayBuffer();
      return {
        status: r.status,
        ok: r.status === Number(row.expectedStatus),
      };
    });
    summaryRows.push({
      KichBan: '4. POST /api/auth/login (Bcrypt CPU-bound)',
      FileCSV: 'login_data.csv',
      Concurrency: res.concurrency,
      Samples: res.totalRequests,
      'RPS (req/s)': res.rps,
      'p50 (ms)': res.p50Ms,
      'p95 (ms)': res.p95Ms,
      'p99 (ms)': res.p99Ms,
      'Max (ms)': res.maxMs,
      Pass: `${res.okCount}/${res.totalRequests}`,
      'NFR-01': res.p95Ms <= 3000 && res.failCount === 0 ? 'ĐẠT (<=3000ms)' : 'NGHẼN CPU BCRYPT',
    });
  }

  // 5. Task 6: Tạo đơn + Giữ nguyên liệu (POST /api/orders) từ create_order_data.csv (Chỉ chạy khi chọn --scenario order)
  if (opts.scenario === 'order') {
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@brewlite.com', password: '@Admin123' }),
    });
    const loginJson = await loginRes.json();
    const token = loginJson?.accessToken ?? loginJson?.data?.accessToken;

    const orderSamples = Math.min(opts.requests, 20);
    const orderConcurrency = Math.min(opts.concurrency, 10);
    const res = await runPool(orderSamples, orderConcurrency, async (i) => {
      const row = orderRows[i % orderRows.length];
      const payload = {
        items: [
          {
            productId: row.productId,
            size: row.size,
            qty: Number(row.qty),
            toppings: row.toppingName ? [row.toppingName] : [],
            lineTotal: Number(row.lineTotal),
          },
        ],
        ...(row.promoCode ? { promoCode: row.promoCode } : {}),
      };
      const r = await fetch(`${BASE_URL}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      await r.arrayBuffer();
      return { status: r.status, ok: r.status === 201 || r.status === 400 };
    });
    summaryRows.push({
      KichBan: '5. POST /api/orders (Task 6 Giữ kho DB Tx)',
      FileCSV: 'create_order_data.csv',
      Concurrency: res.concurrency,
      Samples: res.totalRequests,
      'RPS (req/s)': res.rps,
      'p50 (ms)': res.p50Ms,
      'p95 (ms)': res.p95Ms,
      'p99 (ms)': res.p99Ms,
      'Max (ms)': res.maxMs,
      Pass: `${res.okCount}/${res.totalRequests}`,
      'NFR-01': res.p95Ms <= 3000 && res.failCount === 0 ? 'ĐẠT (<=3000ms)' : 'CẦN XEM LẠI',
    });
  }

  console.table(summaryRows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
