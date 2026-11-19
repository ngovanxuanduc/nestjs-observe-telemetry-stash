import { createHash } from "node:crypto";

const HEX32 = /^[0-9a-f]{32}$/;

const hash = (input: string, len: number) =>
  createHash("sha256").update(input).digest("hex").slice(0, len);

const stripUuid = (id: string) => id.replace(/-/g, "").toLowerCase();

/**
 * Trace ID OTLP (32 hex). UUID của Observe → bỏ dấu gạch.
 * ID không phải UUID (vd `x-request-id` tuỳ ý) → băm ổn định ra 32 hex.
 */
export function toTraceId(id?: string): string {
  if (!id) return "";
  const hex = stripUuid(id);
  return HEX32.test(hex) ? hex : hash(`trace:${id}`, 32);
}

/**
 * Span ID OTLP (16 hex). Lấy 16 hex CUỐI của UUID: với UUIDv7 (Observe dùng),
 * 16 hex đầu chủ yếu là timestamp nên các span cùng mili giây dễ trùng nhau;
 * 16 hex cuối là phần ngẫu nhiên.
 */
export function toSpanId(id?: string): string {
  if (!id) return "";
  const hex = stripUuid(id);
  return HEX32.test(hex) ? hex.slice(16) : hash(`span:${id}`, 16);
}

/** Span ID cho span gốc tổng hợp của một snapshot (không trùng span con). */
export function syntheticSpanId(seed: string): string {
  return hash(`root:${seed}`, 16);
}

export const msToNs = (ms: number): bigint => BigInt(Math.round(ms * 1e6));

export function parseTimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

export interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}

export function toAnyValue(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  }
  if (typeof v === "bigint") return { intValue: v.toString() };
  return { stringValue: JSON.stringify(v) };
}

/** Thêm attribute nếu giá trị có nghĩa (bỏ undefined/null/""). */
export function pushAttr(attrs: OtlpAttribute[], key: string, v: unknown) {
  if (v === "") return;
  const value = toAnyValue(v);
  if (value) attrs.push({ key, value });
}

/** Trải một object phẳng thành attributes, có thể thêm tiền tố. */
export function pushAttrs(
  attrs: OtlpAttribute[],
  obj: unknown,
  prefix = "",
) {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    pushAttr(attrs, prefix + k, v);
  }
}

/**
 * Thời điểm của cả batch: `_receivedAt` do stash chèn lúc nhận; file cũ không có
 * thì lấy mốc muộn nhất có trong payload; cuối cùng mới dùng giờ hiện tại.
 */
export function payloadTimeMs(payload: any): number {
  const received = parseTimeMs(payload?._receivedAt);
  if (received !== undefined) return received;

  let latest = -Infinity;
  const consider = (v: unknown) => {
    const t = parseTimeMs(v);
    if (t !== undefined && t > latest) latest = t;
  };
  for (const l of payload?.logs || []) consider(l.timestamp);
  for (const s of payload?.snapshots || []) consider(s.ct);
  for (const j of payload?.jobs || []) consider(j.c);
  for (const c of payload?.custom || []) consider(c.lu);
  return Number.isFinite(latest) ? latest : Date.now();
}
