// Fee Service — cổng 4001
//   GET  /students/:id/fees
//   POST /students/:id/payments  {"amount": 100000}
//   GET  /payments, GET /payments/:id   (tra cứu lệnh, phục vụ đo đạc)
//
// FEE_MODE=naive      -> bản "trước khi sửa": không timeout, không bắt lỗi, không keep-alive, không thử lại
// FEE_MODE=resilient  -> bản đã sửa (mặc định). Có thể tắt từng biện pháp để so sánh:
//   KEEP_ALIVE=0  RETRY=0  IDEMPOTENCY=0  RECONCILE_INTERVAL_MS=0
//   UNSAFE_RETRY=1 (cùng IDEMPOTENCY=0) để tái hiện lỗi trừ tiền hai lần
const express = require('express');
const http = require('http');
const { BankError, postJson, naivePostJson } = require('./bank-client');

const env = (name, def) => (process.env[name] === undefined ? def : process.env[name]);
const flag = (name, def) => env(name, def ? '1' : '0') !== '0';

const config = {
  port: Number(env('PORT', 4001)),
  mode: env('FEE_MODE', 'resilient'),
  bankUrl: env('BANK_URL', 'http://localhost:4002'),
  keepAlive: flag('KEEP_ALIVE', true),
  retry: flag('RETRY', true),
  idempotency: flag('IDEMPOTENCY', true),
  unsafeRetry: flag('UNSAFE_RETRY', false), // chỉ để demo: thử lại khi đứt kết nối dù KHÔNG có Idempotency-Key
  connectTimeoutMs: Number(env('CONNECT_TIMEOUT_MS', 1000)), // TH1: 503 trong < 1,5 giây
  attemptTimeoutMs: Number(env('ATTEMPT_TIMEOUT_MS', 3000)), // một lần gọi
  deadlineMs: Number(env('DEADLINE_MS', 4000)),              // TH2: tổng thời gian ≤ 4,5 giây
  maxAttempts: Number(env('MAX_ATTEMPTS', 4)),
  reconcileIntervalMs: Number(env('RECONCILE_INTERVAL_MS', 10000)),
};

// Pool kết nối tới ngân hàng (TH3). Ngân hàng đóng kết nối nhàn rỗi sau 5s,
// nên phía mình bỏ socket nhàn rỗi sớm hơn (4s) để không gửi vào socket sắp bị đóng.
const bankAgent = new http.Agent({
  keepAlive: config.keepAlive,
  maxSockets: 10,
  maxFreeSockets: 10,
  timeout: 4000,
});

// ---- Dữ liệu trong bộ nhớ ----
const students = new Map([
  ['1', { id: '1', debt: 50_000_000, reserved: 0 }],
  ['2', { id: '2', debt: 0, reserved: 0 }],
  ['3', { id: '3', debt: 3_200_000, reserved: 0 }],
]);
const payments = new Map();
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => 100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 50); // 100, 200, 400ms + jitter

// ---- Gọi ngân hàng có thử lại ----
// Trả về { outcome: 'PAID'|'REJECTED'|'FAILED'|'PENDING', bankStatus, charge, error }
async function chargeWithRetry(payment) {
  const started = Date.now();
  const headers = config.idempotency ? { 'Idempotency-Key': payment.id } : {};
  let sawAmbiguous = false; // đã từng gặp tình huống "không biết đã trừ tiền chưa"
  let lastError = null;

  for (let attempt = 1; ; attempt++) {
    const remaining = config.deadlineMs - (Date.now() - started);
    payment.attempts = attempt;
    let retryable = false;
    try {
      const res = await postJson(config.bankUrl, '/charges',
        { reference: payment.id, amount: payment.amount },
        {
          agent: bankAgent,
          headers,
          timeoutMs: Math.min(config.attemptTimeoutMs, remaining),
          connectTimeoutMs: config.connectTimeoutMs,
        });

      if (res.status === 200 || res.status === 201) {
        return { outcome: 'PAID', charge: res.body };
      }
      if (res.status >= 400 && res.status < 500) {
        // Ngân hàng từ chối rõ ràng (400, 402...) — KHÔNG thử lại
        return { outcome: 'REJECTED', bankStatus: res.status, error: res.body?.error || `Ngân hàng từ chối (${res.status})` };
      }
      // 5xx: lỗi tạm thời, theo hợp đồng ngân hàng là trước khi trừ tiền => thử lại được
      lastError = `Ngân hàng lỗi tạm thời (${res.status})`;
      retryable = true;
    } catch (err) {
      if (!(err instanceof BankError)) throw err;
      lastError = err.message;
      if (err.ambiguous) sawAmbiguous = true;
      // connect: chưa gửi gì => thử lại an toàn, nhưng chỉ trong ~1s đầu để giữ < 1,5s
      // dropped: có thể đã trừ tiền => chỉ thử lại khi có Idempotency-Key (ngân hàng trả giao dịch cũ)
      // timeout: ngân hàng đang quá tải => không dồn thêm tải, trả PENDING ngay
      if (err.kind === 'connect') retryable = Date.now() - started < config.connectTimeoutMs;
      else if (err.kind === 'dropped') retryable = config.idempotency || config.unsafeRetry;
      else retryable = false;
    }

    const wait = backoff(attempt);
    const timeLeft = config.deadlineMs - (Date.now() - started);
    if (!config.retry || !retryable || attempt >= config.maxAttempts || timeLeft < wait + 200) break;
    await sleep(wait);
  }

  return sawAmbiguous
    ? { outcome: 'PENDING', error: lastError }
    : { outcome: 'FAILED', error: lastError };
}

function markPaid(payment, charge) {
  if (payment.status === 'PAID') return;
  const s = students.get(payment.studentId);
  s.reserved -= payment.amount;
  s.debt -= payment.amount; // công nợ chỉ giảm khi ngân hàng đã trừ tiền
  payment.status = 'PAID';
  payment.chargeId = charge?.chargeId;
}

function markFailed(payment, error) {
  const s = students.get(payment.studentId);
  s.reserved -= payment.amount;
  payment.status = 'FAILED';
  payment.error = error;
}

// ---- Đối soát lệnh PENDING: gửi lại cùng Idempotency-Key, ngân hàng trả giao dịch cũ nếu đã trừ ----
let reconciling = false;
async function reconcilePending() {
  if (reconciling || !config.idempotency) return;
  reconciling = true;
  try {
    for (const p of payments.values()) {
      if (p.status !== 'PENDING') continue;
      try {
        const res = await postJson(config.bankUrl, '/charges', { reference: p.id, amount: p.amount }, {
          agent: bankAgent,
          headers: { 'Idempotency-Key': p.id },
          timeoutMs: config.attemptTimeoutMs,
          connectTimeoutMs: config.connectTimeoutMs,
        });
        if (res.status === 200 || res.status === 201) {
          markPaid(p, res.body);
          console.log(`[fee] đối soát ${p.id}: PENDING -> PAID`);
        } else if (res.status >= 400 && res.status < 500) {
          markFailed(p, res.body?.error);
          console.log(`[fee] đối soát ${p.id}: PENDING -> FAILED`);
        }
      } catch { /* vẫn PENDING, lần sau thử tiếp */ }
    }
  } finally {
    reconciling = false;
  }
}

// ---- HTTP API ----
const app = express();
app.use(express.json());
app.use(express.static(require('path').join(__dirname, '..', 'public'))); // giao diện demo tại "/"

// Phục vụ giao diện: cấu hình đang chạy + số liệu ngân hàng (đi qua Fee để khỏi vướng CORS)
app.get('/ui/config', (req, res) => res.json(config));
app.get('/ui/bank-stats', async (req, res) => {
  try {
    const r = await fetch(new URL('/stats', config.bankUrl), { signal: AbortSignal.timeout(1000) });
    res.json({ up: true, ...(await r.json()) });
  } catch {
    res.json({ up: false });
  }
});

app.get('/students/:id/fees', (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  res.json({ studentId: s.id, debt: s.debt, pendingAmount: s.reserved });
});

app.get('/payments', (req, res) => {
  const list = [...payments.values()];
  const summary = {};
  for (const p of list) summary[p.status] = (summary[p.status] || 0) + 1;
  res.json({ summary, payments: list });
});

app.get('/payments/:id', (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Không tìm thấy lệnh thanh toán' });
  res.json(p);
});

app.post('/students/:id/payments', async (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy sinh viên', paymentId: null, status: 'FAILED' });

  const amount = req.body?.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount phải là số nguyên dương', paymentId: null, status: 'FAILED' });
  }
  // Trừ cả phần đang giữ chỗ cho các lệnh chưa xong, để thanh toán song song không vượt công nợ
  if (amount > s.debt - s.reserved) {
    return res.status(400).json({ error: `Số tiền vượt công nợ còn lại (${s.debt - s.reserved}đ)`, paymentId: null, status: 'FAILED' });
  }

  const payment = { id: `P${++seq}`, studentId: s.id, amount, status: 'PROCESSING', attempts: 0, createdAt: new Date().toISOString() };
  payments.set(payment.id, payment);
  s.reserved += amount;

  if (config.mode === 'naive') return naivePay(payment, res);

  const result = await chargeWithRetry(payment);
  switch (result.outcome) {
    case 'PAID':
      markPaid(payment, result.charge);
      return res.status(201).json({ paymentId: payment.id, status: 'PAID', chargeId: payment.chargeId, amount, remainingDebt: s.debt });
    case 'REJECTED':
      markFailed(payment, result.error);
      return res.status(result.bankStatus).json({ error: result.error, paymentId: payment.id, status: 'FAILED' });
    case 'FAILED':
      markFailed(payment, result.error);
      return res.status(503).json({ error: result.error, paymentId: payment.id, status: 'FAILED' });
    case 'PENDING':
      payment.status = 'PENDING'; // giữ nguyên phần giữ chỗ, chờ đối soát
      payment.error = result.error;
      return res.status(504).json({ error: result.error, paymentId: payment.id, status: 'PENDING' });
  }
});

// Bản trước khi sửa
async function naivePay(payment, res) {
  const r = await naivePostJson(config.bankUrl, '/charges', { reference: payment.id, amount: payment.amount });
  if (r.status === 201) {
    markPaid(payment, r.body);
    return res.status(201).json({ paymentId: payment.id, status: 'PAID', chargeId: payment.chargeId });
  }
  markFailed(payment, r.body?.error);
  res.status(r.status).json({ error: r.body?.error, paymentId: payment.id, status: 'FAILED' });
}

app.listen(config.port, () => {
  console.log(`[fee] lắng nghe :${config.port}`, JSON.stringify(config));
});

if (config.mode !== 'naive' && config.reconcileIntervalMs > 0) {
  setInterval(reconcilePending, config.reconcileIntervalMs).unref();
}
