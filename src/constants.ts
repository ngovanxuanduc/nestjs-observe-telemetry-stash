import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_PORT = Number(process.env.TELEMETRY_PORT) || 3301;
export const DEFAULT_HOST = process.env.TELEMETRY_HOST || "0.0.0.0";
export const DEFAULT_STORAGE_DIR =
  process.env.TELEMETRY_STORAGE_DIR ||
  path.join(process.cwd(), "telemetry-storage");
export const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
export const DEFAULT_MAX_QUEUE_SIZE = 1000;
export const DEFAULT_MAX_SEGMENT_SIZE = 10 * 1024 * 1024; // 10MB
/** Khi bật S3: đóng segment sau 5 phút để dữ liệu lên S3 đều đặn. */
export const DEFAULT_S3_SEGMENT_MAX_AGE_MS = 5 * 60 * 1000;
export const DEFAULT_S3_PREFIX = "telemetry";
export const DEFAULT_S3_UPLOAD_INTERVAL_MS = 30 * 1000;
export const DEFAULT_S3_ORPHAN_AFTER_MS = 60 * 60 * 1000;
export const DEFAULT_FORWARD_ENDPOINT = "http://localhost:4318";
export const DEFAULT_FORWARD_TIMEOUT_MS = 5000;
export const DEFAULT_FORWARD_MAX_IN_FLIGHT = 20;

/** Ký tự an toàn cho tên file / key S3. */
export const defaultInstanceId = () =>
  `${os.hostname()}-${process.pid}`.replace(/[^a-zA-Z0-9._-]/g, "_");
