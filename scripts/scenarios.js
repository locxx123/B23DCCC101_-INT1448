// Chạy tự động 4 tình huống, đo TRƯỚC (FEE_MODE=naive / tắt từng biện pháp) và SAU khi sửa.
// Dùng: node scripts/scenarios.js [1|2|3|4 ...]   (không truyền gì = chạy hết)
// Kết quả: in ra màn hình + ghi results.json; log tiến trình nằm trong logs/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const FEE = 'http://localhost:4001';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------- quản lý tiến trình ----------
const procs = new Set();
function start(name, script, env, logName) {
  const out = fs.openSync(path.join(LOG_DIR, `${logName}.log`), 'w');
  const p = spawn(process.execPath, [path.join(ROOT, 'src', script)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
  });
  p.exited = new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })));
  p.alive = true;
  p.exited.then(() => { p.alive = false; procs.delete(p); });
  procs.add(p);
  return p;
}
async function stop(p) {
  if (p && p.alive) { p.kill('SIGTERM'); await p.exited; }
}
async function stopAll() { await Promise.all([...procs].map(stop)); }
async function waitUp(url) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url, { signal: AbortSignal.timeout(500) }); return; } catch { await sleep(50); }
  }
  throw new Error('Không khởi động được ' + url);
}
const startBank = async (env = {}, log = 'bank') => {
  const p = start('bank', 'bank.js', env, log);
  await waitUp(`http://localhost:${env.PORT || 4002}/stats`);
  return p;
};
const startFee = async (env = {}, log = 'fee') => {
  const p = start('fee', 'fee-service.js', env, log);
  await waitUp(`${FEE}/students/1/fees`);
  return p;
};
const bankStats = async (port = 4002) => (await fetch(`http://localhost:${port}/stats`)).json();

// ---------- gọi Fee Service ----------
async function pay(studentId, amount, timeoutMs = 15000) {
  const t0 = now();
  try {
    const r = await fetch(`${FEE}/students/${studentId}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.json().catch(() => null);
    return { http: r.status, body, ms: Math.round(now() - t0) };
  } catch (e) {
    return { http: 'ERR', body: { error: e.cause?.code || e.name }, ms: Math.round(now() - t0) };
  }
}
async function getFees(studentId = 1) {
  const t0 = now();
  try {
    const r = await fetch(`${FEE}/students/${studentId}/fees`, { signal: AbortSignal.timeout(2000) });
    return { http: r.status, body: await r.json(), ms: Math.round(now() - t0) };
  } catch (e) {
    return { http: 'ERR', body: { error: e.cause?.code || e.name }, ms: Math.round(now() - t0) };
  }
}
async function pool(n, concurrency, fn) {
  const results = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < n) { const i = next++; results[i] = await fn(i); }
  }));
  return results;
}
const countBy = (arr, key) => arr.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + 1), m), {});
const fmt = (o) => JSON.stringify(o);

// ---------- Tình huống 1 ----------
async function scenario1() {
  const out = {};
  const variants = [
    ['TRƯỚC (naive)', { FEE_MODE: 'naive' }, 4002],
    ['SAU', {}, 4002],
    ['SAU, BANK_URL=:4999', { BANK_URL: 'http://localhost:4999' }, 4999],
  ];
  for (const [label, env, bankPort] of variants) {
    const fee = await startFee(env, `s1-fee-${bankPort}-${env.FEE_MODE || 'resilient'}`);
    const down = await pay(1, 100000);
    await sleep(200);
    const feesAfter = await getFees(1);
    const bank = await startBank({ PORT: String(bankPort) }, `s1-bank-${bankPort}`);
    const up = await pay(1, 100000);
    out[label] = {
      'ngân hàng tắt': `${down.http} ${fmt(down.body)} trong ${down.ms}ms`,
      'GET /fees ngay sau đó': `${feesAfter.http} trong ${feesAfter.ms}ms`,
      'Fee Service còn sống': fee.alive,
      'ngân hàng bật lại (không restart Fee)': `${up.http} ${up.body?.status || fmt(up.body)} trong ${up.ms}ms`,
    };
    await stopAll();
  }
  return out;
}

// ---------- Tình huống 2 ----------
async function scenario2() {
  const out = {};
  for (const [label, env] of [['TRƯỚC (naive)', { FEE_MODE: 'naive' }], ['SAU', {}]]) {
    await startBank({ DELAY_MS: '5000' }, 's2-bank');
    await startFee(env, `s2-fee-${env.FEE_MODE || 'resilient'}`);
    const one = await pay(1, 100000);
    const t0 = now();
    const burst = Promise.all(Array.from({ length: 20 }, () => pay(1, 100000)));
    await sleep(500);
    const feeChecks = [];
    for (let i = 0; i < 5; i++) { feeChecks.push(await getFees(1)); await sleep(300); }
    const res = await burst;
    out[label] = {
      '1 thanh toán': `${one.http} ${one.body?.status} trong ${one.ms}ms`,
      '20 thanh toán đồng thời': fmt(countBy(res, (r) => `${r.http} ${r.body?.status}`)),
      'thời gian lâu nhất / cả đợt': `${Math.max(...res.map((r) => r.ms))}ms / ${Math.round(now() - t0)}ms`,
      'GET /fees khi đang chờ (ms)': feeChecks.map((f) => `${f.http}:${f.ms}`).join(', '),
    };
    await stopAll();
  }
  return out;
}

// ---------- Tình huống 3 ----------
async function scenario3() {
  const out = {};
  for (const [label, env] of [['TRƯỚC (naive, mỗi lần 1 kết nối)', { FEE_MODE: 'naive' }], ['SAU (keep-alive pool)', {}]]) {
    await startBank({}, 's3-bank');
    await startFee(env, `s3-fee-${env.FEE_MODE || 'resilient'}`);
    const t0 = now();
    const res = await pool(200, 10, () => pay(1, 1000));
    const total = Math.round(now() - t0);
    const s1 = await bankStats();
    await sleep(6000); // nhàn rỗi 6s: ngân hàng đã đóng kết nối cũ
    const after = await pool(5, 5, () => pay(1, 1000));
    const s2 = await bankStats();
    out[label] = {
      'thành công / 200': res.filter((r) => r.http === 201).length,
      'tổng thời gian': `${total}ms`,
      'connections sau 200 lệnh': s1.connections,
      'sau 6s nhàn rỗi, 5 lệnh': fmt(countBy(after, (r) => r.http)),
      'connections cuối': s2.connections,
      duplicates: s2.duplicates,
    };
    await stopAll();
  }
  return out;
}

// ---------- Tình huống 4 ----------
async function run60(feeEnv, bankEnv, tag) {
  await startBank(bankEnv, `s4-bank-${tag}`);
  const fee = await startFee({ RECONCILE_INTERVAL_MS: '0', ...feeEnv }, `s4-fee-${tag}`);
  const res = [];
  for (let i = 0; i < 60; i++) res.push(await pay(1, 100000, 8000));
  const stats = await bankStats();
  const fees = await getFees(1);
  let paidAmount = null;
  if (fee.alive) {
    const list = await (await fetch(`${FEE}/payments`)).json();
    paidAmount = list.payments.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
  }
  const paid = res.filter((r) => r.http === 201).length;
  const alive = fee.alive;
  const decreased = alive ? 50_000_000 - fees.body.debt : null;
  await stopAll();
  return {
    'PAID / 60': paid,
    'phân loại phản hồi': fmt(countBy(res, (r) => `${r.http} ${r.body?.status || r.body?.error}`)),
    'thời gian lâu nhất': `${Math.max(...res.map((r) => r.ms))}ms`,
    'bank /stats': fmt(stats),
    'công nợ khớp PAID': alive
      ? (decreased === paidAmount ? `đúng (giảm ${paidAmount.toLocaleString('vi-VN')}đ = ${paidAmount / 100000} lệnh PAID)` : `SAI: giảm ${decreased}, PAID ${paidAmount}`)
      : 'Fee Service đã sập',
    'Fee Service còn sống': alive,
  };
}

async function scenario4() {
  const out = {};
  out['(a) DROP_RATE=0.3 — TRƯỚC (naive)'] = await run60({ FEE_MODE: 'naive' }, { DROP_RATE: '0.3' }, 'a-naive');
  out['(a) DROP_RATE=0.3 — thử lại KHÔNG có Idempotency-Key'] = await run60({ IDEMPOTENCY: '0', UNSAFE_RETRY: '1' }, { DROP_RATE: '0.3' }, 'a-unsafe');
  out['(a) DROP_RATE=0.3 — SAU'] = await run60({}, { DROP_RATE: '0.3' }, 'a-after');
  out['(b) FAIL_RATE=0.3 — TRƯỚC (naive)'] = await run60({ FEE_MODE: 'naive' }, { FAIL_RATE: '0.3' }, 'b-naive');
  out['(b) FAIL_RATE=0.3 — SAU'] = await run60({}, { FAIL_RATE: '0.3' }, 'b-after');

  for (const [label, env] of [['(c) 25.000.000đ — TRƯỚC (naive)', { FEE_MODE: 'naive' }], ['(c) 25.000.000đ — SAU', {}]]) {
    await startBank({}, 's4-bank-c');
    await startFee(env, `s4-fee-c-${env.FEE_MODE || 'resilient'}`);
    const r = await pay(1, 25_000_000);
    const st = await bankStats();
    out[label] = { 'phản hồi': `${r.http} ${fmt(r.body)} trong ${r.ms}ms`, 'bank requests': st.requests, 'bank charges': st.charges };
    await stopAll();
  }
  return out;
}

// ---------- main ----------
const all = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4 };
(async () => {
  const pick = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(all);
  const file = path.join(ROOT, 'results.json');
  const results = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  try {
    for (const k of pick) {
      console.log(`\n========== TÌNH HUỐNG ${k} ==========`);
      results[`TH${k}`] = await all[k]();
      for (const [variant, data] of Object.entries(results[`TH${k}`])) {
        console.log(`\n--- ${variant}`);
        for (const [m, v] of Object.entries(data)) console.log(`  ${m}: ${v}`);
      }
      fs.writeFileSync(file, JSON.stringify(results, null, 2));
    }
  } finally {
    await stopAll();
  }
})().catch(async (e) => { console.error(e); await stopAll(); process.exit(1); });
