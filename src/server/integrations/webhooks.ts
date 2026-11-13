// Outgoing webhooks: POST every subscribed event as JSON, signed with
// HMAC-SHA256 so receivers can verify it came from this instance.
//   X-OpenWhoop-Event: recovery.scored
//   X-OpenWhoop-Timestamp: 1763030400
//   X-OpenWhoop-Signature: sha256=<hex hmac of "<timestamp>.<body>">
import { createHmac, randomBytes } from "node:crypto";
import { all, get, now, run, type Db } from "../db.ts";
import type { AppEvent } from "../events.ts";

export interface Webhook {
  id: number;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  last_status: number | null;
  last_error: string | null;
  last_delivery_at: number | null;
}

type Row = Omit<Webhook, "events" | "enabled"> & { events: string; enabled: number };
const parse = (r: Row): Webhook => ({ ...r, events: JSON.parse(r.events), enabled: !!r.enabled });

export const listWebhooks = (db: Db) => all<Row>(db, "SELECT * FROM webhooks ORDER BY id").map(parse);

export function createWebhook(db: Db, url: string, events: string[]) {
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const r = run(db, "INSERT INTO webhooks (url, secret, events, enabled, created_at) VALUES (?, ?, ?, 1, ?)", url, secret, JSON.stringify(events), now());
  return parse(get<Row>(db, "SELECT * FROM webhooks WHERE id = ?", Number(r.lastInsertRowid))!);
}

export function sign(secret: string, ts: number, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

export async function deliver(db: Db, hook: Webhook, e: AppEvent, attempt = 1): Promise<number | null> {
  const body = JSON.stringify({ type: e.type, ts: e.ts, data: e.data });
  const ts = now();
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "OpenWhoop-Webhook/1", "x-openwhoop-event": e.type, "x-openwhoop-timestamp": String(ts), "x-openwhoop-signature": sign(hook.secret, ts, body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  run(db, "UPDATE webhooks SET last_status = ?, last_error = ?, last_delivery_at = ? WHERE id = ?", status, error, now(), hook.id);
  if (error && attempt < 3) setTimeout(() => void deliver(db, hook, e, attempt + 1), 5000 * 5 ** (attempt - 1));
  return status;
}

export function webhookListener(db: Db) {
  return async (e: AppEvent) => {
    for (const h of listWebhooks(db)) {
      if (h.enabled && (h.events.includes("*") || h.events.includes(e.type))) await deliver(db, h, e);
    }
  };
}
