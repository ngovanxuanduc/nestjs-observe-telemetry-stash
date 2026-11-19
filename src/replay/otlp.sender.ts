import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as readline from "node:readline/promises";
import { PassThrough, Readable } from "node:stream";
import { transformToOtlp } from "../transformer/index.js";
import { ReplayOptions } from "../types.js";
import { postOtlp } from "../otlp/http.js";
import { parseS3Url } from "../config.js";
import { loadS3 } from "../storage/s3.client.js";

interface Segment {
  name: string;
  open: () => Promise<Readable>;
}

/** Segment của một ngày trong thư mục local. */
function localSegments(storageDir: string, date: string): Segment[] | null {
  const dayDirPath = path.join(storageDir, date);
  if (!fs.existsSync(dayDirPath)) {
    console.error(`❌ Storage directory not found: ${dayDirPath}`);
    return null;
  }
  return fs
    .readdirSync(dayDirPath)
    .filter((file) => file.endsWith(".jsonl.gz"))
    .sort() // tên file bắt đầu bằng timestamp
    .map((file) => ({
      name: file,
      open: async () => fs.createReadStream(path.join(dayDirPath, file)),
    }));
}

/** Segment của một ngày trên S3: `s3://bucket/prefix/<YYYY-MM-DD>/*.jsonl.gz` */
async function s3Segments(options: ReplayOptions, date: string): Promise<Segment[]> {
  const { bucket, prefix } = parseS3Url(options.s3Url!);
  const { sdk, client } = await loadS3({
    region: options.s3Region,
    endpoint: options.s3Endpoint,
    forcePathStyle: options.s3ForcePathStyle,
  });
  const dayPrefix = [prefix, date].filter(Boolean).join("/") + "/";
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: dayPrefix, ContinuationToken: token }),
    );
    for (const o of page.Contents || []) if (o.Key?.endsWith(".jsonl.gz")) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return keys.sort().map((key) => ({
    name: `s3://${bucket}/${key}`,
    open: async () => {
      const obj = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
      return obj.Body as Readable;
    },
  }));
}

export async function replayStash(options: ReplayOptions) {
  const date = options.date || new Date().toISOString().slice(0, 10);
  const targetTraces = options.targetTracesUrl || "http://localhost:4318/v1/traces";
  const targetLogs = options.targetLogsUrl || "http://localhost:4318/v1/logs";
  const targetMetrics = options.targetMetricsUrl || "http://localhost:4318/v1/metrics";
  const headers = options.headers || {};

  const segments = options.s3Url
    ? await s3Segments(options, date)
    : localSegments(options.storageDir || "./telemetry-storage", date);
  if (!segments) return;

  if (segments.length === 0) {
    console.log(`ℹ️ No .jsonl.gz segment files found for ${date}${options.s3Url ? ` in ${options.s3Url}` : ""}`);
    return;
  }

  console.log(`🚀 [Segmented Replay] Found ${segments.length} segment file(s) for date: ${date}`);

  let totalLinesProcessed = 0;
  let totalSuccess = 0;
  let failedSegments = 0;

  for (const segment of segments) {
    console.log(`  └─ Processing segment: ${segment.name}...`);

    // Một segment không mở được (S3 AccessDenied, NoSuchKey, lỗi mạng...) không được làm hỏng cả lượt.
    let source: Readable;
    try {
      source = await segment.open();
    } catch (err: any) {
      failedSegments++;
      console.error(`❌ [Replay] Không mở được ${segment.name}: ${err?.name || ""} ${err?.message || err}`.trim());
      continue;
    }
    // Segment có thể bị cụt (process bị kill giữa lúc ghi): đọc hết phần lành rồi đi tiếp.
    const gunzip = zlib.createGunzip();
    const lines = new PassThrough();
    let ended = false;
    const truncated = (err: Error) => {
      if (ended) return;
      ended = true;
      console.warn(`⚠️  [Replay] ${segment.name} bị cụt/hỏng (${err.message}) — đã đọc phần còn nguyên.`);
      // Giải phóng luồng nguồn (socket HTTP của S3 / file descriptor) thay vì để treo.
      source.unpipe(gunzip);
      source.destroy();
      gunzip.destroy();
      lines.end();
    };
    source.on("error", truncated);
    gunzip.on("error", truncated);
    source.pipe(gunzip).pipe(lines);
    const rl = readline.createInterface({ input: lines, crlfDelay: Infinity });

    let lineIndex = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineIndex++;
      totalLinesProcessed++;

      try {
        const rawPayload = JSON.parse(line);
        const { traces, logs, metrics } = transformToOtlp(rawPayload);

        if (traces) await postOtlp(targetTraces, traces, headers);
        if (logs) await postOtlp(targetLogs, logs, headers);
        if (metrics) await postOtlp(targetMetrics, metrics, headers);

        totalSuccess++;
      } catch (err: any) {
        console.error(`❌ [Replay Failed] ${segment.name} - Line ${lineIndex}: ${err.message}`);
      }
    }
  }

  console.log(
    `✅ [Replay Finish] Replayed ${totalSuccess}/${totalLinesProcessed} payloads across ${segments.length} segments` +
      (failedSegments ? ` (${failedSegments} segment không mở được).` : "."),
  );
}
