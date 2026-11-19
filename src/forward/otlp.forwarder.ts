import {
  DEFAULT_FORWARD_ENDPOINT,
  DEFAULT_FORWARD_MAX_IN_FLIGHT,
  DEFAULT_FORWARD_TIMEOUT_MS,
} from "../constants.js";
import { otlpUrls, postOtlp } from "../otlp/http.js";
import { transformToOtlp } from "../transformer/index.js";
import { ForwardOptions } from "../types.js";

/**
 * Đẩy OTLP lên collector ngay khi nhận (best-effort). Lỗi/quá tải chỉ đếm, không retry:
 * file thô vẫn được lưu (local / S3) nên luôn replay lại được.
 */
export class OtlpForwarder {
  private inFlight = 0;
  private readonly urls: ReturnType<typeof otlpUrls>;
  private lastErrorLogAt = 0;
  readonly stats = { forwarded: 0, failed: 0, dropped: 0, lastError: "" as string };

  constructor(private readonly options: ForwardOptions) {
    this.urls = otlpUrls(options.endpoint || DEFAULT_FORWARD_ENDPOINT);
  }

  get endpoint() {
    return this.options.endpoint || DEFAULT_FORWARD_ENDPOINT;
  }

  /** Không chặn request: chạy nền, giới hạn số payload đồng thời. */
  submit(rawJson: string) {
    const max = this.options.maxInFlight ?? DEFAULT_FORWARD_MAX_IN_FLIGHT;
    if (this.inFlight >= max) {
      this.stats.dropped++;
      return;
    }
    this.inFlight++;
    setImmediate(() => {
      this.forward(rawJson).finally(() => {
        this.inFlight--;
      });
    });
  }

  private async forward(rawJson: string) {
    try {
      const { traces, logs, metrics } = transformToOtlp(JSON.parse(rawJson));
      const headers = this.options.headers || {};
      const timeout = this.options.timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
      const jobs: Promise<void>[] = [];
      if (traces) jobs.push(postOtlp(this.urls.traces, traces, headers, timeout));
      if (logs) jobs.push(postOtlp(this.urls.logs, logs, headers, timeout));
      if (metrics) jobs.push(postOtlp(this.urls.metrics, metrics, headers, timeout));
      const results = await Promise.allSettled(jobs);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length) throw failed[0].reason;
      this.stats.forwarded++;
    } catch (err: any) {
      this.stats.failed++;
      this.stats.lastError = err?.message || String(err);
      // Collector sập thì lỗi dồn dập → log tối đa 1 lần / 30s
      if (Date.now() - this.lastErrorLogAt > 30_000) {
        this.lastErrorLogAt = Date.now();
        console.error(
          `❌ [Telemetry Stash] Forward OTLP thất bại (dữ liệu vẫn trong stash, replay được): ${this.stats.lastError}`,
        );
      }
    }
  }

  /** Chờ các payload đang forward xong (khi tắt), tối đa `timeoutMs`. */
  async drain(timeoutMs = 5000) {
    const until = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }
}
