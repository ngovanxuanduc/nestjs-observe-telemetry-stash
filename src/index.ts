import {
  startCollectorServer,
  updateStashOptions,
} from "./server/collector.server.js";
import { StashOptions } from "./types.js";

let isConfigured = false;

export function configureStash(options: StashOptions) {
  isConfigured = true;
  updateStashOptions(options);
  return startCollectorServer();
}

// 💡 Hoãn auto-start sang tick tiếp theo để chờ configureStash() chạy xong
process.nextTick(() => {
  if (!isConfigured) {
    startCollectorServer();
  }
});

export * from "./types.js";
export * from "./replay/index.js";
