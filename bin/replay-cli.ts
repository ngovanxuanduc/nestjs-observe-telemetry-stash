#!/usr/bin/env node
import { replayStash } from "../src/replay/otlp.sender.js";

const args = process.argv.slice(2);
const dateArg = args.find((a) => a.startsWith("--date="))?.split("=")[1];
const dirArg = args.find((a) => a.startsWith("--dir="))?.split("=")[1];
const tracesArg = args
  .find((a) => a.startsWith("--target-traces="))
  ?.split("=")[1];
const logsArg = args.find((a) => a.startsWith("--target-logs="))?.split("=")[1];
const metricsArg = args
  .find((a) => a.startsWith("--target-metrics="))
  ?.split("=")[1];

replayStash({
  date: dateArg,
  storageDir: dirArg,
  targetTracesUrl: tracesArg,
  targetLogsUrl: logsArg,
  targetMetricsUrl: metricsArg,
}).catch((err) => console.error("Replay failed:", err));
