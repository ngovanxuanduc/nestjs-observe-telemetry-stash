import { promises as dns } from "node:dns";
import type { IncomingMessage } from "node:http";

/**
 * Ai đã gửi payload này. Payload của @nestjs/observe không mang thông tin instance, nên stash
 * tự suy ra từ request:
 *  - `instance`: `/i/<tên>` trong đường dẫn (nếu app tự đặt) → tên container tra ngược từ IP
 *    (DNS nội bộ Docker) → IP → gửi qua loopback (sidecar / in-process) thì là id của stash.
 *  - `roles`: `/r/<role1,role2>` trong đường dẫn — app gắn vào endpoint của Observe.
 */
export interface PayloadSource {
  instance: string;
  roles?: string;
  ip?: string;
}

const DNS_TTL_MS = 10 * 60 * 1000;
const DNS_NEGATIVE_TTL_MS = 60 * 1000;
const DNS_TIMEOUT_MS = 500;
const MAX_LABEL = 200;
const dnsCache = new Map<string, { name: string | null; at: number }>();

const clean = (s: string) => s.replace(/[^\w.,:@+-]/g, "_").slice(0, MAX_LABEL);

/** `/r/email,push/i/worker-a/applications/telemetry` → { roles, instance } */
export function parsePathLabels(url?: string): { roles?: string; instance?: string } {
  const out: { roles?: string; instance?: string } = {};
  const parts = (url || "").split("?")[0].split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    let value = parts[i + 1];
    try {
      value = decodeURIComponent(value);
    } catch {
      /* giữ nguyên */
    }
    if (parts[i] === "r" && !out.roles) out.roles = clean(value);
    if (parts[i] === "i" && !out.instance) out.instance = clean(value);
  }
  return out;
}

export function normalizeIp(ip?: string): string | undefined {
  if (!ip) return undefined;
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

const isLoopback = (ip: string) => ip === "::1" || ip.startsWith("127.");

/** Tên container qua DNS nội bộ Docker (`<container>.<network>` → `<container>`); có cache. */
async function reverseName(ip: string): Promise<string | null> {
  const hit = dnsCache.get(ip);
  const ttl = hit?.name ? DNS_TTL_MS : DNS_NEGATIVE_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.name;

  let name: string | null = null;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error("timeout")), DNS_TIMEOUT_MS).unref()),
    ]);
    const first = names.find(Boolean);
    if (first) {
      const labels = first.split(".");
      // Bỏ hậu tố network của Docker; tên không có dấu chấm thì giữ nguyên.
      name = clean(labels.length > 1 ? labels.slice(0, -1).join(".") : first);
    }
  } catch {
    name = null;
  }
  dnsCache.set(ip, { name, at: Date.now() });
  return name;
}

export async function resolveSource(req: IncomingMessage, stashInstanceId: string): Promise<PayloadSource> {
  const labels = parsePathLabels(req.url);
  const ip = normalizeIp(req.socket.remoteAddress);
  let instance = labels.instance;
  if (!instance) {
    if (!ip || isLoopback(ip)) instance = stashInstanceId; // sidecar / in-process: stash ↔ app 1-1
    else instance = (await reverseName(ip)) || ip;
  }
  return { instance, ...(labels.roles ? { roles: labels.roles } : {}), ...(ip ? { ip } : {}) };
}
