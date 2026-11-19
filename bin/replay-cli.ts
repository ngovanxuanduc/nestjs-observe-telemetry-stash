#!/usr/bin/env node
import { replayStash } from "../src/replay/otlp.sender.js";
import { otlpUrls } from "../src/otlp/http.js";
import { parseHeaders } from "../src/config.js";

const args = process.argv.slice(2);
// Lấy phần sau dấu "=" đầu tiên (URL có query string cũng chứa "=").
const flag = (name: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : undefined;
};
const flags = (name: string) =>
  args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

if (args.includes("--help") || args.includes("-h")) {
  console.log(`telemetry-stash-replay [options]

  --date=YYYY-MM-DD          Ngày cần replay (mặc định: hôm nay, UTC)
  --dir=PATH                 Thư mục stash local (mặc định: ./telemetry-storage)
  --s3=s3://bucket/prefix    Đọc từ S3 thay vì local (credential: chuỗi mặc định của AWS SDK)
  --s3-region=REGION         (mặc định: AWS_REGION)
  --s3-endpoint=URL          S3 tương thích (RustFS, MinIO...)
  --s3-path-style            Bật path-style URL (RustFS/MinIO cần)
  --endpoint=URL             Base OTLP/HTTP, vd http://localhost:4318 (đặt cả 3 target bên dưới)
  --target-traces=URL        (mặc định: http://localhost:4318/v1/traces)
  --target-logs=URL
  --target-metrics=URL
  --header=key=value         Header gửi kèm, lặp được (vd --header=authorization=<key>)
                             Cũng đọc OTEL_EXPORTER_OTLP_HEADERS="k1=v1,k2=v2"`);
  process.exit(0);
}

const base = flag("endpoint");
const fromBase = base ? otlpUrls(base) : undefined;
const headers = {
  ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  ...Object.assign({}, ...flags("header").map((h) => parseHeaders(h))),
};

replayStash({
  date: flag("date"),
  storageDir: flag("dir"),
  s3Url: flag("s3"),
  s3Region: flag("s3-region"),
  s3Endpoint: flag("s3-endpoint"),
  s3ForcePathStyle: args.includes("--s3-path-style") || undefined,
  targetTracesUrl: flag("target-traces") ?? fromBase?.traces,
  targetLogsUrl: flag("target-logs") ?? fromBase?.logs,
  targetMetricsUrl: flag("target-metrics") ?? fromBase?.metrics,
  headers,
}).catch((err) => {
  console.error("Replay failed:", err?.message || err);
  process.exit(1);
});
