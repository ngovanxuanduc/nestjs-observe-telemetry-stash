#!/usr/bin/env node
// Tạo (hoặc cập nhật) dashboard "NestJS Observe" trong ClickStack/HyperDX.
//
//   node clickstack/dashboard.mjs                       # API mặc định http://localhost:8000
//   node clickstack/dashboard.mjs --api=http://host:8000 --name="NestJS Observe (prod)"
//   node clickstack/dashboard.mjs --print               # chỉ in JSON, không gọi API
//
// Dùng API nội bộ của HyperDX (không cần key ở bản clickstack-local "no auth").
// Mọi tile là Raw SQL trên các bảng otel_* mặc định, có dropdown lọc theo Service.

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.replace(/^--/, ""), true] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
const API = String(args.api || process.env.HYPERDX_API || "http://localhost:8000").replace(/\/$/, "");
const UI = String(args.ui || process.env.HYPERDX_UI || "http://localhost:8080").replace(/\/$/, "");
const NAME = String(args.name || "NestJS Observe");
const DB = String(args.db || "default");

// ---------- SQL dùng chung ----------
const T = {
  traces: `${DB}.otel_traces`,
  logs: `${DB}.otel_logs`,
  gauge: `${DB}.otel_metrics_gauge`,
  sum: `${DB}.otel_metrics_sum`,
  summary: `${DB}.otel_metrics_summary`,
};
const SVC = "$__filter(ServiceName, $service)";
const BUCKET = (col) => `toStartOfInterval(${col}, INTERVAL {intervalSeconds:Int64} second)`;
const STATUS = "toUInt16OrZero(SpanAttributes['http.status_code'])";
const MS = (expr) => `round(${expr} / 1e6, 1)`;
// Chỉ lấy metric do stash/transformer gửi (bỏ metric nội bộ của OTel collector trong ClickStack)
const FROM_OBSERVE = "ScopeName = '@nestjs/observe'";
// Metric do app tự định nghĩa = không phải runtime metrics của transformer
const IS_CUSTOM = `${FROM_OBSERVE} AND MetricName NOT LIKE 'process.%' AND MetricName NOT LIKE 'nodejs.%'`;
const SERIES = "concat(MetricName, if(empty(Attributes), '', concat(' ', toString(Attributes))))";

const runtimeGauge = (names, valueExpr = "avg(Value)") => `SELECT
  ${BUCKET("TimeUnix")} AS ts,
  MetricName AS metric,
  ${valueExpr} AS value
FROM ${T.gauge}
WHERE $__timeFilter(TimeUnix)
  AND MetricName IN (${names.map((n) => `'${n}'`).join(", ")})
  AND ${SVC}
GROUP BY ts, metric
ORDER BY ts
LIMIT 10000`;

// ---------- Tiles: [tên, displayType, x, y, w, h, sql] ----------
const section = (title, y, text) => ({ markdown: `### ${title}\n${text}`, x: 0, y, w: 24, h: 2 });

const tiles = [
  section("Requests", 0, "Span SERVER (mỗi request HTTP/RPC/GraphQL là một span gốc). Lỗi = 5xx; 4xx là lỗi phía client nên không tính."),

  ["Requests", "number", 0, 2, 6, 3, `SELECT count() AS requests
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Server' AND ${SVC}`],

  ["Error rate 5xx (%)", "number", 6, 2, 6, 3, `SELECT round(100 * countIf(StatusCode = 'Error') / greatest(count(), 1), 2) AS error_rate_pct
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Server' AND ${SVC}`],

  ["Latency p95 (ms)", "number", 12, 2, 6, 3, `SELECT ${MS("quantile(0.95)(Duration)")} AS p95_ms
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Server' AND ${SVC}`],

  ["Failed jobs", "number", 18, 2, 6, 3, `SELECT countIf(StatusCode = 'Error') AS failed_jobs
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Consumer' AND ${SVC}`],

  ["Throughput theo status", "stacked_bar", 0, 5, 12, 6, `SELECT
  ${BUCKET("Timestamp")} AS ts,
  multiIf(${STATUS} >= 500, '5xx', ${STATUS} >= 400, '4xx', '2xx/3xx') AS status,
  count() AS requests
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Server' AND ${SVC}
GROUP BY ts, status
ORDER BY ts
LIMIT 10000`],

  ["Latency p50 / p95 / p99 (ms)", "line", 12, 5, 12, 6, `SELECT
  ${BUCKET("Timestamp")} AS ts,
  ${MS("quantile(0.5)(Duration)")} AS p50,
  ${MS("quantile(0.95)(Duration)")} AS p95,
  ${MS("quantile(0.99)(Duration)")} AS p99
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Server' AND ${SVC}
GROUP BY ts
ORDER BY ts
LIMIT 10000`],

  ["Endpoints", "table", 0, 11, 24, 8, `SELECT
  SpanName AS endpoint,
  count() AS calls,
  countIf(${STATUS} BETWEEN 400 AND 499) AS errors_4xx,
  countIf(StatusCode = 'Error') AS errors_5xx,
  ${MS("quantile(0.5)(Duration)")} AS p50_ms,
  ${MS("quantile(0.95)(Duration)")} AS p95_ms,
  ${MS("max(Duration)")} AS max_ms
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Server' AND ${SVC}
GROUP BY endpoint
ORDER BY calls DESC
LIMIT 100`],

  section("Bên trong request", 19, "Span con do Observe ghi: method của Guard/Pipe/Service, và lời gọi ra ngoài (HTTP, DB, LLM)."),

  ["Method chậm nhất (p95)", "table", 0, 21, 12, 8, `SELECT
  SpanName AS method,
  count() AS calls,
  ${MS("quantile(0.95)(Duration)")} AS p95_ms,
  ${MS("sum(Duration)")} AS total_ms,
  countIf(StatusCode = 'Error') AS errors
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Internal' AND ${SVC}
GROUP BY method
ORDER BY p95_ms DESC
LIMIT 30`],

  ["Gọi ra ngoài (HTTP / DB)", "table", 12, 21, 12, 8, `SELECT
  SpanName AS call,
  coalesce(nullIf(SpanAttributes['db.system'], ''), nullIf(SpanAttributes['llm.provider'], ''), 'http') AS kind,
  count() AS calls,
  ${MS("quantile(0.95)(Duration)")} AS p95_ms,
  countIf(StatusCode = 'Error') AS errors
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Client' AND ${SVC}
GROUP BY call, kind
ORDER BY calls DESC
LIMIT 30`],

  section("Jobs", 29, "Queue / cron / interval job (span CONSUMER)."),

  ["Job runs theo trạng thái", "stacked_bar", 0, 31, 12, 6, `SELECT
  ${BUCKET("Timestamp")} AS ts,
  if(StatusCode = 'Error', 'failed', 'ok') AS status,
  count() AS runs
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Consumer' AND ${SVC}
GROUP BY ts, status
ORDER BY ts
LIMIT 10000`],

  ["Jobs", "table", 12, 31, 12, 6, `SELECT
  SpanName AS job,
  count() AS runs,
  countIf(StatusCode = 'Error') AS failed,
  ${MS("quantile(0.95)(Duration)")} AS p95_ms,
  max(Timestamp) AS last_run
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Consumer' AND ${SVC}
GROUP BY job
ORDER BY runs DESC
LIMIT 50`],

  section("Runtime", 37, "Runtime metrics của Observe (mặc định 30s/lần)."),

  ["Memory (MiB)", "line", 0, 39, 8, 6, runtimeGauge(["process.memory.heap_used", "process.memory.heap_total", "process.memory.rss"])],
  ["CPU (%)", "line", 8, 39, 8, 6, runtimeGauge(["process.cpu.percent"])],
  ["Event loop lag (ms)", "line", 16, 39, 8, 6, runtimeGauge(["nodejs.eventloop.lag"], "max(Value)")],
  ["Event loop utilization (%)", "line", 0, 45, 8, 6, runtimeGauge(["nodejs.eventloop.utilization"], "round(100 * avg(Value), 2)")],
  ["Heap usage (%)", "line", 8, 45, 8, 6, runtimeGauge(["process.memory.percent"])],
  ["GC duration theo loại (ms)", "stacked_bar", 16, 45, 8, 6, `SELECT
  ${BUCKET("TimeUnix")} AS ts,
  Attributes['gc.type'] AS gc_type,
  sum(Value) AS duration_ms
FROM ${T.gauge}
WHERE $__timeFilter(TimeUnix) AND MetricName = 'nodejs.gc.duration_by_type' AND ${SVC}
GROUP BY ts, gc_type
ORDER BY ts
LIMIT 10000`],

  section("Logs", 51, "Log forward từ Logger của Nest (forwardLogs)."),

  ["Log theo level", "stacked_bar", 0, 53, 12, 6, `SELECT
  ${BUCKET("Timestamp")} AS ts,
  SeverityText AS level,
  count() AS logs
FROM ${T.logs}
WHERE $__timeFilter_ms(Timestamp) AND ${SVC}
GROUP BY ts, level
ORDER BY ts
LIMIT 10000`],

  ["Log lỗi gần nhất", "table", 12, 53, 12, 6, `SELECT
  Timestamp AS time,
  ServiceName AS service,
  LogAttributes['log.context'] AS context,
  substring(Body, 1, 300) AS message,
  TraceId AS trace_id
FROM ${T.logs}
WHERE $__timeFilter_ms(Timestamp) AND SeverityNumber >= 17 AND ${SVC}
ORDER BY Timestamp DESC
LIMIT 50`],

  section("Custom metrics", 59, "Counter / Gauge / Summary do app tự định nghĩa qua TracerService."),

  ["Counters (luỹ kế)", "line", 0, 61, 12, 6, `SELECT
  ${BUCKET("TimeUnix")} AS ts,
  ${SERIES} AS series,
  max(Value) AS value
FROM ${T.sum}
WHERE $__timeFilter(TimeUnix) AND ${IS_CUSTOM} AND ${SVC}
GROUP BY ts, series
ORDER BY ts
LIMIT 10000`],

  ["Gauges", "line", 12, 61, 12, 6, `SELECT
  ${BUCKET("TimeUnix")} AS ts,
  ${SERIES} AS series,
  avg(Value) AS value
FROM ${T.gauge}
WHERE $__timeFilter(TimeUnix) AND ${IS_CUSTOM} AND MetricName NOT LIKE '%.max' AND ${SVC}
GROUP BY ts, series
ORDER BY ts
LIMIT 10000`],

  ["Summaries (p95)", "line", 0, 67, 12, 6, `SELECT
  ${BUCKET("TimeUnix")} AS ts,
  ${SERIES} AS series,
  max(ValueAtQuantiles.Value[indexOf(ValueAtQuantiles.Quantile, 0.95)]) AS p95
FROM ${T.summary}
WHERE $__timeFilter(TimeUnix) AND ${FROM_OBSERVE} AND ${SVC}
GROUP BY ts, series
ORDER BY ts
LIMIT 10000`],

  ["Summaries (tổng hợp)", "table", 12, 67, 12, 6, `SELECT
  ${SERIES} AS series,
  sum(Count) AS observations,
  round(sum(Sum) / greatest(sum(Count), 1), 2) AS mean,
  max(ValueAtQuantiles.Value[indexOf(ValueAtQuantiles.Quantile, 0.95)]) AS max_p95
FROM ${T.summary}
WHERE $__timeFilter(TimeUnix) AND ${FROM_OBSERVE} AND ${SVC}
GROUP BY series
ORDER BY observations DESC
LIMIT 50`],
];

// ---------- Build dashboard (định dạng nội bộ của HyperDX) ----------
const randomId = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);

export function buildDashboard({ connectionId, traceSourceId }) {
  return {
    name: NAME,
    tags: ["nestjs-observe"],
    tiles: tiles.map((t) => {
      if (!Array.isArray(t)) {
        return {
          id: randomId(),
          x: t.x, y: t.y, w: t.w, h: t.h,
          config: { displayType: "markdown", markdown: t.markdown, source: "", where: "", select: [], name: "" },
        };
      }
      const [name, displayType, x, y, w, h, sqlTemplate] = t;
      return {
        id: randomId(),
        x, y, w, h,
        config: { configType: "sql", displayType, name, connection: connectionId, sqlTemplate },
      };
    }),
    filters: [
      {
        id: randomId(),
        type: "QUERY_EXPRESSION",
        name: "Service",
        expression: "ServiceName",
        source: traceSourceId,
        where: "",
        whereLanguage: "sql",
        isBroadcastEnabled: false,
        isVariableEnabled: true,
        variableName: "service",
      },
    ],
  };
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 2000)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  if (args.print) {
    console.log(JSON.stringify(buildDashboard({ connectionId: "<connection>", traceSourceId: "<trace-source>" }), null, 2));
    return;
  }
  const sources = await api("GET", "/sources");
  const traceSource = sources.find((s) => s.kind === "trace");
  if (!traceSource) throw new Error("Không tìm thấy source kiểu trace trong HyperDX");
  const connectionId = traceSource.connection;
  const dashboard = buildDashboard({ connectionId, traceSourceId: traceSource._id || traceSource.id });

  const existing = (await api("GET", "/dashboards")).find((d) => d.name === NAME);
  let id;
  if (existing) {
    id = existing._id || existing.id;
    await api("PATCH", `/dashboards/${id}`, dashboard);
    console.log(`♻️  Đã cập nhật dashboard "${NAME}"`);
  } else {
    const created = await api("POST", "/dashboards", dashboard);
    id = created._id || created.id;
    console.log(`✅ Đã tạo dashboard "${NAME}"`);
  }
  console.log(`🔗 ${UI}/dashboards/${id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("❌", e.message);
    process.exit(1);
  });
}
