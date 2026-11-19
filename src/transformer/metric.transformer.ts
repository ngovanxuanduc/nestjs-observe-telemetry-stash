import { OtlpAttribute, msToNs, pushAttr } from "./otlp.util.js";

const TEMPORALITY_CUMULATIVE = 2;

interface DataPoint {
  attributes: OtlpAttribute[];
  value: number;
}

export function buildGaugeMetric(
  name: string,
  value: number,
  timeNs: string,
  unit?: string,
  attributes: OtlpAttribute[] = [],
) {
  return {
    name,
    ...(unit ? { unit } : {}),
    gauge: {
      dataPoints: [{ timeUnixNano: timeNs, asDouble: Number(value), attributes }],
    },
  };
}

/**
 * Tách giá trị theo series của custom metric Observe:
 *  - `{ default: 3 }`                 → 1 điểm, không attribute
 *  - `{ '{"region":"vn"}': 2 }`       → attribute region=vn (Counter/Gauge có labels)
 *  - `{ vn: 12.5 }`                   → attribute label=vn (Summary: label là tên series)
 *  - `5` (định dạng rất cũ)           → 1 điểm, không attribute
 */
export function seriesOf(values: unknown): DataPoint[] {
  if (typeof values === "number") {
    return Number.isFinite(values) ? [{ attributes: [], value: values }] : [];
  }
  if (!values || typeof values !== "object") return [];

  const points: DataPoint[] = [];
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    points.push({ attributes: labelAttributes(key), value });
  }
  return points;
}

function labelAttributes(key: string): OtlpAttribute[] {
  if (key === "default") return [];
  const attributes: OtlpAttribute[] = [];
  if (key.startsWith("{")) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(key))) pushAttr(attributes, k, v);
      return attributes;
    } catch {
      /* không phải JSON → coi như tên series */
    }
  }
  pushAttr(attributes, "label", key);
  return attributes;
}

/** Custom metric của Observe (`payload.custom`) → các metric OTLP. */
export function buildCustomMetrics(cm: any, fallbackTimeMs: number): any[] {
  const name = cm?.n;
  if (!name) return [];
  const timeNs = msToNs(Number(cm.lu) || fallbackTimeMs).toString();
  const base = { name, ...(cm.d ? { description: cm.d } : {}) };
  const out: any[] = [];

  if (cm.t === "counter") {
    const points = seriesOf(cm.v);
    if (points.length)
      out.push({
        ...base,
        sum: {
          aggregationTemporality: TEMPORALITY_CUMULATIVE,
          isMonotonic: true,
          dataPoints: points.map((p) => ({ timeUnixNano: timeNs, asDouble: p.value, attributes: p.attributes })),
        },
      });
  } else if (cm.t === "gauge") {
    const points = seriesOf(cm.v);
    if (points.length)
      out.push({
        ...base,
        gauge: {
          dataPoints: points.map((p) => ({ timeUnixNano: timeNs, asDouble: p.value, attributes: p.attributes })),
        },
      });
  } else if (cm.t === "summary") {
    // count/sum/quantile của Observe tính theo cửa sổ flush (reset sau mỗi lần gửi).
    const keys = new Set<string>();
    for (const field of ["ct", "sm", "q50", "q95", "q99"]) {
      const v = cm[field];
      if (v && typeof v === "object") Object.keys(v).forEach((k) => keys.add(k));
      else if (typeof v === "number") keys.add("default");
    }
    const pick = (field: string, key: string): number | undefined => {
      const v = cm[field];
      const n = typeof v === "number" ? v : v?.[key];
      return Number.isFinite(Number(n)) && n !== undefined ? Number(n) : undefined;
    };

    const dataPoints = [...keys].map((key) => {
      const quantileValues = (
        [
          [0.5, "q50"],
          [0.95, "q95"],
          [0.99, "q99"],
        ] as const
      )
        .map(([quantile, field]) => ({ quantile, value: pick(field, key) }))
        .filter((q) => q.value !== undefined);
      return {
        timeUnixNano: timeNs,
        count: String(Math.round(pick("ct", key) ?? 0)),
        sum: pick("sm", key) ?? 0,
        quantileValues,
        attributes: labelAttributes(key),
      };
    });
    if (dataPoints.length) out.push({ ...base, summary: { dataPoints } });

    const maxPoints = seriesOf(cm.mx);
    if (maxPoints.length)
      out.push({
        name: `${name}.max`,
        gauge: {
          dataPoints: maxPoints.map((p) => ({ timeUnixNano: timeNs, asDouble: p.value, attributes: p.attributes })),
        },
      });
  }
  return out;
}

/** Runtime metrics của Observe (`payload.runtime`) → gauge OTLP. */
export function buildRuntimeMetrics(runtime: any, timeNs: string): any[] {
  if (!runtime || typeof runtime !== "object") return [];
  const out: any[] = [];
  const add = (name: string, v: unknown, unit?: string, attributes?: OtlpAttribute[]) => {
    if (typeof v === "number" && Number.isFinite(v))
      out.push(buildGaugeMetric(name, v, timeNs, unit, attributes));
  };

  const { c, m, e, g } = runtime;
  add("process.cpu.percent", c?.p, "%");
  add("process.cpu.user", c?.u, "ms");
  add("process.cpu.system", c?.s, "ms");

  add("process.memory.heap_used", m?.hu, "MiB");
  add("process.memory.heap_total", m?.ht, "MiB");
  add("process.memory.rss", m?.r, "MiB");
  add("process.memory.external", m?.e, "MiB");
  add("process.memory.array_buffers", m?.ab, "MiB");
  add("process.memory.percent", m?.p, "%");

  add("nodejs.eventloop.lag", e?.l, "ms");
  add("nodejs.eventloop.utilization", e?.u, "1");

  add("nodejs.gc.count", g?.c);
  add("nodejs.gc.duration", g?.td, "ms");
  const kinds: Record<string, string> = { m: "minor", j: "major", i: "incremental" };
  for (const [k, type] of Object.entries(kinds)) {
    const b = g?.b?.[k];
    const attrs: OtlpAttribute[] = [{ key: "gc.type", value: { stringValue: type } }];
    // 0.3.x: { count, duration }; 0.1.x: số lần
    if (typeof b === "number") add("nodejs.gc.count_by_type", b, undefined, attrs);
    else if (b && typeof b === "object") {
      add("nodejs.gc.count_by_type", b.count, undefined, attrs);
      add("nodejs.gc.duration_by_type", b.duration, "ms", attrs);
    }
  }
  return out;
}
