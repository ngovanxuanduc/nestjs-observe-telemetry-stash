import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
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

  const rawFilePath = path.join(storageDir, date, "raw-payloads.jsonl.gz");

  if (!fs.existsSync(rawFilePath)) {
    console.error(`❌ Raw file not found: ${rawFilePath}`);
    return;
  }

  const compressedBuffer = fs.readFileSync(rawFilePath);
  const decompressedText = zlib.gunzipSync(compressedBuffer).toString("utf-8");
  const lines = decompressedText.split("\n").filter((l) => l.trim().length > 0);

  console.log(`🚀 Replaying ${lines.length} raw payloads for date: ${date}...`);

  for (const line of lines) {
    const rawPayload = JSON.parse(line);
    const { traces, logs, metrics } = transformToOtlp(rawPayload);

    if (traces) {
      await fetch(targetTraces, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(traces),
      });
    }
    if (logs) {
      await fetch(targetLogs, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(logs),
      });
    }
    if (metrics) {
      await fetch(targetMetrics, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metrics),
      });
    }
  }

  console.log(`✅ Replay complete!`);
}
