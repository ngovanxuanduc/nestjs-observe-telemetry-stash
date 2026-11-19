import { OtlpAttribute, msToNs, pushAttr, pushAttrs, toSpanId, toTraceId } from "./otlp.util.js";

export function mapLogLevel(level?: string): string {
  const l = String(level || "").toLowerCase();
  switch (l) {
    case "log":
      return "INFO";
    case "verbose":
      return "TRACE";
    case "warn":
      return "WARN";
    case "error":
      return "ERROR";
    case "debug":
      return "DEBUG";
    case "fatal":
      return "FATAL";
    default:
      return l.toUpperCase() || "INFO";
  }
}

const SEVERITY_NUMBER: Record<string, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

export function buildLogRecord(log: any, receivedNs: bigint) {
  const severityText = mapLogLevel(log.level);
  const attributes: OtlpAttribute[] = [];
  pushAttr(attributes, "log.context", log.context);
  pushAttr(attributes, "process.pid", log.pid !== undefined ? Number(log.pid) : undefined);
  pushAttrs(attributes, log.attributes);

  const timeNs =
    typeof log.timestamp === "number" ? msToNs(log.timestamp) : receivedNs;

  const record: any = {
    timeUnixNano: timeNs.toString(),
    observedTimeUnixNano: receivedNs.toString(),
    severityText,
    severityNumber: SEVERITY_NUMBER[severityText] ?? 9,
    body: { stringValue: log.text ?? log.message ?? "" },
    attributes,
  };
  const traceId = toTraceId(log.traceId);
  if (traceId) record.traceId = traceId;
  const spanId = toSpanId(log.spanId);
  if (spanId) record.spanId = spanId;
  return record;
}
