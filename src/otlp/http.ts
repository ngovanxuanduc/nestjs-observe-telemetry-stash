/** POST một payload OTLP/JSON. Ném lỗi khi status không 2xx hoặc quá timeout. */
export async function postOtlp(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  // Đọc hết body để giải phóng socket keep-alive
  await res.arrayBuffer().catch(() => undefined);
}

/** `http://host:4318` → `{ traces, logs, metrics }` theo đường dẫn chuẩn OTLP/HTTP. */
export function otlpUrls(base: string) {
  const b = base.replace(/\/+$/, "");
  return { traces: `${b}/v1/traces`, logs: `${b}/v1/logs`, metrics: `${b}/v1/metrics` };
}
