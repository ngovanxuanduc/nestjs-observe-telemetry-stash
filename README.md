# nestjs-observe-telemetry-stash

Zero-config offline telemetry stash and compressed file sink for `nestjs-observe`.

Giúp ứng dụng NestJS tự mở HTTP Receiver local để chặn triệt để lỗi `ECONNREFUSED` từ `ObserveAgentWorker`, lưu trữ nén Gzip (`.jsonl.gz`) tối ưu đĩa/CPU và hỗ trợ CLI Replay dữ liệu lên SigNoz / OpenTelemetry Collector khi cần.

---

## 🚀 Quick Start (Zero-Config)

Chỉ cần import thư viện ở **dòng đầu tiên** của file `src/main.ts`:

```typescript
import "nestjs-observe-telemetry-stash"; // 👈 Bắt buộc ở dòng 1 (trước tất cả import khác)

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
```

---

## ⚙️ Custom Configuration

Nếu không muốn dùng cổng `3301` hoặc đường dẫn lưu trữ mặc định, bạn có thể gọi hàm `configureStash()` để tùy chỉnh:

```typescript
import { configureStash } from "nestjs-observe-telemetry-stash";

configureStash({
  port: 3301, // Port HTTP Receiver (Mặc định: 3301)
  storageDir: "./telemetry-stash", // Thư mục lưu file (Mặc định: ./telemetry-storage)
  raw: true, // Bật lưu nén .jsonl.gz để replay (Mặc định: true)
  readable: true, // Bật xuất OTLP JSON thô để debug local (Mặc định: false)
});
```

### Environment Variables

Bạn cũng có thể cấu hình nhanh thông qua file `.env` mà không cần sửa code:

| Biến môi trường         | Mặc định              | Mô tả                                               |
| ----------------------- | --------------------- | --------------------------------------------------- |
| `TELEMETRY_PORT`        | `3301`                | Cổng HTTP Receiver hứng telemetry từ Observe Worker |
| `TELEMETRY_STORAGE_DIR` | `./telemetry-storage` | Thư mục đĩa dùng để ghi file stash                  |

---

## 🔄 CLI Replay Tool

Sử dụng lệnh `telemetry-stash-replay` (hoặc `npx telemetry-stash-replay`) để đọc file nén và đẩy ngược dữ liệu lên SigNoz / OTLP Collector.

### Danh sách Tham số CLI Flags

| Flag                   | Mặc định                           | Mô tả                           |
| ---------------------- | ---------------------------------- | ------------------------------- |
| `--date=YYYY-MM-DD`    | Ngày hiện tại                      | Ngày của thư mục log cần replay |
| `--dir=PATH`           | `./telemetry-storage`              | Thư mục lưu trữ telemetry       |
| `--target-traces=URL`  | `http://localhost:4318/v1/traces`  | OTLP Traces Receiver Endpoint   |
| `--target-logs=URL`    | `http://localhost:4318/v1/logs`    | OTLP Logs Receiver Endpoint     |
| `--target-metrics=URL` | `http://localhost:4318/v1/metrics` | OTLP Metrics Receiver Endpoint  |

### Ví dụ lệnh chạy thực tế

**1. Replay dữ liệu hôm nay về SigNoz Local:**

```bash
npx telemetry-stash-replay

```

**2. Replay dữ liệu theo ngày chỉ định:**

```bash
npx telemetry-stash-replay --date=2026-09-04

```

**3. Replay từ thư mục đĩa tùy chỉnh:**

```bash
npx telemetry-stash-replay --dir=./my-stash-folder --date=2026-09-04

```

**4. Replay lên SigNoz Server từ xa:**

```bash
npx telemetry-stash-replay \
  --date=2026-09-04 \
  --target-traces=[http://192.168.1.100:4318/v1/traces](http://192.168.1.100:4318/v1/traces) \
  --target-logs=[http://192.168.1.100:4318/v1/logs](http://192.168.1.100:4318/v1/logs) \
  --target-metrics=[http://192.168.1.100:4318/v1/metrics](http://192.168.1.100:4318/v1/metrics)

```

---

## 📁 Cấu trúc lưu trữ dữ liệu

Dữ liệu sẽ tự động phân loại theo từng ngày:

```text
telemetry-storage/
└── 2026-09-04/
    ├── raw-payloads.jsonl.gz    # Dữ liệu Gzip thô siêu nhẹ (dùng để Replay)
    ├── readable-traces.jsonl    # (Nếu bật readable: true) Dữ liệu OTLP Traces
    ├── readable-logs.jsonl      # (Nếu bật readable: true) Dữ liệu OTLP Logs
    └── readable-metrics.jsonl   # (Nếu bật readable: true) Dữ liệu OTLP Metrics

```
