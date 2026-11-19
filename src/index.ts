import { startCollectorServer } from "./server/collector.server.js";
import { StashOptions } from "./types.js";

let isConfigured = false;

/** Cấu hình bằng code (ưu tiên hơn biến môi trường), rồi khởi động receiver. */
export function configureStash(options: StashOptions) {
  isConfigured = true;
  return startCollectorServer(options);
}

process.nextTick(() => {
  if (!isConfigured) {
    startCollectorServer();
  }
});

export { flushStash } from "./server/collector.server.js";
export { parseHeaders, parseS3Url } from "./config.js";
export * from "./types.js";
export * from "./replay/index.js";
