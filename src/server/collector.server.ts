import { createServer, Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { ForwardOptions, S3Options, StashOptions } from "../types.js";
import {
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_SIZE,
  DEFAULT_MAX_QUEUE_SIZE,
  DEFAULT_MAX_SEGMENT_SIZE,
  DEFAULT_PORT,
  DEFAULT_S3_SEGMENT_MAX_AGE_MS,
  DEFAULT_STORAGE_DIR,
  defaultInstanceId,
} from "../constants.js";
import { optionsFromEnv } from "../config.js";
import { AsyncTelemetryWriter } from "../storage/async.writer.js";
import { writeReadablePayload } from "../storage/readable.writer.js";
import { S3SegmentUploader } from "../storage/s3.uploader.js";
import { OtlpForwarder } from "../forward/otlp.forwarder.js";
import { transformToOtlp } from "../transformer/index.js";
import { resolveSource } from "./source.resolver.js";

/** Thời gian tối đa chờ request đang nhận dở xong khi tắt. */
const SERVER_CLOSE_TIMEOUT_MS = 10_000;

let serverInstance: Server | null = null;
let listeningOn: { port: number; host: string } | null = null;
let writerInstance: AsyncTelemetryWriter | null = null;
let uploaderInstance: S3SegmentUploader | null = null;
let forwarderInstance: OtlpForwarder | null = null;
let shuttingDown = false;
let receivedCount = 0;
const startedAt = Date.now();

export const activeOptions: StashOptions = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  storageDir: DEFAULT_STORAGE_DIR,
  raw: true,
  readable: false,
  maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
  maxBodySize: DEFAULT_MAX_BODY_SIZE,
  maxSegmentSizeBytes: DEFAULT_MAX_SEGMENT_SIZE,
};

/**
 * Chèn `"_receivedAt": <ms>` vào đầu object JSON mà không parse (chỉ nối chuỗi),
 * để replay có mốc thời gian cho runtime metrics (payload Observe không mang timestamp cho phần này).
 */
export function withReceivedAt(buffer: Buffer, receivedAt: number): Buffer {
  return withMeta(buffer, { _receivedAt: receivedAt });
}

/** Chèn các field meta (`_receivedAt`, `_source`...) vào đầu object JSON — chỉ nối chuỗi, không parse payload. */
export function withMeta(buffer: Buffer, meta: Record<string, unknown>): Buffer {
  const text = buffer.toString("utf-8").trim();
  if (!text.startsWith("{")) return buffer;
  const rest = text.slice(1).trimStart();
  const fields = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(",");
  if (!fields) return buffer;
  return Buffer.from(
    rest.startsWith("}") ? `{${fields}${rest}` : `{${fields},${rest}`,
    "utf-8",
  );
}

/** Ghép option (S3 / forward ghép sâu) vào cấu hình đang dùng. */
export function updateStashOptions(options: StashOptions) {
  const { s3, forward, ...rest } = options;
  Object.assign(activeOptions, rest);
  if (s3) activeOptions.s3 = { ...(activeOptions.s3 || {}), ...s3 } as S3Options;
  if (forward) activeOptions.forward = { ...(activeOptions.forward || {}), ...forward } as ForwardOptions;
}

/** Dựng writer / uploader / forwarder theo `activeOptions`. Request mới dùng ngay bộ mới. */
function buildComponents() {
  activeOptions.instanceId ||= defaultInstanceId();
  const storageDir = activeOptions.storageDir || DEFAULT_STORAGE_DIR;

  writerInstance = new AsyncTelemetryWriter(
    storageDir,
    activeOptions.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE,
    activeOptions.maxSegmentSizeBytes || DEFAULT_MAX_SEGMENT_SIZE,
    activeOptions.instanceId,
  );
  uploaderInstance =
    activeOptions.s3?.bucket && activeOptions.raw !== false
      ? new S3SegmentUploader(
          activeOptions.s3,
          storageDir,
          writerInstance,
          // `??`: 0 nghĩa là "không đóng theo tuổi", không bị thay bằng mặc định.
          activeOptions.segmentMaxAgeMs ?? DEFAULT_S3_SEGMENT_MAX_AGE_MS,
        )
      : null;
  forwarderInstance = activeOptions.forward?.enabled ? new OtlpForwarder(activeOptions.forward) : null;
}

function logConfiguration() {
  const host = activeOptions.host || DEFAULT_HOST;
  const port = activeOptions.port || DEFAULT_PORT;
  console.log(`📦 [Telemetry Stash] Server listening on http://${host}:${port}`);
  console.log(
    `📁 [Telemetry Stash] Storage directory: ${activeOptions.storageDir || DEFAULT_STORAGE_DIR} (instance ${activeOptions.instanceId})`,
  );
  if (forwarderInstance) console.log(`📡 [Telemetry Stash] Forward OTLP → ${forwarderInstance.endpoint}`);
}

function healthBody() {
  return {
    status: "ok",
    instance: activeOptions.instanceId,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    received: receivedCount,
    queue: writerInstance?.pending ?? 0,
    // Số liệu đếm sẵn — không quét đĩa trên đường health check.
    s3: uploaderInstance ? { ...uploaderInstance.stats } : { enabled: false },
    forward: forwarderInstance
      ? { endpoint: forwarderInstance.endpoint, ...forwarderInstance.stats }
      : { enabled: false },
  };
}

export interface StartOptions extends StashOptions {
  /**
   * Khi nhận SIGINT/SIGTERM: chờ request đang nhận xong, đóng server, đẩy hết dữ liệu rồi
   * `process.exit`. Bật cho standalone/container. Tắt (mặc định) khi chạy trong app: chỉ đẩy
   * dữ liệu, server vẫn nhận (vd lần flush cuối của Observe) và app tự tắt theo cách của nó.
   */
  exitOnSignal?: boolean;
}

function closeServer(timeoutMs: number): Promise<void> {
  const server = serverInstance;
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    // close() chờ request đang chạy xong; kết nối keep-alive đang rảnh thì đóng luôn.
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

function listen(): Promise<void> {
  const port = activeOptions.port || DEFAULT_PORT;
  const host = activeOptions.host || DEFAULT_HOST;
  return new Promise((resolve) => {
    serverInstance!.listen(port, host, () => {
      listeningOn = { port, host };
      resolve();
    });
  });
}

/**
 * Áp cấu hình mới khi server đã chạy (vd `configureStash()` gọi sau khi auto-start):
 * dựng bộ ghi / upload / forward mới, đẩy hết dữ liệu của bộ cũ, lắng nghe lại nếu đổi cổng.
 */
async function reconfigure() {
  const oldWriter = writerInstance;
  const oldUploader = uploaderInstance;
  const oldForwarder = forwarderInstance;
  buildComponents();

  if (oldUploader) {
    oldUploader.stop();
    await oldUploader.flushAll();
  } else if (oldWriter) {
    await oldWriter.flush();
    await oldWriter.closeCurrent();
  }
  await oldForwarder?.drain();

  const port = activeOptions.port || DEFAULT_PORT;
  const host = activeOptions.host || DEFAULT_HOST;
  if (listeningOn && (listeningOn.port !== port || listeningOn.host !== host)) {
    await closeServer(SERVER_CLOSE_TIMEOUT_MS);
    await listen();
  }
  console.log("♻️  [Telemetry Stash] Đã áp cấu hình mới.");
  logConfiguration();
  uploaderInstance?.start();
}

export function startCollectorServer(options?: StartOptions): Server {
  const { exitOnSignal = false, ...stashOptions } = options || {};
  const hasCodeOptions = Object.keys(stashOptions).length > 0;

  if (serverInstance) {
    // Đã chạy: áp option mới (nếu có) thay vì bỏ qua.
    if (hasCodeOptions) {
      updateStashOptions(stashOptions);
      reconfigure().catch((err) => console.error("❌ [Telemetry Stash] Reconfigure failed:", err));
    }
    return serverInstance;
  }

  // Thứ tự ưu tiên: mặc định < biến môi trường < option truyền bằng code
  updateStashOptions(optionsFromEnv());
  if (hasCodeOptions) updateStashOptions(stashOptions);
  buildComponents();

  serverInstance = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(healthBody()));
    }
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

    req.on("end", async () => {
      if (res.writableEnded) return;

      try {
        const receivedAt = Date.now();
        let buffer: Buffer = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip" || buffer[0] === 0x1f) {
          buffer = gunzipSync(buffer);
        }
        // Instance + role của bên gửi (payload Observe không mang thông tin này).
        const source = await resolveSource(req, activeOptions.instanceId || defaultInstanceId());
        buffer = withMeta(buffer, { _receivedAt: receivedAt, _source: source });
        receivedCount++;

        // 1. Lưu thô (luôn là nguồn sự thật — forward lỗi vẫn replay được)
        if (activeOptions.raw !== false && writerInstance) {
          writerInstance.enqueue(buffer);
        }

        // 2. Forward OTLP live (best-effort, chạy nền)
        if (forwarderInstance) {
          forwarderInstance.submit(buffer.toString("utf-8"));
        }

        // 3. Readable debug mode (Async non-blocking parse qua setImmediate)
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

  installShutdownHandlers(exitOnSignal);

  void listen().then(() => {
    logConfiguration();
    uploaderInstance?.start();
  });

  return serverInstance;
}

/**
 * Đẩy hết dữ liệu đang giữ: hàng đợi ghi → forward đang chạy → upload S3 segment hiện tại.
 * Uploader chạy lại sau đó (trừ khi đang tắt hẳn), nên payload đến sau vẫn được upload.
 */
export async function flushStash(): Promise<void> {
  if (writerInstance) await writerInstance.flush();
  if (forwarderInstance) await forwarderInstance.drain();
  if (uploaderInstance) {
    const uploader = uploaderInstance;
    uploader.stop();
    try {
      await uploader.flushAll();
    } finally {
      if (!shuttingDown && uploader === uploaderInstance) uploader.start();
    }
  }
}

function installShutdownHandlers(exitOnSignal: boolean) {
  const handle = async (signal: NodeJS.Signals) => {
    console.log(`\n🛑 [Telemetry Stash] Received ${signal}. Flushing...`);
    if (exitOnSignal) {
      shuttingDown = true;
      // Chờ request đang nhận dở được ghi vào hàng đợi rồi mới flush.
      await closeServer(SERVER_CLOSE_TIMEOUT_MS);
    }
    try {
      await flushStash();
    } catch (err) {
      console.error("❌ [Telemetry Stash] Flush on shutdown failed:", err);
    }
    // Chạy trong app: chỉ thoát nếu không còn ai khác xử lý tín hiệu này (giữ hành vi mặc định
    // của Node), còn không để app tự tắt — receiver và uploader vẫn chạy cho tới lúc đó.
    if (exitOnSignal || process.listenerCount(signal) === 0) {
      shuttingDown = true;
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void handle("SIGINT"));
  process.once("SIGTERM", () => void handle("SIGTERM"));
}
