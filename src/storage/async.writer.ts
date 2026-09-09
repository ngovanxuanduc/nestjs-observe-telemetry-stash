import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

export class AsyncTelemetryWriter {
  private queue: Buffer[] = [];
  private isProcessing = false;
  private currentSegmentPath: string | null = null;
  private currentSegmentSize = 0;

  constructor(
    private storageDir: string,
    private maxQueueSize: number = 1000,
    private maxSegmentSizeBytes: number = 10 * 1024 * 1024, // 10MB
  ) {}

  public enqueue(buffer: Buffer) {
    if (this.queue.length >= this.maxQueueSize) {
      console.warn(
        `⚠️ [Telemetry Stash] Queue limit reached (${this.maxQueueSize}). Dropping oldest payload.`,
      );
      this.queue.shift();
    }
    this.queue.push(buffer);
    this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const buffer = this.queue.shift();
      if (buffer) {
        await this.writeRawPayloadAsync(buffer);
      }
    }

    this.isProcessing = false;
  }

  /** Xử lý Rotate File Segment khi vượt ngưỡng dung lượng */
  private getOrRotateSegmentPath(
    todayDir: string,
    chunkBytesLength: number,
  ): string {
    if (
      !this.currentSegmentPath ||
      this.currentSegmentSize + chunkBytesLength > this.maxSegmentSizeBytes
    ) {
      const timestamp = Date.now();
      this.currentSegmentPath = path.join(
        todayDir,
        `segment-${timestamp}.jsonl.gz`,
      );
      this.currentSegmentSize = 0;
    }
    return this.currentSegmentPath;
  }

  private writeRawPayloadAsync(buffer: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const today = new Date().toISOString().slice(0, 10);
      const dirPath = path.join(this.storageDir, today);

      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      const line = buffer.toString("utf-8").trim() + "\n";

      zlib.gzip(Buffer.from(line, "utf-8"), (err, compressedBuffer) => {
        if (err) {
          console.error("❌ [Telemetry Stash] Compression error:", err);
          return resolve();
        }

        const filePath = this.getOrRotateSegmentPath(
          dirPath,
          compressedBuffer.length,
        );
        this.currentSegmentSize += compressedBuffer.length;

        fs.appendFile(filePath, compressedBuffer, (appendErr) => {
          if (appendErr) {
            console.error("❌ [Telemetry Stash] Append error:", appendErr);
          }
          resolve();
        });
      });
    });
  }

  public async flush(): Promise<void> {
    if (this.queue.length === 0 && !this.isProcessing) return;
    console.log(
      `⏳ [Telemetry Stash] Flushing ${this.queue.length} pending payloads...`,
    );

    while (this.queue.length > 0 || this.isProcessing) {
      await this.processQueue();
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log("✅ [Telemetry Stash] Queue successfully flushed.");
  }
}
