# Lab 3 — Kết nối và duy trì kết nối giữa các service

Hệ thống thanh toán học phí: **Fee Service** (cổng 4001) gọi **Ngân hàng giả lập** (cổng 4002).
Node.js ≥ 18 + Express, dữ liệu trong bộ nhớ.

## Cấu trúc

```
lab3/
├── src/
│   ├── bank.js           # Ngân hàng giả lập: /charges, /stats, DELAY_MS, FAIL_RATE, DROP_RATE, Idempotency-Key
│   ├── bank-client.js    # Client HTTP gọi ngân hàng: timeout, phân loại lỗi (connect / timeout / dropped)
│   └── fee-service.js    # Fee Service: công nợ, lệnh thanh toán, thử lại, keep-alive, đối soát PENDING
├── scripts/scenarios.js  # Tự động tái hiện + đo 4 tình huống, trước và sau khi sửa
├── lab3.postman_collection.json  # Import vào Postman để gọi thử
├── results.json          # Số liệu đo được (lần chạy gần nhất)
└── logs/                 # Log của từng tiến trình khi chạy scenarios
```

## Chạy

```bash
npm install
npm run bank                       # cổng 4002
npm run fee                        # cổng 4001
DELAY_MS=5000 npm run bank         # ngân hàng chậm
DROP_RATE=0.3 npm run bank         # trừ tiền xong rồi cắt kết nối
FAIL_RATE=0.3 npm run bank         # lỗi 500 trước khi trừ tiền
FEE_MODE=naive npm run fee         # bản TRƯỚC khi sửa (để so sánh)
BANK_URL=http://localhost:4999 npm run fee

npm run scenarios                  # chạy và đo cả 4 tình huống (~1 phút)
node scripts/scenarios.js 2 3      # chỉ chạy tình huống 2 và 3
```

**Giao diện demo:** mở http://localhost:4001 để xem công nợ, thanh toán, gửi hàng loạt, xem `/stats` của ngân hàng và danh sách lệnh (tự cập nhật mỗi giây).

Gọi thử:

```bash
curl localhost:4001/students/1/fees
curl -X POST localhost:4001/students/1/payments -H 'Content-Type: application/json' -d '{"amount":100000}'
curl localhost:4002/stats
curl localhost:4001/payments          # danh sách lệnh + thống kê PAID/FAILED/PENDING
```

## Hợp đồng API

| Service | Endpoint | Ghi chú |
|---|---|---|
| Fee | `GET /students/{id}/fees` | `{studentId, debt, pendingAmount}` — SV1: 50.000.000đ, SV2: 0, SV3: 3.200.000đ |
| Fee | `POST /students/{id}/payments` `{"amount"}` | 201 PAID / 4xx FAILED (giữ mã ngân hàng) / 503 FAILED / 504 PENDING |
| Fee | `GET /payments`, `GET /payments/{id}` | tra cứu lệnh (phục vụ đo đạc) |
| Bank | `POST /charges` `{"reference","amount"}` | 201 + `chargeId`; 400 sai số tiền; 402 vượt 20.000.000đ; gửi lại cùng `Idempotency-Key` → 200 + giao dịch cũ |
| Bank | `GET /stats` | `{connections, requests, charges, duplicates}` |

Lỗi luôn là JSON `{error, paymentId, status}`.

## Thiết kế phía Fee Service (bản đã sửa)

**1. Phân loại lỗi khi gọi ngân hàng** ([src/bank-client.js](src/bank-client.js)), quyết định mã trả về:

| Loại | Khi nào | Đã trừ tiền? | Fee trả về |
|---|---|---|---|
| `connect` | ECONNREFUSED, DNS, quá 1s chưa kết nối được | Chắc chắn chưa | 503 FAILED |
| ngân hàng 4xx | 400, 402 | Chắc chắn chưa | giữ mã, FAILED, **không thử lại** |
| ngân hàng 5xx | lỗi tạm thời (theo hợp đồng: trước khi trừ) | Chưa | thử lại; hết lượt → 503 FAILED |
| `dropped` | ECONNRESET / socket hang up sau khi đã gửi | **Không biết** | thử lại với cùng Idempotency-Key; hết lượt → 504 PENDING |
| `timeout` | quá thời gian chờ trả lời | **Không biết** | 504 PENDING ngay, không thử lại để khỏi dồn tải lên ngân hàng đang quá tải |

**2. Timeout:** kết nối 1.000ms, mỗi lần gọi ≤ 3.000ms, tổng cho một lệnh (gồm cả các lần thử lại) ≤ 4.000ms. Như vậy cả lệnh luôn xong dưới 4,5s.

**3. Thử lại:** tối đa 4 lần, chờ lùi dần 100 → 200 → 400ms kèm độ ngẫu nhiên (jitter). Chỉ thử lại khi biết là an toàn. Lỗi kết nối chỉ thử lại trong khoảng 1s đầu, để lệnh vẫn trả 503 trong < 1,5s.

**4. Idempotency-Key = mã lệnh (P1, P2…):** mọi lần thử lại của một lệnh đều gửi cùng khóa này. Nếu lần trước ngân hàng đã trừ tiền, ngân hàng trả lại giao dịch cũ, nên không trừ hai lần.

**5. Keep-alive pool:** dùng `http.Agent({keepAlive: true, maxSockets: 10, timeout: 4000})`. Pool bỏ socket nhàn rỗi sau 4s, sớm hơn mốc 5s ngân hàng đóng kết nối, nên không gửi vào socket sắp bị đóng. Node còn đọc header `Keep-Alive: timeout=5` của ngân hàng để tự rút ngắn thời gian giữ. Nếu vẫn gặp socket chết, lỗi `dropped` được thử lại an toàn nhờ Idempotency-Key.

**6. Giữ chỗ công nợ:** khi tạo lệnh, số tiền được cộng vào `reserved`. Công nợ chỉ giảm khi lệnh thành PAID. Lệnh FAILED trả lại phần giữ chỗ. Lệnh PENDING vẫn giữ chỗ, để các thanh toán song song không vượt công nợ.

**7. Đối soát lệnh PENDING:** cứ 10s (đổi bằng `RECONCILE_INTERVAL_MS`), Fee Service gửi lại các lệnh PENDING với cùng Idempotency-Key. Ngân hàng trả 200/201 thì lệnh thành PAID và công nợ giảm; trả 4xx thì lệnh thành FAILED. Nhờ vậy trạng thái "không biết" luôn được chốt lại về sau.

**8. Không để service sập:** mọi lỗi mạng đều được bắt và trả JSON. Bản `naive` cố tình không bắt lỗi để tái hiện sự cố.

Các cờ để bật/tắt từng biện pháp khi đo: `FEE_MODE=naive`, `KEEP_ALIVE=0`, `RETRY=0`, `IDEMPOTENCY=0`, `UNSAFE_RETRY=1`, `RECONCILE_INTERVAL_MS=0`.

## Kết quả đo (máy local, Node 20)

### Tình huống 1 — Ngân hàng không kết nối được, rồi hoạt động lại

| | Trước (naive) | Sau | Sau, `BANK_URL=:4999` |
|---|---|---|---|
| Thanh toán khi ngân hàng tắt | Mất kết nối (Fee **sập** vì lỗi không được bắt) | **503** `{error, paymentId:"P1", status:"FAILED"}` trong **806ms** | **503** trong **792ms** |
| `GET /students/1/fees` ngay sau | Không phản hồi (đã sập) | **200 trong 3ms** | 200 trong 7ms |
| Fee Service còn sống | Không | **Có** | Có |
| Bật ngân hàng, gọi lại (không restart Fee) | ECONNREFUSED | **201 PAID** (12ms) | **201 PAID** (9ms) |

Đạt: 503 trong < 1,5s, service không sập, tự kết nối lại khi ngân hàng chạy lại, địa chỉ ngân hàng lấy từ `BANK_URL`.

### Tình huống 2 — Ngân hàng chậm (`DELAY_MS=5000`)

| | Trước | Sau |
|---|---|---|
| 1 thanh toán | 201 sau **5.073ms** (sinh viên phải chờ) | **504 PENDING sau 3.030ms** |
| 20 thanh toán đồng thời | 20 × 201, lâu nhất 5.020ms | 20 × **504 PENDING**, lâu nhất **3.031ms** |
| `GET /fees` khi 20 lệnh đang chờ | 2–8ms | **3–4ms** (< 300ms) |

Đạt: 504 + PENDING, tổng thời gian ≤ 4,5s, xem công nợ vẫn nhanh. Node xử lý bất đồng bộ nên dù lệnh thanh toán đang chờ, việc xem công nợ không bị chặn. Các lệnh PENDING sau đó được đối soát và thành PAID.

### Tình huống 3 — Duy trì kết nối (200 lệnh × 1.000đ, 10 đồng thời)

| | Trước (mỗi lần 1 kết nối) | Sau (keep-alive pool) |
|---|---|---|
| Thành công | 200/200 | **200/200** |
| Tổng thời gian | 143ms | 107ms |
| `connections` sau 200 lệnh | **201** | **11** (10 socket trong pool + 1 kết nối của script đọc `/stats`) |
| Nhàn rỗi 6s rồi gửi 5 lệnh | 5/5 thành công | **5/5 thành công**, `connections` = 17 |
| `duplicates` | 0 | 0 |

Đạt: ≤ 20 kết nối, vẫn chạy đúng sau khi ngân hàng đóng kết nối nhàn rỗi. Trên localhost, bắt tay TCP rất rẻ nên thời gian chỉ chênh khoảng 25%. Qua mạng thật (có RTT, có TLS), mỗi lần bắt tay tốn hàng chục ms, nên giữ kết nối sẽ tiết kiệm nhiều hơn hẳn.

### Tình huống 4 — Đứt giữa chừng, lỗi tạm thời, bị từ chối (60 lệnh × 100.000đ, lần lượt)

| Biến thể | PAID/60 | Bank `requests` / `charges` / `duplicates` | Công nợ | Lâu nhất |
|---|---|---|---|---|
| (a) DROP 0.3 — trước (naive) | 7 (rồi **Fee sập**) | 8 / 8 / 0 | — | 32ms |
| (a) DROP 0.3 — thử lại **không** Idempotency-Key | 60 | 79 / **79** / **19** | Fee ghi giảm 6.000.000đ nhưng ngân hàng trừ **7.900.000đ** | 395ms |
| **(a) DROP 0.3 — sau** | **60** | 84 / **60** / **0** | giảm đúng 6.000.000đ = 60 lệnh PAID | 390ms |
| (b) FAIL 0.3 — trước (naive) | 44 (16 lệnh lỗi 500) | 60 / 44 / 0 | đúng | 28ms |
| **(b) FAIL 0.3 — sau** | **60** | 75 / 60 / **0** (chỉ 2 kết nối TCP) | giảm đúng 6.000.000đ | 826ms |
| **(c) 25.000.000đ — sau** | 402 `{error:"Vượt hạn mức…", paymentId, status:"FAILED"}` | requests = **1**, charges = 0 | không đổi | 31ms |

Đạt: duplicates = 0, ≥ 54/60 thành công, công nợ khớp các lệnh PAID, 402 không thử lại (ngân hàng nhận đúng 1 yêu cầu), mọi lệnh ≤ 4,5s.
Ở một lần chạy khác, FAIL 0.3 có 59/60: một lệnh dính 500 cả 4 lần (xác suất 0,3⁴ ≈ 0,8%) và trả 503 FAILED, đúng quy ước.

Kiểm tra thêm nhánh PENDING (`DROP_RATE=0.85`): lệnh P4 bị đứt kết nối cả 4 lần nên trả **504 PENDING**. Công nợ không giảm, 100.000đ vẫn được giữ chỗ. Ngân hàng thực tế đã trừ tiền (charges = 4). Job đối soát gửi lại với cùng khóa → `P4: PENDING -> PAID`, duplicates = 0.

## Bài học rút ra

1. **Phải có timeout cho mọi lời gọi ra ngoài.** Không có timeout thì một bên thứ ba chậm sẽ kéo cả hệ thống chậm theo.
2. **Phân biệt "chắc chắn chưa trừ tiền" với "không biết".** Lỗi kết nối và 4xx là chắc chắn chưa trừ, nên trả FAILED. Hết thời gian chờ hoặc đứt kết nối giữa chừng thì không biết, phải trả PENDING và đối soát sau, không được tự cho là thất bại.
3. **Thử lại mà không có idempotency là nguy hiểm.** Ở tình huống 4a, chỉ cần thử lại không kèm Idempotency-Key là ngân hàng trừ tiền trùng 19 lần. Thêm khóa thì thử lại bao nhiêu lần cũng an toàn.
4. **Chỉ thử lại lỗi tạm thời.** Lỗi bị từ chối (402) có thử lại cũng không thành công. Ngân hàng đang quá tải mà thử lại thì chỉ dồn thêm tải.
5. **Giữ kết nối (keep-alive) với thời gian nhàn rỗi ngắn hơn phía server.** Kết nối TCP giảm từ 201 xuống 11, và không gặp lỗi gửi vào socket mà server vừa đóng.
