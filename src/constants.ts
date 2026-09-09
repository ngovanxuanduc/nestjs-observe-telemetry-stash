import * as path from "node:path";

export const DEFAULT_PORT = Number(process.env.TELEMETRY_PORT) || 3301;
export const DEFAULT_STORAGE_DIR =
  process.env.TELEMETRY_STORAGE_DIR ||
  path.join(process.cwd(), "telemetry-storage");
export const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
export const DEFAULT_MAX_QUEUE_SIZE = 1000;
