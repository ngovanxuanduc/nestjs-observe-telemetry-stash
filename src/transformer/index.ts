import { buildJobSpans, buildRequestSpans } from "./trace.transformer.js";
import { buildLogRecord } from "./log.transformer.js";
import { buildCustomMetrics, buildRuntimeMetrics } from "./metric.transformer.js";
import { msToNs, payloadTimeMs, pushAttr, OtlpAttribute } from "./otlp.util.js";

const SCOPE = { name: "@nestjs/observe" };

/** Một batch Observe (định dạng wire của agent) → payload OTLP/JSON cho traces, logs, metrics. */
export function transformToOtlp(payload: any) {
  const timeMs = payloadTimeMs(payload);
  const timeNs = msToNs(timeMs);

  const resourceAttributes: OtlpAttribute[] = [];
  pushAttr(resourceAttributes, "service.name", payload.serviceId || "nest-app");
  pushAttr(resourceAttributes, "service.version", payload.serviceVersion || payload.v);
  const resource = { attributes: resourceAttributes };

  // 1. Traces
  const spans: any[] = [];
  for (const s of payload.snapshots || []) spans.push(...buildRequestSpans(s, timeMs));
  for (const j of payload.jobs || []) spans.push(...buildJobSpans(j, timeMs));
  const tracesPayload = spans.length
    ? { resourceSpans: [{ resource, scopeSpans: [{ scope: SCOPE, spans }] }] }
    : null;

  // 2. Logs
  const logRecords = (payload.logs || []).map((l: any) => buildLogRecord(l, timeNs));
  const logsPayload = logRecords.length
    ? { resourceLogs: [{ resource, scopeLogs: [{ scope: SCOPE, logRecords }] }] }
    : null;

  // 3. Metrics
  const metrics: any[] = [...buildRuntimeMetrics(payload.runtime, timeNs.toString())];
  // `custom` là tên thật trên wire; `metrics` giữ lại phòng payload tự chế cũ.
  for (const cm of payload.custom || payload.metrics || []) {
    metrics.push(...buildCustomMetrics(cm, timeMs));
  }
  const metricsPayload = metrics.length
    ? { resourceMetrics: [{ resource, scopeMetrics: [{ scope: SCOPE, metrics }] }] }
    : null;

  return { traces: tracesPayload, logs: logsPayload, metrics: metricsPayload };
}
