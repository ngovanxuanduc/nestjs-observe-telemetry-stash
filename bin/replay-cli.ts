#!/usr/bin/env node
import { replayStash } from "../src/replay/otlp.sender.js";

const args = process.argv.slice(2);
// Lấy phần sau dấu "=" đầu tiên (URL có query string cũng chứa "=").
const flag = (name: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : undefined;
};

replayStash({
  date: flag("date"),
  storageDir: flag("dir"),
  targetTracesUrl: flag("target-traces"),
  targetLogsUrl: flag("target-logs"),
  targetMetricsUrl: flag("target-metrics"),
}).catch((err) => console.error("Replay failed:", err));
