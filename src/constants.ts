import * as path from "node:path";

export const DEFAULT_PORT = Number(process.env.TELEMETRY_PORT) || 3301;
export const DEFAULT_STORAGE_DIR =
  process.env.TELEMETRY_STORAGE_DIR ||
  path.join(process.cwd(), "telemetry-storage");
