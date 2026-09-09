import { startCollectorServer } from "./server/collector.server.js";

const readable = !!process.env.TELEMETRY_READABLE;

// Server tự đọc TELEMETRY_PORT và TELEMETRY_STORAGE_DIR từ ENV
startCollectorServer({ readable });
