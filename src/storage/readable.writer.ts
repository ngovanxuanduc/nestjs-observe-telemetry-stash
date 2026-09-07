import * as fs from "node:fs";
import * as path from "node:path";

export function writeReadablePayload(
  storageDir: string,
  type: "traces" | "logs" | "metrics",
  otlpPayload: any,
) {
  const today = new Date().toISOString().slice(0, 10);
  const dirPath = path.join(storageDir, today);

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const filePath = path.join(dirPath, `readable-${type}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(otlpPayload) + "\n", "utf-8");
}
