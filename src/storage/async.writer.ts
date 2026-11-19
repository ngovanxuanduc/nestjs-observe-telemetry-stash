import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { defaultInstanceId } from "../constants.js";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Ghi payload thô vào `<storageDir>/<YYYY-MM-DD>/segment-<ts>-<instance>.jsonl.gz`.
 * Mỗi payload là một gzip member nối đuôi (gunzip đọc liền mạch cả file).
 * Segment được đóng khi: vượt dung lượng, sang ngày mới, hoặc bị gọi đóng (theo tuổi / khi tắt).
 */
export class AsyncTelemetryWriter {
  private queue: Buffer[] = [];
  private isProcessing = false;
  private currentSegmentPath: string | null = null;
  private currentSegmentDay: string | null = null;
  private currentSegmentSize = 0;
  private currentSegmentOpenedAt = 0;
  /** Có yêu cầu đóng segment trong lúc đang ghi → lượt ghi kế tiếp tự sang file mới. */
  private closeRequested = false;
  private closeWaiters: Array<() => void> = [];
  readonly instanceId: string;

  constructor(
    private storageDir: string,
    private maxQueueSize: number = 1000,
    private maxSegmentSizeBytes: number = 10 * 1024 * 1024, // 10MB
    instanceId?: string,
  ) {
    this.instanceId = instanceId || defaultInstanceId();
  }

  /** Segment đang được ghi (uploader không được đụng vào). */
  get currentPath(): string | null {
    return this.currentSegmentPath;
  }

  get pending(): number {
    return this.queue.length;
  }

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
    // Hết việc mà vẫn còn yêu cầu đóng → đóng luôn (không còn append nào đang chạy).
    if (this.closeRequested) this.finishClose();
  }

  private finishClose() {
    this.currentSegmentPath = null;
    this.currentSegmentDay = null;
    this.currentSegmentSize = 0;
    this.closeRequested = false;
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Mở segment mới khi: chưa có, có yêu cầu đóng, vượt dung lượng, sang ngày mới, hoặc file
   * đang ghi đã bị xoá từ bên ngoài. Hàm này chạy ở đầu mỗi lượt ghi — lượt trước đã append
   * xong (processQueue chờ tuần tự) nên file cũ lúc này an toàn để upload.
   */
  private getOrRotateSegmentPath(chunkBytesLength: number): string {
    if (this.closeRequested) this.finishClose();
    if (
      this.currentSegmentPath &&
      this.currentSegmentSize > 0 &&
      !fs.existsSync(this.currentSegmentPath)
    ) {
      // Bị tiến trình khác xoá (vd đã upload): ghi tiếp cùng tên sẽ đè key S3 → sang tên mới.
      console.warn(`⚠️ [Telemetry Stash] Segment ${path.basename(this.currentSegmentPath)} bị xoá từ bên ngoài, mở file mới.`);
      this.currentSegmentPath = null;
    }
    const day = today();
    if (
      !this.currentSegmentPath ||
      this.currentSegmentDay !== day ||
      this.currentSegmentSize + chunkBytesLength > this.maxSegmentSizeBytes
    ) {
      const dirPath = path.join(this.storageDir, day);
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      const now = Date.now();
      this.currentSegmentPath = path.join(dirPath, `segment-${now}-${this.instanceId}.jsonl.gz`);
      this.currentSegmentDay = day;
      this.currentSegmentSize = 0;
      this.currentSegmentOpenedAt = now;
    }
    return this.currentSegmentPath;
  }

  private writeRawPayloadAsync(buffer: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const line = buffer.toString("utf-8").trim() + "\n";

      zlib.gzip(Buffer.from(line, "utf-8"), (err, compressedBuffer) => {
        if (err) {
          console.error("❌ [Telemetry Stash] Compression error:", err);
          return resolve();
        }

        const filePath = this.getOrRotateSegmentPath(compressedBuffer.length);
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

  /**
   * Đóng segment hiện tại (payload sau sẽ sang file mới). Khi trả về, file cũ không còn bị append
   * — an toàn để upload. Không chờ hàng đợi rỗng: dưới tải liên tục, việc đóng xảy ra ngay ở
   * đầu lượt ghi kế tiếp (lúc lượt trước đã append xong), nên không bị treo.
   */
  public closeCurrent(): Promise<void> {
    if (!this.isProcessing) {
      if (this.currentSegmentPath) this.finishClose();
      return Promise.resolve();
    }
    this.closeRequested = true;
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  /** Đóng segment nếu đã mở lâu hơn `maxAgeMs` (hoặc đã sang ngày khác). */
  public async closeIfOlderThan(maxAgeMs: number): Promise<void> {
    if (!this.currentSegmentPath) return;
    const tooOld = maxAgeMs > 0 && Date.now() - this.currentSegmentOpenedAt >= maxAgeMs;
    if (tooOld || this.currentSegmentDay !== today()) await this.closeCurrent();
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
