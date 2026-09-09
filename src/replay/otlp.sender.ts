import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as readline from "node:readline/promises";
import { transformToOtlp } from "../transformer/index.js";
import { ReplayOptions } from "../types.js";

export async function replayStash(options: ReplayOptions) {
  const date = options.date || new Date().toISOString().slice(0, 10);
  const storageDir = options.storageDir || "./telemetry-storage";
  const targetTraces =
    options.targetTracesUrl || "http://localhost:4318/v1/traces";
  const targetLogs = options.targetLogsUrl || "http://localhost:4318/v1/logs";
  const targetMetrics =
    options.targetMetricsUrl || "http://localhost:4318/v1/metrics";

  const dayDirPath = path.join(storageDir, date);

  if (!fs.existsSync(dayDirPath)) {
    console.error(`❌ Storage directory not found: ${dayDirPath}`);
    return;
  }

  // 💡 Lấy danh sách tất cả các file .jsonl.gz (bao gồm segment-* và raw-payloads cũ)
  const segmentFiles = fs
    .readdirSync(dayDirPath)
    .filter((file) => file.endsWith(".jsonl.gz"))
    .sort(); // Sắp xếp theo thứ tự timestamp trong tên file

  if (segmentFiles.length === 0) {
    console.log(`ℹ️ No .jsonl.gz segment files found in ${dayDirPath}`);
    return;
  }

  console.log(
    `🚀 [Segmented Replay] Found ${segmentFiles.length} segment file(s) for date: ${date}`,
  );

  let totalLinesProcessed = 0;
  let totalSuccess = 0;

  for (const file of segmentFiles) {
    const filePath = path.join(dayDirPath, file);
    console.log(`  └─ Processing segment: ${file}...`);

    const fileStream = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({
      input: fileStream.pipe(gunzip),
      crlfDelay: Infinity,
    });

    let lineIndex = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineIndex++;
      totalLinesProcessed++;

      try {
        const rawPayload = JSON.parse(line);
        const { traces, logs, metrics } = transformToOtlp(rawPayload);

        if (traces) await sendOtlpPayload(targetTraces, traces, "traces");
        if (logs) await sendOtlpPayload(targetLogs, logs, "logs");
        if (metrics) await sendOtlpPayload(targetMetrics, metrics, "metrics");

        totalSuccess++;
      } catch (err: any) {
        console.error(
          `❌ [Replay Failed] File ${file} - Line ${lineIndex}: ${err.message}`,
        );
      }
    }
  }

  console.log(
    `✅ [Replay Finish] Replayed ${totalSuccess}/${totalLinesProcessed} payloads across ${segmentFiles.length} segments.`,
  );
}

async function sendOtlpPayload(url: string, payload: any, type: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(
      `[${type}] Target returned status ${res.status} ${res.statusText}`,
    );
  }
}
