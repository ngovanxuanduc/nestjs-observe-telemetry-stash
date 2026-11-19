#!/usr/bin/env node
// Tạo (hoặc cập nhật) dashboard "NestJS Observe" trong ClickStack/HyperDX.
//
//   node clickstack/dashboard.mjs                       # API mặc định http://localhost:8000
//   node clickstack/dashboard.mjs --api=http://host:8000 --name="NestJS Observe (prod)"
//   node clickstack/dashboard.mjs --out=nestjs-observe.dashboard.json   # file để import qua UI
//   node clickstack/dashboard.mjs --print               # in JSON template ra stdout
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
// Instance do stash gắn (service.instance.id); dữ liệu cũ không có → gộp theo service.
const INSTANCE = "ResourceAttributes['service.instance.id']";
const INSTANCE_LABEL = `if(empty(${INSTANCE}), ServiceName, ${INSTANCE})`;
// Dropdown Service + Instance (biến dashboard; chưa chọn = tất cả)
const SVC = `$__filter(ServiceName, $service) AND $__filter(${INSTANCE}, $instance)`;
/** Ngưỡng "đang chạy": runtime metrics gửi 30s/lần → 3 nhịp. */
const ALIVE_SECONDS = Number(args["alive-seconds"] || 90);
const BUCKET = (col) => `toStartOfInterval(${col}, INTERVAL {intervalSeconds:Int64} second)`;
const STATUS = "toUInt16OrZero(SpanAttributes['http.status_code'])";
const MS = (expr) => `round(${expr} / 1e6, 1)`;
// Chỉ lấy metric do stash/transformer gửi (bỏ metric nội bộ của OTel collector trong ClickStack)
const FROM_OBSERVE = "ScopeName = '@nestjs/observe'";
// Metric do app tự định nghĩa = không phải runtime metrics của transformer
const IS_CUSTOM = `${FROM_OBSERVE} AND MetricName NOT LIKE 'process.%' AND MetricName NOT LIKE 'nodejs.%'`;
const SERIES = "concat(MetricName, if(empty(Attributes), '', concat(' ', toString(Attributes))))";

/** Runtime gauge, MỖI INSTANCE một đường (không gộp trung bình — gộp sẽ che instance có vấn đề). */
const runtimeGauge = (names, valueExpr = "avg(Value)") => `SELECT
  ${BUCKET("TimeUnix")} AS ts,
  ${names.length > 1 ? `concat(MetricName, ' · ', ${INSTANCE_LABEL})` : INSTANCE_LABEL} AS series,
  ${valueExpr} AS value
FROM ${T.gauge}
WHERE $__timeFilter(TimeUnix)
  AND MetricName IN (${names.map((n) => `'${n}'`).join(", ")})
  AND ${FROM_OBSERVE} AND ${SVC}
GROUP BY ts, series
ORDER BY ts
LIMIT 10000`;

// ---------- Bấm dòng trong bảng → nhảy sang trang Search ----------
// Đích chọn theo TÊN source (mặc định ClickStack đặt "Traces" / "Logs") nên import sang server
// khác không phải map ID. Mỗi filter thành `expression IN ('<giá trị cột của dòng>')`.
const TRACES_SOURCE = String(args["traces-source"] || "Traces");
const drillToTraces = (filters) => ({
  type: "search",
  target: { mode: "template", template: TRACES_SOURCE },
  whereLanguage: "sql",
  filters: Object.entries(filters).map(([expression, column]) => ({
    kind: "expressionTemplate",
    expression,
    template: `{{${column}}}`,
  })),
});

// ---------- Bấm dòng → trang Services (preset) của một trace ----------
// Trang /services nhận: source (id hoặc tên), where + whereLanguage, tab (database/http/...),
// service, from/to (ms). Link `external` phải là URL tuyệt đối → cần --ui=<URL ClickStack>.
// Giá trị để THÔ: HyperDX tự encode từng giá trị khi dựng link external
// (render(urlTemplate, row, { encodeValues: true })) — encode sẵn sẽ thành encode 2 lần.
// --services-source: ID source traces (xem trên URL trang Services); mặc định dùng tên.
const SERVICES_SOURCE = String(args["services-source"] || TRACES_SOURCE);
const servicesLink = (tab) => ({
  type: "external",
  urlTemplate:
    `${UI}/services?source=${encodeURIComponent(SERVICES_SOURCE)}&whereLanguage=sql&tab=${tab}` +
    "&service={{service}}&where={{trace_filter}}&from={{from_ms}}&to={{to_ms}}",
});
/** Các cột phục vụ link sang /services (đặt cuối bảng; bảng đã có cột `service`). */
const servicesLinkColumns = ({ traceId, startMs, endMs }) => `
  concat('TraceId = ''', ${traceId}, '''') AS trace_filter,
  ${startMs} AS from_ms,
  ${endMs} AS to_ms`;

// ---------- Tiles: [tên, displayType, x, y, w, h, sql, onClick?] ----------
const SERVICES_LINK = "[→ Mở trang Services](/services)";
const section = (title, y, text, link = "") => ({
  markdown: `### ${title}\n${text}${link ? `  ${link}` : ""}`,
  x: 0, y, w: 24, h: 2,
});

const tiles = [
  section("Requests", 0, "Span SERVER (mỗi request là một span gốc). Lỗi = 5xx. **Bấm một dòng trong bảng để xem trace của nó.**", SERVICES_LINK),

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
  ServiceName AS service,
  SpanName AS endpoint,
  count() AS calls,
  countIf(${STATUS} BETWEEN 400 AND 499) AS errors_4xx,
  countIf(StatusCode = 'Error') AS errors_5xx,
  ${MS("quantile(0.5)(Duration)")} AS p50_ms,
  ${MS("quantile(0.95)(Duration)")} AS p95_ms,
  ${MS("max(Duration)")} AS max_ms
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Server' AND ${SVC}
GROUP BY service, endpoint
ORDER BY calls DESC
LIMIT 100`, drillToTraces({ ServiceName: "service", SpanName: "endpoint" })],

  section("Bên trong request", 19, "Span con do Observe ghi: method của Guard/Pipe/Service, và lời gọi ra ngoài (HTTP, DB, LLM). Bấm dòng → trace.", SERVICES_LINK),

  ["Method chậm nhất (p95)", "table", 0, 21, 12, 8, `SELECT
  ServiceName AS service,
  SpanName AS method,
  count() AS calls,
  ${MS("quantile(0.95)(Duration)")} AS p95_ms,
  ${MS("sum(Duration)")} AS total_ms,
  countIf(StatusCode = 'Error') AS errors
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Internal' AND ${SVC}
GROUP BY service, method
ORDER BY p95_ms DESC
LIMIT 30`, drillToTraces({ ServiceName: "service", SpanName: "method" })],

  ["Gọi ra ngoài (HTTP / DB)", "table", 12, 21, 12, 8, `SELECT
  ServiceName AS service,
  SpanName AS call,
  coalesce(nullIf(SpanAttributes['db.system'], ''), nullIf(SpanAttributes['llm.provider'], ''), 'http') AS kind,
  count() AS calls,
  ${MS("quantile(0.95)(Duration)")} AS p95_ms,
  countIf(StatusCode = 'Error') AS errors
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Client' AND ${SVC}
GROUP BY service, call, kind
ORDER BY calls DESC
LIMIT 30`, drillToTraces({ ServiceName: "service", SpanName: "call" })],

  section("Jobs", 29, "Queue / cron / interval job (span CONSUMER). Bấm dòng → trace của job."),

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
  ServiceName AS service,
  SpanName AS job,
  count() AS runs,
  countIf(StatusCode = 'Error') AS failed,
  ${MS("quantile(0.95)(Duration)")} AS p95_ms,
  max(Timestamp) AS last_run
FROM ${T.traces}
WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Consumer' AND ${SVC}
GROUP BY service, job
ORDER BY runs DESC
LIMIT 50`, drillToTraces({ ServiceName: "service", SpanName: "job" })],

  section("Runtime", 37, "Runtime metrics của Observe (30s/lần), **mỗi instance một đường** — chọn Instance ở trên để xem riêng."),

  ["Heap used (MiB)", "line", 0, 39, 8, 6, runtimeGauge(["process.memory.heap_used"])],
  ["CPU (%)", "line", 8, 39, 8, 6, runtimeGauge(["process.cpu.percent"])],
  ["Event loop lag (ms)", "line", 16, 39, 8, 6, runtimeGauge(["nodejs.eventloop.lag"], "max(Value)")],
  ["Event loop utilization (%)", "line", 0, 45, 8, 6, runtimeGauge(["nodejs.eventloop.utilization"], "round(100 * avg(Value), 2)")],
  ["RSS (MiB)", "line", 8, 45, 8, 6, runtimeGauge(["process.memory.rss"])],
  ["GC duration theo loại (ms)", "stacked_bar", 16, 45, 8, 6, `SELECT
  ${BUCKET("TimeUnix")} AS ts,
  Attributes['gc.type'] AS gc_type,
  sum(Value) AS duration_ms
FROM ${T.gauge}
WHERE $__timeFilter(TimeUnix) AND MetricName = 'nodejs.gc.duration_by_type' AND ${SVC}
GROUP BY ts, gc_type
ORDER BY ts
LIMIT 10000`],

  section("Logs", 51, "Log forward từ Logger của Nest (forwardLogs). Bấm log lỗi → toàn bộ SQL của trace đó (Services › Database)."),

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
  TraceId AS trace_id,${servicesLinkColumns({
    traceId: "TraceId",
    startMs: "toUnixTimestamp64Milli(Timestamp) - 300000",
    endMs: "toUnixTimestamp64Milli(Timestamp) + 300000",
  })}
FROM ${T.logs}
WHERE $__timeFilter_ms(Timestamp) AND SeverityNumber >= 17 AND TraceId != '' AND ${SVC}
ORDER BY Timestamp DESC
LIMIT 50`, servicesLink("database")],

  section("Custom metrics", 59, "Counter / Gauge / Summary do app tự định nghĩa qua TracerService."),

  // Mỗi instance đếm luỹ kế riêng từ 0 → lấy giá trị cuối của từng instance rồi CỘNG lại.
  ["Counters (luỹ kế, cộng mọi instance)", "line", 0, 61, 12, 6, `SELECT ts, series, sum(last_value) AS value
FROM (
  SELECT
    ${BUCKET("TimeUnix")} AS ts,
    ${SERIES} AS series,
    ${INSTANCE} AS instance,
    argMax(Value, TimeUnix) AS last_value
  FROM ${T.sum}
  WHERE $__timeFilter(TimeUnix) AND ${IS_CUSTOM} AND ${SVC}
  GROUP BY ts, series, instance
)
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

// ---------- "Request chậm nhất": chèn ngay dưới Endpoints, đẩy các tile phía dưới xuống ----------
// Mỗi dòng là MỘT request (một trace) kèm số query DB của nó; bấm → Services › Database
// lọc theo TraceId: xem toàn bộ SQL của request đó.
const SLOW_REQUESTS_Y = 19;
const SLOW_REQUESTS_H = 8;
for (const t of tiles) {
  if (Array.isArray(t) ? t[3] >= SLOW_REQUESTS_Y : t.y >= SLOW_REQUESTS_Y) {
    if (Array.isArray(t)) t[3] += SLOW_REQUESTS_H;
    else t.y += SLOW_REQUESTS_H;
  }
}
tiles.push([
  "Request chậm nhất — bấm để xem SQL của request",
  "table",
  0, SLOW_REQUESTS_Y, 24, SLOW_REQUESTS_H,
  `WITH slow AS (
  SELECT Timestamp, ServiceName, SpanName, SpanAttributes['http.status_code'] AS status, Duration, TraceId
  FROM ${T.traces}
  WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Server' AND ${SVC}
  ORDER BY Duration DESC
  LIMIT 50
),
db AS (
  SELECT TraceId, count() AS queries, sum(Duration) AS db_ns
  FROM ${T.traces}
  WHERE $__timeFilter_ms(Timestamp) AND SpanAttributes['db.system'] != ''
    AND TraceId IN (SELECT TraceId FROM slow)
  GROUP BY TraceId
)
SELECT
  slow.Timestamp AS time,
  slow.ServiceName AS service,
  slow.SpanName AS endpoint,
  slow.status AS status,
  ${MS("slow.Duration")} AS duration_ms,
  coalesce(db.queries, 0) AS db_queries,
  ${MS("coalesce(db.db_ns, 0)")} AS db_ms,
  slow.TraceId AS trace_id,${servicesLinkColumns({
    traceId: "slow.TraceId",
    startMs: "toUnixTimestamp64Milli(slow.Timestamp) - 60000",
    endMs: "toUnixTimestamp64Milli(slow.Timestamp) + intDiv(slow.Duration, 1000000) + 60000",
  })}
FROM slow
LEFT JOIN db ON db.TraceId = slow.TraceId
ORDER BY slow.Duration DESC
LIMIT 50`,
  servicesLink("database"),
]);

// ---------- "Instances": đặt trên cùng, đẩy mọi tile khác xuống ----------
// Mỗi process gửi runtime metrics 30s/lần kể cả khi rảnh → dùng làm nhịp tim.
// Instance = service.instance.id do stash gắn (tên container / id stash sidecar);
// role = `/r/<roles>` trên endpoint của app, dự phòng bằng tag `role` của job.
const INSTANCES_H = 13;
for (const t of tiles) {
  if (Array.isArray(t)) t[3] += INSTANCES_H;
  else t.y += INSTANCES_H;
}
const HEARTBEAT = "MetricName = 'process.cpu.percent'";
const ROLE_LIST = (arrExpr) =>
  `arrayStringConcat(arraySort(arrayFilter(r -> r != '', arrayDistinct(${arrExpr}))), ', ')`;
tiles.push(
  section(
    "Instances",
    0,
    `Đang chạy = gửi runtime metrics trong ${ALIVE_SECONDS} giây gần nhất (mỗi process gửi 30s/lần, kể cả khi rảnh). Không phụ thuộc khung thời gian đang chọn.`,
  ),
  [`Đang chạy theo service (${ALIVE_SECONDS}s gần nhất)`, "table", 0, 2, 7, 6, `SELECT
  ServiceName AS service,
  uniqExact(${INSTANCE_LABEL}) AS instances,
  ${ROLE_LIST(`arrayFlatten(groupArray(splitByChar(',', ResourceAttributes['observe.roles'])))`)} AS roles
FROM ${T.gauge}
WHERE TimeUnix >= now() - INTERVAL ${ALIVE_SECONDS} SECOND
  AND ${HEARTBEAT} AND ${FROM_OBSERVE} AND ${SVC}
GROUP BY service
ORDER BY service
LIMIT 100`],
  ["Instances (trong khung thời gian đang chọn)", "table", 7, 2, 17, 6, `WITH rt AS (
  SELECT
    ServiceName AS service,
    ${INSTANCE_LABEL} AS instance,
    max(TimeUnix) AS last_seen,
    min(TimeUnix) AS first_seen,
    any(ResourceAttributes['observe.source.ip']) AS ip,
    groupArray(splitByChar(',', ResourceAttributes['observe.roles'])) AS path_roles,
    round(argMaxIf(Value, TimeUnix, MetricName = 'process.memory.heap_used'), 1) AS heap_mib,
    round(argMaxIf(Value, TimeUnix, MetricName = 'process.memory.rss'), 1) AS rss_mib,
    round(argMaxIf(Value, TimeUnix, MetricName = 'process.cpu.percent'), 1) AS cpu_pct,
    round(argMaxIf(Value, TimeUnix, MetricName = 'nodejs.eventloop.lag'), 1) AS loop_lag_ms
  FROM ${T.gauge}
  WHERE $__timeFilter(TimeUnix) AND ${FROM_OBSERVE} AND ${SVC}
  GROUP BY service, instance
),
jobs AS (
  -- dự phòng: role từ tag của job (app chưa gắn /r/<roles> vào endpoint)
  SELECT ServiceName AS service, ${INSTANCE_LABEL} AS instance,
    groupUniqArray(SpanAttributes['role']) AS job_roles
  FROM ${T.traces}
  WHERE $__timeFilter_ms(Timestamp) AND SpanKind = 'Consumer' AND SpanAttributes['role'] != '' AND ${SVC}
  GROUP BY service, instance
)
SELECT
  if(rt.last_seen >= now() - INTERVAL ${ALIVE_SECONDS} SECOND, '🟢 running', '⚪ stopped') AS status,
  rt.service AS service,
  rt.instance AS instance,
  ${ROLE_LIST(`arrayConcat(arrayFlatten(rt.path_roles), arrayFlatten(arrayMap(x -> splitByChar(',', x), jobs.job_roles)))`)} AS roles,
  rt.last_seen AS last_seen,
  rt.first_seen AS first_seen,
  rt.heap_mib AS heap_mib,
  rt.rss_mib AS rss_mib,
  rt.cpu_pct AS cpu_pct,
  rt.loop_lag_ms AS loop_lag_ms,
  rt.ip AS ip
FROM rt
LEFT JOIN jobs ON jobs.service = rt.service AND jobs.instance = rt.instance
ORDER BY status, service, instance
LIMIT 500`],
  ["Số instance theo thời gian", "line", 0, 8, 24, 5, `SELECT
  ${BUCKET("TimeUnix")} AS ts,
  ServiceName AS service,
  uniqExact(${INSTANCE_LABEL}) AS instances
FROM ${T.gauge}
WHERE $__timeFilter(TimeUnix) AND ${HEARTBEAT} AND ${FROM_OBSERVE} AND ${SVC}
GROUP BY ts, service
ORDER BY ts
LIMIT 10000`],
);

// ---------- Build dashboard (định dạng nội bộ của HyperDX) ----------
const randomId = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);

export function buildDashboard({ connectionId, traceSourceId, metricSourceId }) {
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
      const [name, displayType, x, y, w, h, sqlTemplate, onClick] = t;
      return {
        id: randomId(),
        x, y, w, h,
        config: {
          configType: "sql",
          displayType,
          name,
          connection: connectionId,
          sqlTemplate,
          ...(onClick ? { onClick } : {}),
        },
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
      {
        // Lấy từ runtime metrics (mọi instance đều gửi, kể cả khi không có request/job).
        id: randomId(),
        type: "QUERY_EXPRESSION",
        name: "Instance",
        expression: INSTANCE,
        source: metricSourceId,
        sourceMetricType: "gauge",
        where: "",
        whereLanguage: "sql",
        isBroadcastEnabled: false,
        isVariableEnabled: true,
        variableName: "instance",
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
  if (args.print || args.out) {
    // Định dạng template cho trang Dashboards → Import của HyperDX: cần `version`; connection /
    // source là tên tạm — màn hình import cho chọn connection / source thật để thay vào.
    const template = {
      version: "1.0.0",
      description: "NestJS Observe (telemetry-stash): requests, endpoints, DB/HTTP calls, jobs, runtime, logs, custom metrics",
      ...buildDashboard({
        connectionId: "clickhouse-connection",
        traceSourceId: "traces-source",
        metricSourceId: "metrics-source",
      }),
    };
    const json = JSON.stringify(template, null, 2);
    if (typeof args.out === "string") {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args.out, json + "\n");
      console.log(`📝 Đã ghi ${args.out} — ClickStack: Dashboards → Import → chọn file`);
      console.log(`🔗 Link sang trang Services trỏ tới: ${UI}`);
      if (/localhost|127\.0\.0\.1/.test(UI)) {
        console.warn("⚠️  Đang trỏ localhost — import lên server thì tạo lại với --ui=https://<domain ClickStack>");
      }
    } else {
      console.log(json);
    }
    return;
  }
  const sources = await api("GET", "/sources");
  const traceSource = sources.find((s) => s.kind === "trace");
  if (!traceSource) throw new Error("Không tìm thấy source kiểu trace trong HyperDX");
  const metricSource = sources.find((s) => s.kind === "metric");
  if (!metricSource) throw new Error("Không tìm thấy source kiểu metric trong HyperDX");
  const connectionId = traceSource.connection;
  const dashboard = buildDashboard({
    connectionId,
    traceSourceId: traceSource._id || traceSource.id,
    metricSourceId: metricSource._id || metricSource.id,
  });

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
