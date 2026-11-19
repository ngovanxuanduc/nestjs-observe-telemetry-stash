export interface S3Options {
  /** Bucket nhận segment. Có bucket = bật upload. */
  bucket: string;
  /** Tiền tố key (Mặc định: "telemetry"). Key: `<prefix>/<YYYY-MM-DD>/<segment>.jsonl.gz` */
  prefix?: string;
  /** Region (Mặc định: AWS_REGION / AWS_DEFAULT_REGION). */
  region?: string;
  /** Endpoint tuỳ chỉnh (MinIO, LocalStack). Bỏ trống trên AWS. */
  endpoint?: string;
  /** Path-style URL (cần cho MinIO). */
  forcePathStyle?: boolean;
  /** Giữ file local sau khi upload (Mặc định: false = xoá). */
  keepLocal?: boolean;
  /** Chu kỳ quét + upload (Mặc định: 30s). */
  uploadIntervalMs?: number;
  /**
   * Segment của instance KHÁC (hoặc file tên cũ không có instance) chỉ được upload khi không ai
   * ghi vào lâu hơn ngưỡng này — tránh upload/xoá file mà instance kia còn đang ghi (Mặc định: 1 giờ).
   */
  orphanAfterMs?: number;
}

export interface ForwardOptions {
  /** Bật đẩy OTLP ngay khi nhận (Mặc định: false). File thô vẫn luôn được lưu. */
  enabled: boolean;
  /** Base URL OTLP/HTTP, vd `http://otel-collector:4318` (Mặc định: http://localhost:4318). */
  endpoint?: string;
  /** Header gửi kèm, vd `{ authorization: "<ingestion key>" }`. */
  headers?: Record<string, string>;
  /** Timeout mỗi request (Mặc định: 5000ms). */
  timeoutMs?: number;
  /** Số payload đang forward cùng lúc tối đa; vượt thì bỏ (đã có file thô để replay). Mặc định: 20. */
  maxInFlight?: number;
}

export interface StashOptions {
  /** Cổng HTTP Receiver lắng nghe (Mặc định: 3301) */
  port?: number;
  /** Địa chỉ lắng nghe (Mặc định: 0.0.0.0). Sidecar ECS: 127.0.0.1 */
  host?: string;
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
  /** Đóng segment sau khoảng thời gian này (Mặc định: 0 = không; có S3 thì 5 phút) */
  segmentMaxAgeMs?: number;
  /** Định danh instance, ghép vào tên file để nhiều process ghi chung thư mục / bucket không đè nhau. */
  instanceId?: string;
  /** Upload segment đã đóng lên S3. */
  s3?: S3Options;
  /** Forward OTLP trực tiếp tới collector. */
  forward?: ForwardOptions;
}

export interface ReplayOptions {
  storageDir?: string;
  /** Đọc từ S3 thay vì thư mục local: `s3://bucket/prefix` */
  s3Url?: string;
  /** Region / endpoint cho S3 (MinIO...) */
  s3Region?: string;
  s3Endpoint?: string;
  s3ForcePathStyle?: boolean;
  date?: string; // YYYY-MM-DD
  targetTracesUrl?: string;
  targetLogsUrl?: string;
  targetMetricsUrl?: string;
  /** Header gửi kèm (vd authorization của ClickStack). */
  headers?: Record<string, string>;
}
