import { flattenSpans } from "./trace.transformer.js";
import { mapLogLevel } from "./log.transformer.js";
import { buildGaugeMetric, buildSumMetric } from "./metric.transformer.js";

const toHex = (uuid?: string, len?: number): string =>
  uuid ? uuid.replace(/-/g, "").slice(0, len) : "";

export function transformToOtlp(payload: any) {
  const serviceName = payload.serviceId || "nest-app";
  const serviceVersion = payload.serviceVersion || payload.v || "1.0.0";

  const resourceAttributes = [
    { key: "service.name", value: { stringValue: serviceName } },
    { key: "service.version", value: { stringValue: serviceVersion } },
  ];

  let tracesPayload = null;
  let logsPayload = null;
  let metricsPayload = null;

  // 1. Traces
  const allSnapshots = [
    ...(payload.snapshots || []).map((s: any) => ({ ...s, _isJob: false })),
    ...(payload.jobs || []).map((j: any) => ({ ...j, _isJob: true })),
  ];

  if (allSnapshots.length > 0) {
    tracesPayload = {
      resourceSpans: allSnapshots.map((snapshot) => {
        const traceIdHex = toHex(snapshot.ti, 32);
        const calledAtStr =
          snapshot.c || snapshot.ct || new Date().toISOString();
        const timeMs = new Date(calledAtStr).getTime();
        const safeTimeMs = Number.isNaN(timeMs) ? Date.now() : timeMs;
        const baseNs = BigInt(safeTimeMs) * 1000000n;

        const snapshotAttr = snapshot._isJob
          ? {
              queueName: snapshot.q,
              name: snapshot.n,
              status: snapshot.s,
              id: snapshot.i,
            }
          : snapshot.a;

        return {
          resource: { attributes: resourceAttributes },
          scopeSpans: [
            {
              spans: flattenSpans(
                snapshot.t || [],
                traceIdHex,
                "",
                baseNs,
                snapshot.e,
                snapshotAttr,
                snapshot.d,
                [],
                snapshot._isJob,
              ),
            },
          ],
        };
      }),
    };
  }

  // 2. Logs
  if (payload.logs && payload.logs.length > 0) {
    logsPayload = {
      resourceLogs: [
        {
          resource: { attributes: resourceAttributes },
          scopeLogs: [
            {
              logRecords: payload.logs.map((log: any) => ({
                timeUnixNano: (
                  BigInt(log.timestamp || Date.now()) * 1000000n
                ).toString(),
                traceId: toHex(log.traceId, 32),
                spanId: toHex(log.spanId, 16),
                severityText: mapLogLevel(log.level),
                body: { stringValue: log.message || log.text || "" },
                attributes: [
                  {
                    key: "log.context",
                    value: { stringValue: log.context || "" },
                  },
                  {
                    key: "process.pid",
                    value: { intValue: Number(log.pid || 0) },
                  },
                ],
              })),
            },
          ],
        },
      ],
    };
  }

  // 3. Metrics
  const nowNs = (BigInt(Date.now()) * 1000000n).toString();
  const metricsList: any[] = [];

  if (payload.runtime) {
    const { c, m, e } = payload.runtime;
    if (c?.p !== undefined)
      metricsList.push(buildGaugeMetric("process.cpu.percent", c.p, nowNs));
    if (m?.hu !== undefined)
      metricsList.push(
        buildGaugeMetric("process.memory.heap_used", m.hu, nowNs),
      );
    if (e?.l !== undefined)
      metricsList.push(buildGaugeMetric("nodejs.eventloop.lag", e.l, nowNs));
  }

  if (Array.isArray(payload.metrics)) {
    for (const cm of payload.metrics) {
      const name = cm.n || "custom.metric";
      if (cm.t === "counter")
        metricsList.push(
          buildSumMetric(name, cm.v?.default || cm.v || 0, nowNs),
        );
      if (cm.t === "gauge")
        metricsList.push(
          buildGaugeMetric(name, cm.v?.default || cm.v || 0, nowNs),
        );
      if (cm.t === "summary") {
        if (cm.q50?.default !== undefined)
          metricsList.push(
            buildGaugeMetric(`${name}.p50`, cm.q50.default, nowNs),
          );
        if (cm.q95?.default !== undefined)
          metricsList.push(
            buildGaugeMetric(`${name}.p95`, cm.q95.default, nowNs),
          );
        if (cm.q99?.default !== undefined)
          metricsList.push(
            buildGaugeMetric(`${name}.p99`, cm.q99.default, nowNs),
          );
        if (cm.sm?.default !== undefined)
          metricsList.push(buildSumMetric(`${name}.sum`, cm.sm.default, nowNs));
        if (cm.ct?.default !== undefined)
          metricsList.push(
            buildSumMetric(`${name}.count`, cm.ct.default, nowNs),
          );
      }
    }
  }

  if (metricsList.length > 0) {
    metricsPayload = {
      resourceMetrics: [
        {
          resource: { attributes: resourceAttributes },
          scopeMetrics: [{ metrics: metricsList }],
        },
      ],
    };
  }

  return { traces: tracesPayload, logs: logsPayload, metrics: metricsPayload };
}
