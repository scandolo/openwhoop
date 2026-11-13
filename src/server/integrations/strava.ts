// Strava: bring your own Strava API application (strava.com/settings/api,
// "Authorization Callback Domain" = this instance's host).
//   - Import: activities become workouts, scored with OpenWhoop strain from
//     your strap data, replacing the anonymous auto-detected ones.
//   - Write-back (optional): appends strain, average HR and recovery to the
//     Strava activity description, like WHOOP's own Strava sharing.
import { randomBytes } from "node:crypto";
import { get, run, type Db } from "../db.ts";
import { scoreWorkout } from "../pipeline.ts";
import type { Integration, IntegrationContext } from "./index.ts";
import { integrationRow, saveIntegration } from "./index.ts";

const API = "https://www.strava.com/api/v3";
const MARK = "— OpenWhoop";

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { firstname?: string; lastname?: string; id?: number };
}

async function token(db: Db): Promise<string> {
  const { config, state } = integrationRow(db, "strava");
  const t = state.tokens as Tokens | undefined;
  if (!t) throw new Error("Strava is not connected");
  if (t.expires_at - 60 > Date.now() / 1000) return t.access_token;
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed (${res.status})`);
  const fresh = (await res.json()) as Tokens;
  saveIntegration(db, "strava", { state: { ...state, tokens: { ...t, ...fresh } } });
  return fresh.access_token;
}

async function api<T>(db: Db, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, { ...init, headers: { ...init.headers, authorization: `Bearer ${await token(db)}` } });
  if (!res.ok) throw new Error(`Strava ${path} → ${res.status}`);
  return (await res.json()) as T;
}

interface Activity {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  elapsed_time: number;
  description?: string | null;
}

export async function syncStrava(ctx: IntegrationContext): Promise<string> {
  const { db } = ctx;
  const { config, state } = integrationRow(db, "strava");
  const after = Math.floor(((state.lastActivityStart as number) ?? Date.now() / 1000 - 30 * 86400) - 2 * 86400);
  const acts = await api<Activity[]>(db, `/athlete/activities?after=${after}&per_page=100`);
  let imported = 0, annotated = 0, latest = (state.lastActivityStart as number) ?? 0;
  for (const a of acts) {
    const start = Math.floor(Date.parse(a.start_date) / 1000);
    const end = start + a.elapsed_time;
    latest = Math.max(latest, start);
    const covered = get<{ n: number }>(db, "SELECT COUNT(*) n FROM samples WHERE ts >= ? AND ts < ? AND hr > 0", start, end)!.n;
    const s = covered > 60 ? scoreWorkout(db, start, end) : null;
    run(db, "DELETE FROM workouts WHERE source = 'detected' AND start < ? AND end > ?", end, start);
    run(
      db,
      `INSERT INTO workouts (start, end, sport, name, source, external_id, strain, avg_hr, max_hr, kcal, zones, meta)
       VALUES (?, ?, ?, ?, 'strava', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, external_id) DO UPDATE SET start = excluded.start, end = excluded.end, sport = excluded.sport, name = excluded.name,
         strain = excluded.strain, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, kcal = excluded.kcal, zones = excluded.zones`,
      start, end, a.sport_type.toLowerCase(), a.name, String(a.id), s?.strain ?? null, s?.avgHr ?? null, s?.maxHr ?? null, s?.kcal ?? null, s ? JSON.stringify(s.zoneSeconds) : null, JSON.stringify({ url: `https://www.strava.com/activities/${a.id}` }),
    );
    imported++;
    if (config.writeBack && s && s.strain > 0) {
      const detail = await api<Activity>(db, `/activities/${a.id}`);
      if (!(detail.description ?? "").includes(MARK)) {
        const rec = get<{ recovery: string | null }>(db, "SELECT recovery FROM cycles WHERE start <= ? ORDER BY start DESC LIMIT 1", start);
        const recScore = rec?.recovery ? JSON.parse(rec.recovery).score : null;
        const line = `Strain ${s.strain.toFixed(1)} · avg HR ${Math.round(s.avgHr ?? 0)}${recScore !== null ? ` · Recovery ${recScore}%` : ""} ${MARK}`;
        await api(db, `/activities/${a.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: [detail.description, line].filter(Boolean).join("\n\n") }) });
        annotated++;
      }
    }
  }
  saveIntegration(db, "strava", { state: { ...integrationRow(db, "strava").state, lastActivityStart: latest } });
  return `imported ${imported} activities${annotated ? `, annotated ${annotated}` : ""}`;
}

export const strava: Integration = {
  id: "strava",
  name: "Strava",
  description: "Import activities to label your workouts, and optionally add strain to their descriptions.",
  fields: [
    { key: "clientId", label: "Client ID", help: "From strava.com/settings/api" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "writeBack", label: "Add strain to Strava descriptions", type: "boolean" },
  ],
  status(ctx) {
    const { state } = integrationRow(ctx.db, "strava");
    const t = state.tokens as Tokens | undefined;
    return { connected: !!t, account: t?.athlete ? `${t.athlete.firstname ?? ""} ${t.athlete.lastname ?? ""}`.trim() : undefined };
  },
  routes(app, ctx) {
    app.get("/api/integrations/strava/connect", (c) => {
      const { config, state } = integrationRow(ctx.db, "strava");
      if (!config.clientId) return c.text("Add your Strava client ID first", 400);
      const nonce = randomBytes(12).toString("hex");
      saveIntegration(ctx.db, "strava", { state: { ...state, nonce } });
      const scope = config.writeBack ? "read,activity:read_all,activity:write" : "read,activity:read_all";
      const url = new URL("https://www.strava.com/oauth/authorize");
      url.search = new URLSearchParams({ client_id: String(config.clientId), response_type: "code", redirect_uri: `${ctx.baseUrl(c.req.url)}/api/integrations/strava/callback`, approval_prompt: "auto", scope, state: nonce }).toString();
      return c.redirect(url.toString());
    });
    app.get("/api/integrations/strava/callback", async (c) => {
      const { config, state } = integrationRow(ctx.db, "strava");
      if (!state.nonce || c.req.query("state") !== state.nonce) return c.text("Invalid OAuth state", 400);
      const code = c.req.query("code");
      if (!code) return c.redirect("/settings?strava=denied");
      const res = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, grant_type: "authorization_code" }),
      });
      if (!res.ok) return c.redirect("/settings?strava=error");
      const tokens = (await res.json()) as Tokens;
      saveIntegration(ctx.db, "strava", { enabled: true, state: { tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: tokens.expires_at, athlete: tokens.athlete } } });
      void syncStrava(ctx).catch((e) => saveIntegration(ctx.db, "strava", { lastError: String(e) }));
      return c.redirect("/settings?strava=connected");
    });
  },
  async onEvent(ctx, e) {
    if (e.type === "sync.completed" && integrationRow(ctx.db, "strava").enabled) await syncStrava(ctx);
  },
  sync: syncStrava,
};

