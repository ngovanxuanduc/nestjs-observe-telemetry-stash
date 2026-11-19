# nestjs-observe-telemetry-stash

Receiver + kho đệm offline cho telemetry của [`@nestjs/observe`](https://observe.nestjs.com) (đã kiểm chứng với 0.1.x và 0.3.26).

Nhận batch của `ObserveAgentWorker` (thay cho collector hosted), lưu nén `.jsonl.gz`, và chuyển sang OpenTelemetry (OTLP) để đẩy lên ClickStack / SigNoz / OTel Collector:

- **Lưu thô** — luôn bật, là nguồn sự thật. Local disk, tuỳ chọn **upload S3**.
- **Replay** — CLI đọc lại từ local hoặc S3 → OTLP.
- **Forward** — (tắt mặc định) đẩy OTLP ngay khi nhận, best-effort; lỗi thì vẫn còn file thô để replay.

```
@nestjs/observe ──POST──► telemetry-stash ──► segment .jsonl.gz ──► (S3)
                              │                      │
                              │ forward (tuỳ chọn)   └── replay CLI ──┐
                              ▼                                       ▼
                         OTLP/HTTP collector (ClickStack :4318, SigNoz, OTel Collector)
```

---

## 🚀 Dùng trong app (in-process)

Import ở **dòng đầu tiên** của `main.ts`, trỏ `endpoint` của Observe vào cổng stash:

```typescript
import "@ducnvx/nestjs-observe-telemetry-stash"; // 👈 dòng 1

// ObserveModule.forRoot({ endpoint: "http://localhost:3301", appKey: "...", appSecret: "...", ... })
```

> Observe 0.3.x không gửi gì nếu `appKey`/`appSecret` rỗng hoặc là placeholder `YOUR_APP_KEY`. Stash không kiểm tra key — chuỗi bất kỳ là được.

Cấu hình bằng code (ưu tiên hơn biến môi trường):

```typescript
import { configureStash } from "@ducnvx/nestjs-observe-telemetry-stash";

configureStash({
  port: 3301,
  storageDir: "./telemetry-storage",
  readable: true, // ghi thêm OTLP JSON dễ đọc để debug
  s3: { bucket: "my-telemetry", prefix: "api" },
  forward: { enabled: true, endpoint: "http://localhost:4318" },
});
```

Dùng S3 khi chạy in-process thì app phải cài thêm `@aws-sdk/client-s3` (optional peer). Image Docker có sẵn.

## 🐳 Chạy container (standalone)

```bash
docker compose up -d --build        # xem docker-compose.yml
curl localhost:3301/health
```

Image build cho amd64 từ máy ARM: `docker buildx build --platform linux/amd64 -t telemetry-stash:<version> --load .`

---

## ⚙️ Biến môi trường

| Biến | Mặc định | Mô tả |
|---|---|---|
| `TELEMETRY_PORT` | `3301` | Cổng nhận |
| `TELEMETRY_HOST` | `0.0.0.0` | Địa chỉ lắng nghe. Sidecar ECS: `127.0.0.1` |
| `TELEMETRY_STORAGE_DIR` | `./telemetry-storage` (image: `/data/telemetry`) | Thư mục segment |
| `TELEMETRY_INSTANCE_ID` | `<hostname>-<pid>` | Ghép vào tên file; nhiều instance ghi chung bucket không đè nhau |
| `TELEMETRY_MAX_SEGMENT_BYTES` | `10485760` | Đóng segment khi vượt dung lượng (nén) |
| `TELEMETRY_SEGMENT_MAX_AGE_MS` | `0` (có S3: `300000`) | Đóng segment sau thời gian này → lên S3 đều đặn |
| `TELEMETRY_READABLE` | `false` | Ghi thêm `readable-*.jsonl` (OTLP JSON) để debug |
| **S3** — bật khi có bucket | | |
| `TELEMETRY_S3_BUCKET` | — | Bucket. Có = bật upload |
| `TELEMETRY_S3_PREFIX` | `telemetry` | Key: `<prefix>/<YYYY-MM-DD>/segment-<ts>-<instance>.jsonl.gz` |
| `TELEMETRY_S3_REGION` | `AWS_REGION` | |
| `TELEMETRY_S3_ENDPOINT` | — | S3 tương thích (RustFS, MinIO). Bỏ trống trên AWS |
| `TELEMETRY_S3_FORCE_PATH_STYLE` | — | `true` cho RustFS/MinIO |
| `TELEMETRY_S3_KEEP_LOCAL` | `false` | Giữ file local sau upload (đánh dấu `.uploaded`) |
| `TELEMETRY_S3_UPLOAD_INTERVAL_MS` | `30000` | Chu kỳ quét + upload |
| `TELEMETRY_S3_ORPHAN_AFTER_MS` | `3600000` | Segment của instance khác chỉ được upload khi bỏ không lâu hơn ngưỡng này |
| **Forward** — tắt mặc định | | |
| `TELEMETRY_FORWARD_ENABLED` | `false` | Đẩy OTLP ngay khi nhận |
| `TELEMETRY_FORWARD_ENDPOINT` | `http://localhost:4318` | Base OTLP/HTTP (`/v1/traces`, `/v1/logs`, `/v1/metrics` tự thêm) |
| `TELEMETRY_FORWARD_HEADERS` | — | `k1=v1,k2=v2` (vd `authorization=<ingestion key>` cho ClickStack có auth) |
| `TELEMETRY_FORWARD_TIMEOUT_MS` | `5000` | |
| `TELEMETRY_FORWARD_MAX_IN_FLIGHT` | `20` | Vượt thì bỏ (vẫn có file thô) |

Credential S3 theo chuỗi mặc định của AWS SDK: ECS task role, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `~/.aws`.

### Instance & role

Payload của Observe không cho biết process nào gửi, nên stash tự gắn (`_source` trong file thô → resource `service.instance.id`, `observe.roles`, `observe.source.ip`):

- **instance**: `/i/<tên>` trên endpoint (nếu app tự đặt) → **tên container** (DNS nội bộ Docker tra ngược từ IP, ổn định qua restart) → IP → gửi qua loopback (sidecar / in-process) thì là `TELEMETRY_INSTANCE_ID` của stash.
- **roles**: app gắn `/r/<role1,role2>` vào endpoint của Observe — Observe gửi tới `<endpoint>/applications/telemetry` nên đường dẫn đi kèm mọi batch:
  ```ts
  ObserveModule.forRoot({ endpoint: `http://telemetry-stash:3301/r/${encodeURIComponent(roles.join(","))}`, ... })
  ```
  Chưa gắn thì dùng tạm tag `role` của job (chỉ có sau khi instance chạy ít nhất một job).

Dashboard ClickStack dùng các field này cho nhóm **Instances** (đang chạy theo service, danh sách instance + role + heap/CPU/lag, số instance theo thời gian) và tách runtime theo instance.

### `GET /health`
Trả 200 + số liệu: `received`, `queue`, `s3.{uploaded,failed,pending,lastError}`, `forward.{forwarded,failed,dropped,lastError}`. Image có sẵn `HEALTHCHECK`.

---

## ☁️ S3

- Segment **đã đóng** (theo dung lượng, theo tuổi, sang ngày mới, hoặc khi tắt) được upload rồi **xoá local**. Segment đang ghi không bị đụng tới.
- Upload lỗi → giữ file, lượt sau thử lại.
- Nhiều instance chung một thư mục: mỗi instance chỉ upload segment **của chính nó**; segment của instance khác (đã chết) được nhận sau `TELEMETRY_S3_ORPHAN_AFTER_MS`. Muốn file sót của lần chạy trước được đẩy lên **ngay** khi khởi động lại (disk bền, docker compose), đặt `TELEMETRY_INSTANCE_ID` cố định — mặc định id có kèm pid nên đổi mỗi lần chạy.
- SIGTERM → ghi nốt hàng đợi, đóng segment, upload hết rồi mới thoát.
- **Dọn dữ liệu cũ**: stash không tự xoá trên S3 — đặt **lifecycle rule** cho prefix (vd chuyển Glacier sau 30 ngày, xoá sau 180 ngày).

IAM tối thiểu:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject"], "Resource": "arn:aws:s3:::my-telemetry/telemetry/*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::my-telemetry",
      "Condition": { "StringLike": { "s3:prefix": "telemetry/*" } } },
    { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::my-telemetry/telemetry/*" }
  ]
}
```
(`ListBucket` + `GetObject` chỉ cần cho replay; task role của stash chỉ cần `PutObject`.)

## ☁️ ECS — chạy sidecar

Mỗi task: app + stash, nói chuyện qua `localhost` (awsvpc chung network namespace — HTTP thường là đủ, không ra card mạng).

```jsonc
"containerDefinitions": [
  {
    "name": "telemetry-stash",
    "image": "<registry>/telemetry-stash:<version>",
    "essential": false,                       // stash chết không kéo app chết theo
    "memoryReservation": 128,
    "environment": [
      { "name": "TELEMETRY_HOST", "value": "127.0.0.1" },
      { "name": "TELEMETRY_S3_BUCKET", "value": "my-telemetry" },
      { "name": "TELEMETRY_S3_PREFIX", "value": "telemetry/sitter-service-api" }
    ],
    "healthCheck": { "command": ["CMD-SHELL", "wget -qO- http://127.0.0.1:3301/health || exit 1"] },
    "stopTimeout": 30
  },
  {
    "name": "api",
    "environment": [{ "name": "LOG_OBSERVE_ENDPOINT", "value": "http://localhost:3301" }],
    "dependsOn": [{ "containerName": "telemetry-stash", "condition": "HEALTHY" }]
  }
]
```

- `dependsOn` còn quyết định **thứ tự tắt**: ECS dừng `api` trước, stash sau → stash nhận đủ batch cuối của Observe rồi mới upload + thoát.
- Ổ đĩa task (Fargate) mất khi task bị thay → dữ liệu bền nằm ở S3; segment ngắn (5 phút mặc định) giới hạn phần có thể mất khi task bị kill cứng.
- Prefix theo service giúp replay riêng từng service.

---

## 🔄 Replay

```bash
npx telemetry-stash-replay --help

# local, hôm nay → ClickStack/collector ở localhost:4318
npx telemetry-stash-replay

# ngày cụ thể, thư mục khác, collector khác
npx telemetry-stash-replay --date=2026-11-19 --dir=./my-stash --endpoint=http://10.0.0.5:4318

# từ S3 (credential: chuỗi mặc định của AWS SDK)
npx telemetry-stash-replay --s3=s3://my-telemetry/telemetry/sitter-service-api --date=2026-11-19

# S3 tương thích (RustFS/MinIO) + collector cần key
npx telemetry-stash-replay --s3=s3://bucket/prefix --s3-endpoint=http://localhost:9000 --s3-path-style \
  --header=authorization=<ingestion-key>
```

Segment bị cụt (process bị kill giữa lúc ghi) vẫn replay được phần còn nguyên.

## 📁 Cấu trúc lưu trữ

```text
telemetry-storage/                         (S3: <prefix>/<YYYY-MM-DD>/...)
└── 2026-11-19/
    ├── segment-1795056641595-api-1.jsonl.gz   # payload thô (mỗi dòng 1 batch + _receivedAt), dùng để replay
    ├── readable-traces.jsonl                  # (readable) OTLP traces
    ├── readable-logs.jsonl                    # (readable) OTLP logs
    └── readable-metrics.jsonl                 # (readable) OTLP metrics
```

## 📊 Dashboard ClickStack

`node clickstack/dashboard.mjs` tạo / cập nhật dashboard "NestJS Observe" (requests, endpoint, DB/HTTP calls, jobs, runtime, logs, custom metrics) — xem đầu file để đổi API/tên.

## 🧪 Demo

`demo/` (không commit) là app NestJS 12 + Postgres + BullMQ dùng `@nestjs/observe` thật để kiểm thử transformer: `npm run infra:up && npm start`, rồi `npm run simulate && npm run check`.
