import { ForwardOptions, S3Options, StashOptions } from "./types.js";

const bool = (v: string | undefined): boolean | undefined =>
  v === undefined || v === "" ? undefined : /^(1|true|yes|on)$/i.test(v);
const num = (v: string | undefined): number | undefined =>
  v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);

/**
 * Header theo định dạng OTEL_EXPORTER_OTLP_HEADERS: `k1=v1,k2=v2` (giá trị có thể URL-encode).
 */
export function parseHeaders(input?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!input) return headers;
  for (const part of input.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      /* giữ nguyên */
    }
    if (key) headers[key] = value;
  }
  return headers;
}

/** Tách `s3://bucket/prefix/...` → { bucket, prefix } */
export function parseS3Url(url: string): { bucket: string; prefix: string } {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url.trim());
  if (!m) throw new Error(`S3 URL không hợp lệ: ${url} (cần dạng s3://bucket/prefix)`);
  return { bucket: m[1], prefix: m[2].replace(/\/+$/, "") };
}

/**
 * Cấu hình từ biến môi trường (dùng cho image Docker / standalone). Chỉ trả về những gì được set,
 * để ghép đè lên mặc định hoặc lên option truyền bằng code.
 */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): StashOptions {
  const options: StashOptions = {};
  if (num(env.TELEMETRY_PORT) !== undefined) options.port = num(env.TELEMETRY_PORT);
  if (env.TELEMETRY_HOST) options.host = env.TELEMETRY_HOST;
  if (env.TELEMETRY_STORAGE_DIR) options.storageDir = env.TELEMETRY_STORAGE_DIR;
  if (bool(env.TELEMETRY_READABLE) !== undefined) options.readable = bool(env.TELEMETRY_READABLE);
  if (num(env.TELEMETRY_MAX_SEGMENT_BYTES) !== undefined)
    options.maxSegmentSizeBytes = num(env.TELEMETRY_MAX_SEGMENT_BYTES);
  if (num(env.TELEMETRY_SEGMENT_MAX_AGE_MS) !== undefined)
    options.segmentMaxAgeMs = num(env.TELEMETRY_SEGMENT_MAX_AGE_MS);
  if (env.TELEMETRY_INSTANCE_ID) options.instanceId = env.TELEMETRY_INSTANCE_ID;

  if (env.TELEMETRY_S3_BUCKET) {
    const s3: S3Options = { bucket: env.TELEMETRY_S3_BUCKET };
    if (env.TELEMETRY_S3_PREFIX !== undefined) s3.prefix = env.TELEMETRY_S3_PREFIX;
    if (env.TELEMETRY_S3_REGION) s3.region = env.TELEMETRY_S3_REGION;
    if (env.TELEMETRY_S3_ENDPOINT) s3.endpoint = env.TELEMETRY_S3_ENDPOINT;
    if (bool(env.TELEMETRY_S3_FORCE_PATH_STYLE) !== undefined)
      s3.forcePathStyle = bool(env.TELEMETRY_S3_FORCE_PATH_STYLE);
    if (bool(env.TELEMETRY_S3_KEEP_LOCAL) !== undefined) s3.keepLocal = bool(env.TELEMETRY_S3_KEEP_LOCAL);
    if (num(env.TELEMETRY_S3_UPLOAD_INTERVAL_MS) !== undefined)
      s3.uploadIntervalMs = num(env.TELEMETRY_S3_UPLOAD_INTERVAL_MS);
    if (num(env.TELEMETRY_S3_ORPHAN_AFTER_MS) !== undefined)
      s3.orphanAfterMs = num(env.TELEMETRY_S3_ORPHAN_AFTER_MS);
    options.s3 = s3;
  }

  if (bool(env.TELEMETRY_FORWARD_ENABLED) !== undefined) {
    const forward: ForwardOptions = { enabled: bool(env.TELEMETRY_FORWARD_ENABLED)! };
    if (env.TELEMETRY_FORWARD_ENDPOINT) forward.endpoint = env.TELEMETRY_FORWARD_ENDPOINT;
    const headers = parseHeaders(env.TELEMETRY_FORWARD_HEADERS);
    if (Object.keys(headers).length) forward.headers = headers;
    if (num(env.TELEMETRY_FORWARD_TIMEOUT_MS) !== undefined) forward.timeoutMs = num(env.TELEMETRY_FORWARD_TIMEOUT_MS);
    if (num(env.TELEMETRY_FORWARD_MAX_IN_FLIGHT) !== undefined)
      forward.maxInFlight = num(env.TELEMETRY_FORWARD_MAX_IN_FLIGHT);
    options.forward = forward;
  }
  return options;
}
