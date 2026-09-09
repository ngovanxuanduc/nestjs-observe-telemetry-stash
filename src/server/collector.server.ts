import { createServer, Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { StashOptions } from "../types.js";
import {
  DEFAULT_PORT,
  DEFAULT_STORAGE_DIR,
  DEFAULT_MAX_BODY_SIZE,
  DEFAULT_MAX_QUEUE_SIZE,
} from "../constants.js";
import { AsyncTelemetryWriter } from "../storage/async.writer.js";
import { writeReadablePayload } from "../storage/readable.writer.js";
import { transformToOtlp } from "../transformer/index.js";

let serverInstance: Server | null = null;
let writerInstance: AsyncTelemetryWriter | null = null;

const DEFAULT_MAX_SEGMENT_SIZE = 10 * 1024 * 1024; // 10MB

export const activeOptions: StashOptions = {
  port: DEFAULT_PORT,
  storageDir: DEFAULT_STORAGE_DIR,
  raw: true,
  readable: false,
  maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
  maxBodySize: DEFAULT_MAX_BODY_SIZE,
  maxSegmentSizeBytes: DEFAULT_MAX_SEGMENT_SIZE,
};

export function updateStashOptions(options: StashOptions) {
  Object.assign(activeOptions, options);

  const storageDir = activeOptions.storageDir || DEFAULT_STORAGE_DIR;
  const maxQueueSize = activeOptions.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
  const maxSegmentSizeBytes =
    activeOptions.maxSegmentSizeBytes || DEFAULT_MAX_SEGMENT_SIZE;

  if (writerInstance) {
    writerInstance = new AsyncTelemetryWriter(
      storageDir,
      maxQueueSize,
      maxSegmentSizeBytes,
    );
  }
}

export function startCollectorServer(options?: StashOptions): Server {
  if (options) {
    updateStashOptions(options);
  }

  if (serverInstance) return serverInstance;

  const storageDir = activeOptions.storageDir || DEFAULT_STORAGE_DIR;
  const maxQueueSize = activeOptions.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
  const maxSegmentSizeBytes =
    activeOptions.maxSegmentSizeBytes || DEFAULT_MAX_SEGMENT_SIZE;

  writerInstance = new AsyncTelemetryWriter(
    storageDir,
    maxQueueSize,
    maxSegmentSizeBytes,
  );

  serverInstance = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }

    let receivedBytes = 0;
    const maxBytes = activeOptions.maxBodySize || DEFAULT_MAX_BODY_SIZE;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;

      // Body Size Guard: Tránh Payload quá lớn làm ngập RAM
      if (receivedBytes > maxBytes) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload Too Large" }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (res.writableEnded) return;

      try {
        let buffer = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip" || buffer[0] === 0x1f) {
          buffer = gunzipSync(buffer);
        }

        // 1. Enqueue Async Segmented Writer (Non-blocking)
        if (activeOptions.raw !== false && writerInstance) {
          writerInstance.enqueue(buffer);
        }

        // 2. Readable debug mode (Async non-blocking parse qua setImmediate)
        if (activeOptions.readable === true) {
          setImmediate(() => {
            try {
              const payloadJson = JSON.parse(buffer.toString("utf-8"));
              const { traces, logs, metrics } = transformToOtlp(payloadJson);
              const currentDir =
                activeOptions.storageDir || DEFAULT_STORAGE_DIR;

              if (traces) writeReadablePayload(currentDir, "traces", traces);
              if (logs) writeReadablePayload(currentDir, "logs", logs);
              if (metrics) writeReadablePayload(currentDir, "metrics", metrics);
            } catch (err) {
              console.error("❌ [Telemetry Stash Readable Parse Error]:", err);
            }
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "stashed" }));
      } catch (err: any) {
        console.error("❌ [Telemetry Stash Server Error]:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  // Graceful Shutdown Handlers
  const handleShutdown = async (signal: string) => {
    console.log(
      `\n🛑 [Telemetry Stash] Received ${signal}. Shutting down server...`,
    );
    if (serverInstance) {
      serverInstance.close();
    }
    if (writerInstance) {
      await writerInstance.flush();
    }
    process.exit(0);
  };

  process.once("SIGINT", () => handleShutdown("SIGINT"));
  process.once("SIGTERM", () => handleShutdown("SIGTERM"));

  const targetPort = activeOptions.port || DEFAULT_PORT;
  serverInstance.listen(targetPort, () => {
    console.log(
      `📦 [Telemetry Stash] Server listening on http://localhost:${targetPort}`,
    );
    console.log(
      `📁 [Telemetry Stash] Storage directory: ${activeOptions.storageDir || DEFAULT_STORAGE_DIR}`,
    );
  });

  return serverInstance;
}
