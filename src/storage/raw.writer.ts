import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

export function writeRawPayload(storageDir: string, rawBuffer: Buffer) {
  const today = new Date().toISOString().slice(0, 10);
  const dirPath = path.join(storageDir, today);

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const filePath = path.join(dirPath, "raw-payloads.jsonl.gz");
  const line = rawBuffer.toString("utf-8").trim() + "\n";
  const compressed = zlib.gzipSync(Buffer.from(line, "utf-8"));

  fs.appendFileSync(filePath, compressed);
}
