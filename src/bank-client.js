// Client gọi ngân hàng: một lần gọi HTTP, có timeout kết nối + timeout tổng,
// và PHÂN LOẠI lỗi để tầng trên quyết định trả 503 (chắc chắn chưa gửi) hay 504 (không biết).
const http = require('http');

class BankError extends Error {
  // kind:
  //   'connect' — không kết nối được (ECONNREFUSED, DNS, quá hạn kết nối) => chắc chắn CHƯA gửi
  //   'timeout' — đã gửi nhưng hết thời gian chờ trả lời            => KHÔNG BIẾT
  //   'dropped' — đứt kết nối khi đang chờ trả lời                   => KHÔNG BIẾT
  constructor(kind, message, cause) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
  get ambiguous() {
    return this.kind !== 'connect';
  }
}

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function postJson(baseUrl, path, body, { agent, headers = {}, timeoutMs, connectTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = JSON.stringify(body);
    let settled = false;
    let connected = false; // đã có kết nối TCP => lỗi sau thời điểm này là "không biết"
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      fn(v);
    };

    const req = http.request(url, {
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    });

    // Timeout tổng cho lần gọi (tính cả thời gian chờ socket trong pool)
    const totalTimer = setTimeout(() => {
      done(reject, new BankError('timeout', `Ngân hàng không trả lời trong ${timeoutMs}ms`));
      req.destroy();
    }, timeoutMs);
    let connectTimer;

    req.on('socket', (socket) => {
      if (!socket.connecting) {
        connected = true; // socket tái sử dụng từ pool keep-alive
        return;
      }
      connectTimer = setTimeout(() => {
        done(reject, new BankError('connect', `Không kết nối được ngân hàng trong ${connectTimeoutMs}ms`));
        req.destroy();
      }, connectTimeoutMs);
      socket.once('connect', () => {
        connected = true;
        clearTimeout(connectTimer);
      });
    });

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* body không phải JSON */ }
        done(resolve, { status: res.statusCode, body: json });
      });
      res.on('error', (err) => done(reject, new BankError('dropped', 'Đứt kết nối khi đang đọc phản hồi', err)));
    });

    req.on('error', (err) => {
      if (!connected && CONNECT_ERRORS.has(err.code)) {
        done(reject, new BankError('connect', `Không kết nối được ngân hàng (${err.code})`, err));
      } else {
        // ECONNRESET / socket hang up sau khi đã gửi: ngân hàng có thể đã trừ tiền
        done(reject, new BankError('dropped', `Đứt kết nối với ngân hàng (${err.code || err.message})`, err));
      }
    });

    req.end(payload);
  });
}

// Phiên bản "ngây thơ" (trước khi sửa): không timeout, không xử lý lỗi, mỗi lần một kết nối mới.
// Lỗi mạng sẽ thành exception không ai bắt => Fee Service sập.
function naivePostJson(baseUrl, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(new URL(path, baseUrl), {
      method: 'POST',
      agent: false, // không dùng pool => mỗi lời gọi mở một kết nối TCP mới
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    // Cố tình KHÔNG gắn req.on('error') — đúng kiểu code "chạy được trên máy em"
    req.end(payload);
  });
}

module.exports = { BankError, postJson, naivePostJson };
