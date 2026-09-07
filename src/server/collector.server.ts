import { createServer, Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { StashOptions } from "../types.js";
import { DEFAULT_PORT, DEFAULT_STORAGE_DIR } from "../constants.js";
import { writeRawPayload, writeReadablePayload } from "../storage/index.js";
import { transformToOtlp } from "../transformer/index.js";

let serverInstance: Server | null = null;

export const activeOptions: StashOptions = {
  port: DEFAULT_PORT,
  storageDir: DEFAULT_STORAGE_DIR,
  raw: true,
  readable: true,
};

export function updateStashOptions(options: StashOptions) {
  Object.assign(activeOptions, options);
}

export function startCollectorServer(options?: StashOptions): Server {
  if (options) {
    updateStashOptions(options);
  }

  if (serverInstance) return serverInstance;

  serverInstance = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        let buffer = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip" || buffer[0] === 0x1f) {
          buffer = gunzipSync(buffer);
        }

        const isRaw = activeOptions.raw !== false;
        const isReadable = activeOptions.readable === true;

        // 💡 Luôn lấy storageDir thời gian thực từ activeOptions
        const currentStorageDir =
          activeOptions.storageDir || DEFAULT_STORAGE_DIR;

        if (isRaw) {
          writeRawPayload(currentStorageDir, buffer);
        }

        if (isReadable) {
          const payloadJson = JSON.parse(buffer.toString("utf-8"));
          const { traces, logs, metrics } = transformToOtlp(payloadJson);

          if (traces) writeReadablePayload(currentStorageDir, "traces", traces);
          if (logs) writeReadablePayload(currentStorageDir, "logs", logs);
          if (metrics)
            writeReadablePayload(currentStorageDir, "metrics", metrics);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "stashed" }));
      } catch (err: any) {
        console.error("❌ [Telemetry Stash Error]:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  const targetPort = activeOptions.port || DEFAULT_PORT;
  serverInstance.listen(targetPort, () => {
    console.log(
      `📦 [Telemetry Stash] Listening on http://localhost:${targetPort}`,
    );
    console.log(
      `📁 [Telemetry Stash] Storage directory: ${activeOptions.storageDir || DEFAULT_STORAGE_DIR}`,
    );
  });

  return serverInstance;
}
