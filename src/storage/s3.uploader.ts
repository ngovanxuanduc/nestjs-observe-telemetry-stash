import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_S3_ORPHAN_AFTER_MS,
  DEFAULT_S3_PREFIX,
  DEFAULT_S3_UPLOAD_INTERVAL_MS,
} from "../constants.js";
import { S3Options } from "../types.js";
import { AsyncTelemetryWriter } from "./async.writer.js";
import { loadS3 } from "./s3.client.js";

const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const UPLOADED_MARKER = ".uploaded";

interface SegmentFile {
  day: string;
  file: string;
  full: string;
}

/**
 * Định kỳ: đóng segment quá tuổi → upload segment ĐÃ ĐÓNG lên S3 → xoá file local.
 * Quét theo thư mục nên tự xử lý cả file sót lại và file upload lỗi (thử lại lượt sau).
 *
 * Nhiều instance có thể dùng chung thư mục: chỉ upload segment của CHÍNH instance này
 * (trừ file đang ghi). Segment của instance khác chỉ được nhận khi đã bỏ không quá
 * `orphanAfterMs` (instance kia đã chết) — không bao giờ đụng file người khác còn đang ghi.
 */
export class S3SegmentUploader {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private s3: Awaited<ReturnType<typeof loadS3>> | null = null;
  readonly stats = {
    uploaded: 0,
    failed: 0,
    bytes: 0,
    /** Segment đã đóng còn chờ upload, tính ở lượt quét gần nhất (không quét đĩa khi đọc). */
    pending: 0,
    lastError: "" as string,
    lastUploadAt: 0,
  };

  constructor(
    private readonly options: S3Options,
    private readonly storageDir: string,
    private readonly writer: AsyncTelemetryWriter,
    private readonly segmentMaxAgeMs: number,
  ) {}

  private get prefix() {
    return (this.options.prefix ?? DEFAULT_S3_PREFIX).replace(/^\/+|\/+$/g, "");
  }

  keyFor(day: string, file: string) {
    return [this.prefix, day, file].filter(Boolean).join("/");
  }

  start() {
    if (this.timer) return;
    const interval = this.options.uploadIntervalMs || DEFAULT_S3_UPLOAD_INTERVAL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref(); // không giữ process sống chỉ vì timer này
    console.log(
      `☁️  [Telemetry Stash] S3 upload → s3://${this.options.bucket}/${this.prefix} (mỗi ${interval / 1000}s, segment tối đa ${this.segmentMaxAgeMs > 0 ? `${Math.round(this.segmentMaxAgeMs / 1000)}s` : "không giới hạn thời gian"})`,
    );
    void this.tick(); // đẩy file sót từ lần chạy trước
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Một lượt: không chạy chồng lên nhau. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Đóng segment hiện tại rồi upload hết (khi tắt / khi được gọi flush). */
  async flushAll(): Promise<void> {
    await this.writer.flush();
    await this.writer.closeCurrent();
    if (this.running) await this.running;
    await this.tick();
  }

  private isOwn(file: string) {
    return file.endsWith(`-${this.writer.instanceId}.jsonl.gz`);
  }

  private closedSegments(): SegmentFile[] {
    if (!fs.existsSync(this.storageDir)) return [];
    const current = this.writer.currentPath;
    const orphanAfter = this.options.orphanAfterMs ?? DEFAULT_S3_ORPHAN_AFTER_MS;
    const now = Date.now();
    const out: SegmentFile[] = [];
    for (const day of fs.readdirSync(this.storageDir)) {
      if (!DAY_DIR.test(day)) continue;
      const dir = path.join(this.storageDir, day);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const set = new Set(files);
      for (const file of files) {
        if (!file.endsWith(".jsonl.gz")) continue;
        const full = path.join(dir, file);
        if (full === current) continue;
        if (set.has(file + UPLOADED_MARKER)) continue; // keepLocal: đã upload
        if (!this.isOwn(file)) {
          // Của instance khác (hoặc tên cũ không có instance): chỉ nhận khi đã bỏ không đủ lâu.
          try {
            if (now - fs.statSync(full).mtimeMs < orphanAfter) continue;
          } catch {
            continue;
          }
        }
        out.push({ day, file, full });
      }
    }
    return out.sort((a, b) => a.full.localeCompare(b.full));
  }

  private async runOnce(): Promise<void> {
    try {
      await this.writer.closeIfOlderThan(this.segmentMaxAgeMs);
      const segments = this.closedSegments();
      this.stats.pending = segments.length;
      if (segments.length === 0) return;
      this.s3 ??= await loadS3(this.options);
      const { sdk, client } = this.s3;

      for (const seg of segments) {
        try {
          const body = fs.readFileSync(seg.full);
          if (body.length > 0) {
            await client.send(
              new sdk.PutObjectCommand({
                Bucket: this.options.bucket,
                Key: this.keyFor(seg.day, seg.file),
                Body: body,
                ContentType: "application/gzip",
              }),
            );
            this.stats.uploaded++;
            this.stats.bytes += body.length;
            this.stats.lastUploadAt = Date.now();
          }
          if (this.options.keepLocal && body.length > 0) fs.writeFileSync(seg.full + UPLOADED_MARKER, "");
          else fs.rmSync(seg.full, { force: true });
          this.stats.pending--;
        } catch (err: any) {
          // Giữ file, lượt sau thử lại
          this.stats.failed++;
          this.stats.lastError = `${seg.file}: ${err?.name || ""} ${err?.message || err}`.trim();
          console.error(`❌ [Telemetry Stash] S3 upload failed (sẽ thử lại): ${this.stats.lastError}`);
        }
      }
    } catch (err: any) {
      this.stats.failed++;
      this.stats.lastError = err?.message || String(err);
      console.error(`❌ [Telemetry Stash] S3 uploader: ${this.stats.lastError}`);
    }
  }
}
