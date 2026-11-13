// Built-in integrations. Each one is a small module implementing this
// interface; add yours to INTEGRATIONS. Generic needs (Zapier, n8n, Home
// Assistant, your own scripts) are covered by webhooks + API tokens instead.
import type { Hono } from "hono";
import { get, now, run, type Db } from "../db.ts";
import type { AppEvent } from "../events.ts";
import { strava } from "./strava.ts";

export interface IntegrationContext {
  db: Db;
  /** Absolute base URL of this instance, for OAuth redirects. */
  baseUrl: (reqUrl: string) => string;
}

export interface Integration {
  id: string;
  name: string;
  description: string;
  /** Config fields shown in Settings; `secret` ones are write-only. */
  fields: { key: string; label: string; secret?: boolean; type?: "text" | "boolean"; help?: string }[];
  status(ctx: IntegrationContext): { connected: boolean; account?: string; detail?: string };
  /** Extra routes under /api/integrations/<id>/… (OAuth etc.). */
  routes?(app: Hono, ctx: IntegrationContext): void;
  onEvent?(ctx: IntegrationContext, e: AppEvent): Promise<void>;
  /** Called every 30 minutes and on "Sync now". */
  sync?(ctx: IntegrationContext): Promise<string>;
}

export const INTEGRATIONS: Integration[] = [strava];

export interface IntegrationRow {
  id: string;
  enabled: number;
  config: string;
  state: string;
  last_run_at: number | null;
  last_error: string | null;
}

export function integrationRow(db: Db, id: string): { enabled: boolean; config: Record<string, unknown>; state: Record<string, unknown>; lastRunAt: number | null; lastError: string | null } {
  const r = get<IntegrationRow>(db, "SELECT * FROM integrations WHERE id = ?", id);
  return { enabled: !!r?.enabled, config: JSON.parse(r?.config ?? "{}"), state: JSON.parse(r?.state ?? "{}"), lastRunAt: r?.last_run_at ?? null, lastError: r?.last_error ?? null };
}

export function saveIntegration(db: Db, id: string, patch: { enabled?: boolean; config?: Record<string, unknown>; state?: Record<string, unknown>; lastError?: string | null; ran?: boolean }) {
  const cur = integrationRow(db, id);
  run(
    db,
    `INSERT INTO integrations (id, enabled, config, state, last_run_at, last_error) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, state = excluded.state, last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
    id,
    (patch.enabled ?? cur.enabled) ? 1 : 0,
    JSON.stringify(patch.config ?? cur.config),
    JSON.stringify(patch.state ?? cur.state),
    patch.ran ? now() : cur.lastRunAt,
    patch.lastError === undefined ? cur.lastError : patch.lastError,
  );
}

export async function runIntegration(ctx: IntegrationContext, i: Integration): Promise<string> {
  if (!i.sync || !integrationRow(ctx.db, i.id).enabled) return "disabled";
  try {
    const msg = await i.sync(ctx);
    saveIntegration(ctx.db, i.id, { ran: true, lastError: null });
    return msg;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    saveIntegration(ctx.db, i.id, { ran: true, lastError: msg });
    throw e;
  }
}
