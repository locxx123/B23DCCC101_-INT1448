// Ngân hàng giả lập — cổng 4002
// Hành vi lỗi đặt bằng biến môi trường (khởi động lại để áp dụng):
//   DELAY_MS  — trễ thêm ngần ấy ms trước khi xử lý
//   FAIL_RATE — tỉ lệ trả 500 TRƯỚC khi trừ tiền
//   DROP_RATE — tỉ lệ trừ tiền XONG rồi cắt kết nối, không trả lời
const express = require('express');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4002);
const DELAY_MS = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);
const DROP_RATE = Number(process.env.DROP_RATE || 0);
const LIMIT = 20_000_000;

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const chargesByKey = new Map();       // Idempotency-Key -> Promise<charge>
const chargeCountByRef = new Map();   // reference -> số lần đã trừ tiền

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(express.json());

app.get('/stats', (req, res) => res.json(stats));

app.post('/charges', async (req, res) => {
  stats.requests++;
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'Lỗi tạm thời của ngân hàng (chưa trừ tiền)' });
  }

  const { reference, amount } = req.body || {};
  if (typeof reference !== 'string' || !reference || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'reference hoặc amount không hợp lệ' });
  }
  if (amount > LIMIT) {
    return res.status(402).json({ error: `Vượt hạn mức ${LIMIT.toLocaleString('vi-VN')}đ` });
  }

  const key = req.get('Idempotency-Key');
  let replayed = false;
  let charge;
  if (key && chargesByKey.has(key)) {
    // Gửi lại cùng khóa: trả lại giao dịch cũ (kể cả khi giao dịch cũ đang xử lý dở)
    replayed = true;
    charge = await chargesByKey.get(key);
  } else {
    charge = {
      chargeId: 'CH-' + crypto.randomUUID().slice(0, 8),
      reference,
      amount,
      createdAt: new Date().toISOString(),
    };
    if (key) chargesByKey.set(key, Promise.resolve(charge));
    stats.charges++;
    const n = (chargeCountByRef.get(reference) || 0) + 1;
    chargeCountByRef.set(reference, n);
    if (n > 1) {
      stats.duplicates++;
      console.warn(`[bank] TRỪ TIỀN TRÙNG reference=${reference} (lần ${n})`);
    }
  }

  if (Math.random() < DROP_RATE) {
    // Đã trừ tiền rồi nhưng cắt kết nối trước khi trả lời
    return req.socket.destroy();
  }

  res.status(replayed ? 200 : 201).json({ ...charge, replayed });
});

const server = app.listen(PORT, () => {
  console.log(`[bank] lắng nghe :${PORT} DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE}`);
});
server.keepAliveTimeout = 5000; // mặc định của Node.js: đóng kết nối nhàn rỗi sau 5 giây
server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[bank] kết nối TCP mới #${stats.connections} từ ${socket.remoteAddress}:${socket.remotePort}`);
});
