export interface StashOptions {
  /** Cổng HTTP Receiver lắng nghe (Mặc định: 3301) */
  port?: number;
  /** Thư mục lưu file (Mặc định: ./telemetry-storage) */
  storageDir?: string;
  /** Lưu raw payload thô nén .jsonl.gz để replay (Mặc định: true) */
  raw?: boolean;
  /** Convert OTLP JSON và lưu .jsonl thô để debug (Mặc định: false) */
  readable?: boolean;
  /** Giới hạn số lượng payload chờ ghi trong RAM (Mặc định: 1000) */
  maxQueueSize?: number;
  /** Giới hạn dung lượng HTTP request body (Mặc định: 10MB) */
  maxBodySize?: number;
  /** Dung lượng tối đa của 1 file segment nén (Mặc định: 10MB = 10 * 1024 * 1024 bytes) */
  maxSegmentSizeBytes?: number;
}

export interface ReplayOptions {
  storageDir?: string;
  date?: string; // YYYY-MM-DD
  targetTracesUrl?: string;
  targetLogsUrl?: string;
  targetMetricsUrl?: string;
}
