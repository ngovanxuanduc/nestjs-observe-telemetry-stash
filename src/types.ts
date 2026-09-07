export interface StashOptions {
  /** Cổng HTTP Receiver lắng nghe (Mặc định: 3301) */
  port?: number;
  /** Thư mục lưu file (Mặc định: ./telemetry-storage) */
  storageDir?: string;
  /** Lưu raw payload thô nén .jsonl.gz để replay (Mặc định: true) */
  raw?: boolean;
  /** Convert OTLP JSON và lưu .jsonl thô để debug (Mặc định: false) */
  readable?: boolean;
}

export interface ReplayOptions {
  storageDir?: string;
  date?: string; // YYYY-MM-DD
  targetTracesUrl?: string;
  targetLogsUrl?: string;
  targetMetricsUrl?: string;
}
