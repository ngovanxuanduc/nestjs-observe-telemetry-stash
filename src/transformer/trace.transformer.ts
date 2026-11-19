import {
  OtlpAttribute,
  msToNs,
  parseTimeMs,
  pushAttr,
  pushAttrs,
  syntheticSpanId,
  toSpanId,
  toTraceId,
} from "./otlp.util.js";

// OTLP SpanKind / StatusCode
const KIND_INTERNAL = 1;
const KIND_SERVER = 2;
const KIND_CLIENT = 3;
const KIND_CONSUMER = 5;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

/** Tag của các span gọi ra ngoài mà Observe tự ghi (fetch/http, pg/mysql/mongo, LLM). */
const CLIENT_TAG_PREFIXES = ["http.", "url.", "db.", "llm.", "rpc.", "messaging."];

function formatCodeFrames(frames: any[]): string {
  if (!Array.isArray(frames) || frames.length === 0) return "";
  return frames
    .map((f) => {
      if (!f) return "";
      const filePath =
        f.file || f.filePath || f.filename || f.fileName || f.path || "unknown";
      const lineNum = f.line ?? f.lineNumber ?? f.lineNo ?? f.ln ?? "?";
      const colNum = f.column ?? f.columnNumber ?? f.col;

      let linesText = "";
      if (Array.isArray(f.lines)) {
        const first = typeof f.firstLine === "number" ? f.firstLine : undefined;
        linesText = f.lines
          .map((l: any, i: number) => {
            if (typeof l === "string") {
              const no = first !== undefined ? first + i : undefined;
              const isError = no !== undefined && no === lineNum;
              return `${isError ? "❌ " : "   "}${String(no ?? "").padStart(4, " ")} | ${l}`;
            }
            const isError =
              l.isErrorLine || l.isError || l.highlight || l.active || l.error;
            const line = l.line ?? l.lineNumber ?? l.lineNo ?? l.ln ?? "";
            const content = l.content ?? l.text ?? l.code ?? l.lineContent ?? "";
            return `${isError ? "❌ " : "   "}${String(line).padStart(4, " ")} | ${content}`;
          })
          .join("\n");
      } else if (typeof f.lines === "string") {
        linesText = f.lines;
      }

      if (filePath === "unknown" && !linesText) return "";
      const loc = colNum !== undefined ? `${lineNum}:${colNum}` : `${lineNum}`;
      return `\n---------------- [ SOURCE CODE FRAME ] ----------------\n📁 ${filePath}:${loc}\n${linesText}`;
    })
    .filter(Boolean)
    .join("\n");
}

function exceptionEvent(err: any, timeNs: bigint) {
  const attributes: OtlpAttribute[] = [];
  pushAttr(attributes, "exception.type", err?.cls || err?.name || "Error");
  pushAttr(attributes, "exception.message", err?.message || "Error");
  const stack = (err?.stack || "") + formatCodeFrames(err?.codeFrames || []);
  pushAttr(attributes, "exception.stacktrace", stack);
  return { timeUnixNano: timeNs.toString(), name: "exception", attributes };
}

const errorMessage = (err: any) =>
  typeof err === "object" && err !== null
    ? err.message || "Error"
    : String(err || "Error");

function splitUrl(url?: string): { path?: string; query?: string } {
  if (!url) return {};
  const i = url.indexOf("?");
  return i === -1 ? { path: url } : { path: url.slice(0, i), query: url.slice(i + 1) };
}

interface FlattenCtx {
  traceId: string;
  baseNs: bigint;
  snapshotError: any;
  spans: any[];
  seed: string;
}

/** Biến cây node (`t`) của Observe thành span con của `parentSpanId`. */
function flattenNodes(nodes: any[], parentSpanId: string, ctx: FlattenCtx, path: string) {
  if (!Array.isArray(nodes)) return;

  nodes.forEach((node, i) => {
    if (!node) return;
    const nodePath = `${path}.${i}`;
    const spanId = node.s ? toSpanId(node.s) : syntheticSpanId(`${ctx.seed}${nodePath}`);
    const startNs = ctx.baseNs + msToNs(Number(node.so) || 0);
    const endNs = startNs + msToNs(Number(node.d) || 0);

    const tags = node.t && typeof node.t === "object" ? node.t : undefined;
    const isClient =
      !!tags && Object.keys(tags).some((k) => CLIENT_TAG_PREFIXES.some((p) => k.startsWith(p)));

    const attributes: OtlpAttribute[] = [];
    pushAttr(attributes, "code.namespace", node.c);
    pushAttr(attributes, "code.function", node.m);
    pushAttr(attributes, "observe.origin", node.o);
    pushAttrs(attributes, tags);

    const events: any[] = [];
    let status: { code: number; message?: string } = { code: STATUS_UNSET };
    const err =
      typeof node.e === "object" && node.e !== null
        ? node.e
        : node.e
          ? ctx.snapshotError || true
          : null;
    if (err) {
      status = { code: STATUS_ERROR, message: errorMessage(err) };
      if (typeof err === "object") events.push(exceptionEvent(err, endNs));
    }

    ctx.spans.push({
      traceId: ctx.traceId,
      spanId,
      parentSpanId,
      name: node.n || (isClient ? node.m : `${node.c}.${node.m}`),
      kind: isClient ? KIND_CLIENT : KIND_INTERNAL,
      startTimeUnixNano: startNs.toString(),
      endTimeUnixNano: endNs.toString(),
      attributes,
      events,
      status,
    });

    if (Array.isArray(node.ch) && node.ch.length > 0) {
      flattenNodes(node.ch, spanId, ctx, nodePath);
    }
  });
}

/**
 * Một request snapshot (HTTP/RPC/GraphQL/WS) → span gốc SERVER tổng hợp + các span con.
 * Observe gửi `t` là danh sách span ngang hàng (Guard, Controller...) không có gốc,
 * nên gốc được dựng từ thông tin của snapshot.
 */
export function buildRequestSpans(snapshot: any, fallbackTimeMs: number): any[] {
  const traceId = toTraceId(snapshot.ti);
  if (!traceId) return [];

  const startMs = parseTimeMs(snapshot.ct) ?? parseTimeMs(snapshot.c) ?? fallbackTimeMs;
  const baseNs = msToNs(startMs);
  const durationMs = Number(snapshot.d) || 0;
  const endNs = baseNs + msToNs(durationMs);
  const a = snapshot.a || {};
  // Nhiều snapshot có thể chung traceId (request A gọi request B, Observe chuyển trace id qua
  // x-request-id) → seed thêm thời điểm + URL + span con đầu tiên để root không trùng.
  const seed = `req:${snapshot.ti}|${snapshot.ct ?? ""}|${a.m ?? ""}|${a.ou ?? ""}|${snapshot.t?.[0]?.s ?? ""}`;
  const rootId = syntheticSpanId(seed);

  const protocol = snapshot.p || "http";
  const method = a.m;
  const { path, query } = splitUrl(a.ou);
  const route = snapshot.op || path;
  const statusCode = a.sc !== undefined ? Number(a.sc) : undefined;

  const name =
    protocol === "http"
      ? `${method || "HTTP"} ${route || "/"}`
      : `${protocol} ${route || method || "operation"}`;

  const attributes: OtlpAttribute[] = [];
  pushAttr(attributes, "observe.protocol", protocol);
  if (protocol === "http") {
    pushAttr(attributes, "http.request.method", method);
    pushAttr(attributes, "http.route", snapshot.op);
    pushAttr(attributes, "url.path", path);
    pushAttr(attributes, "url.query", query);
    pushAttr(attributes, "http.response.status_code", statusCode);
    // Tên cũ (semconv < 1.20) để dashboard cũ vẫn chạy
    pushAttr(attributes, "http.method", method);
    pushAttr(attributes, "http.target", a.ou);
    pushAttr(attributes, "http.status_code", statusCode);
  } else {
    pushAttr(attributes, "observe.operation", snapshot.op);
    pushAttrs(attributes, a, "observe.attr.");
  }
  pushAttr(attributes, "user.id", snapshot.u);
  pushAttrs(attributes, snapshot.tg);
  if (snapshot.rq && typeof snapshot.rq === "object") {
    const { headers, body, ...rest } = snapshot.rq;
    pushAttrs(attributes, headers, "http.request.header.");
    pushAttr(attributes, "http.request.body", body);
    pushAttrs(attributes, rest, "observe.request.");
  }

  const events: any[] = [];
  let status: { code: number; message?: string } = { code: STATUS_UNSET };
  // Semconv: span SERVER chỉ ERROR khi 5xx; 4xx là lỗi phía client → để UNSET
  // (vẫn giữ event exception để xem chi tiết). Không có status code thì theo `e`.
  const isServerError =
    statusCode !== undefined ? statusCode >= 500 : !!snapshot.e;
  if (isServerError) {
    status = {
      code: STATUS_ERROR,
      message: snapshot.e ? errorMessage(snapshot.e) : `HTTP ${statusCode}`,
    };
  }
  if (snapshot.e && typeof snapshot.e === "object") {
    events.push(exceptionEvent(snapshot.e, endNs));
  }

  const spans: any[] = [
    {
      traceId,
      spanId: rootId,
      name,
      kind: KIND_SERVER,
      startTimeUnixNano: baseNs.toString(),
      endTimeUnixNano: endNs.toString(),
      attributes,
      events,
      status,
    },
  ];
  flattenNodes(snapshot.t || [], rootId, {
    traceId,
    baseNs,
    snapshotError: snapshot.e,
    spans,
    seed,
  }, "");
  return spans;
}

/** Một job snapshot (queue/cron/interval) → span gốc CONSUMER tổng hợp + các span con. */
export function buildJobSpans(job: any, fallbackTimeMs: number): any[] {
  const traceId = toTraceId(job.ti);
  if (!traceId) return [];

  const startMs = parseTimeMs(job.c) ?? parseTimeMs(job.ct) ?? fallbackTimeMs;
  const baseNs = msToNs(startMs);
  const endNs = baseNs + msToNs(Number(job.d) || 0);
  // Nhiều job chung traceId (job enqueue từ request / job khác), và mỗi lần retry của cùng
  // một job cũng chung id + traceId → seed thêm queue, tên, số lần thử và thời điểm chạy.
  const seed = `job:${job.ti}|${job.q ?? ""}|${job.n ?? ""}|${job.i ?? ""}|${job.am ?? ""}|${job.c ?? ""}`;
  const rootId = syntheticSpanId(seed);

  const attributes: OtlpAttribute[] = [];
  pushAttr(attributes, "messaging.destination.name", job.q);
  pushAttr(attributes, "messaging.destination", job.q); // tên cũ
  pushAttr(attributes, "job.id", job.i);
  pushAttr(attributes, "job.name", job.n);
  pushAttr(attributes, "job.status", job.s);
  pushAttr(attributes, "job.enqueued_at", job.ea);
  // wd của Observe = chờ SAU khi hết delay/backoff (startedAt - (timestamp + delay)).
  pushAttr(attributes, "job.wait_ms", job.wd);
  // Tổng thời gian từ lúc enqueue tới lúc chạy, gồm cả delay/backoff.
  const enqueuedMs = parseTimeMs(job.ea);
  if (enqueuedMs !== undefined) pushAttr(attributes, "job.queued_ms", Math.max(0, startMs - enqueuedMs));
  pushAttr(attributes, "job.attempts", job.am);
  pushAttr(attributes, "job.max_attempts", job.ma);
  pushAttrs(attributes, job.tg);

  const events: any[] = [];
  let status: { code: number; message?: string } = { code: STATUS_UNSET };
  if (job.e || job.s === "failed") {
    status = { code: STATUS_ERROR, message: errorMessage(job.e || "Job failed") };
    if (typeof job.e === "object" && job.e) events.push(exceptionEvent(job.e, endNs));
  }

  const spans: any[] = [
    {
      traceId,
      spanId: rootId,
      name: `JOB ${job.q || "job"}/${job.n || "unknown"}`,
      kind: KIND_CONSUMER,
      startTimeUnixNano: baseNs.toString(),
      endTimeUnixNano: endNs.toString(),
      attributes,
      events,
      status,
    },
  ];
  flattenNodes(job.t || [], rootId, { traceId, baseNs, snapshotError: job.e, spans, seed }, "");
  return spans;
}
