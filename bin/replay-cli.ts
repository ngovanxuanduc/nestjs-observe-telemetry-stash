#!/usr/bin/env node
import { replayStash } from "../src/replay/otlp.sender.js";

const args = process.argv.slice(2);
const dateArg = args.find((a) => a.startsWith("--date="))?.split("=")[1];
const dirArg = args.find((a) => a.startsWith("--dir="))?.split("=")[1];

replayStash({
  date: dateArg,
  storageDir: dirArg,
}).catch((err) => console.error("Replay failed:", err));
