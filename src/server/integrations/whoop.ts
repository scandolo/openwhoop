// WHOOP official API (developer.whoop.com): companion mode's other half.
// While the official app keeps syncing the strap, this imports WHOOP's own
// recovery, sleep, strain and workouts, so OpenWhoop can show them side by
// side, adopt WHOOP's measured max HR and sleep-need baseline, and fit a
// personal recovery offset on the paired nights.
import { randomBytes } from "node:crypto";
import { all, get, getMeta, run, setMeta, tx, type Db } from "../db.ts";
import { getProfile, setProfile } from "../settings.ts";
import { logit, median } from "../../algorithms/stats.ts";
import { integrationRow, saveIntegration, type Integration, type IntegrationContext } from "./store.ts";

const BASE = "https://api.prod.whoop.com";
const SCOPES = "offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement";

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

async function token(db: Db): Promise<string> {
  const { config, state } = integrationRow(db, "whoop");
  const t = state.tokens as Tokens | undefined;
  if (!t) throw new Error("WHOOP is not connected");
  if (t.expires_at - 60 > Date.now() / 1000) return t.access_token;
  if (!t.refresh_token) throw new Error("WHOOP session expired — connect again");
  const res = await fetch(`${BASE}/oauth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: String(config.clientId), client_secret: String(config.clientSecret), scope: "offline" }),
  });
  if (!res.ok) throw new Error(`WHOOP token refresh failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const fresh: Tokens = { access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Math.floor(Date.now() / 1000) + j.expires_in };
  saveIntegration(db, "whoop", { state: { ...state, tokens: fresh } });
  return fresh.access_token;
}

async function api<T>(db: Db, path: string): Promise<T> {
  const res = await fetch(`${BASE}/developer${path}`, { headers: { authorization: `Bearer ${await token(db)}` } });
  if (!res.ok) throw new Error(`WHOOP ${path.split("?")[0]} → ${res.status}`);
  return (await res.json()) as T;
}

async function pages<T>(db: Db, path: string, start: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined;
  for (let i = 0; i < 80; i++) {
    const q = new URLSearchParams({ limit: "25", start, ...(next ? { nextToken: next } : {}) });
    const r = await api<{ records: T[]; next_token?: string | null }>(db, `${path}?${q}`);
    out.push(...r.records);
    if (!r.next_token) break;
    next = r.next_token;
  }
  return out;
}

const sec = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

interface WCycle { id: number; start: string; end: string | null; score_state: string; score?: { strain: number; kilojoule: number; average_heart_rate: number; max_heart_rate: number } }
interface WRecovery { cycle_id: number; sleep_id: string; score_state: string; score?: { user_calibrating: boolean; recovery_score: number; resting_heart_rate: number; hrv_rmssd_milli: number; spo2_percentage?: number; skin_temp_celsius?: number } }
interface WSleep { id: string; cycle_id: number; start: string; end: string; nap: boolean; score_state: string; score?: { sleep_needed: { baseline_milli: number; need_from_sleep_debt_milli: number; need_from_recent_strain_milli: number; need_from_recent_nap_milli: number }; respiratory_rate: number; sleep_performance_percentage: number; sleep_consistency_percentage: number; sleep_efficiency_percentage: number; stage_summary: Record<string, number> } }
interface WWorkout { id: string; start: string; end: string; sport_name: string; score_state: string; score?: { strain: number; average_heart_rate: number; max_heart_rate: number; kilojoule: number } }

export async function syncWhoop(ctx: IntegrationContext): Promise<string> {
  const { db } = ctx;
  const { state, config } = integrationRow(db, "whoop");
  const since = new Date(((state.lastSync as number) ?? Date.now() / 1000 - 120 * 86400) * 1000 - 3 * 86400_000).toISOString();
  const [cycles, recoveries, sleeps, workouts] = [
    await pages<WCycle>(db, "/v2/cycle", since),
    await pages<WRecovery>(db, "/v2/recovery", since),
    await pages<WSleep>(db, "/v2/activity/sleep", since),
    await pages<WWorkout>(db, "/v2/activity/workout", since),
  ];
  const cycleStart = new Map(cycles.map((c) => [c.id, sec(c.start)!]));
  tx(db, () => {
    const up = db.prepare("INSERT OR REPLACE INTO whoop_reference (kind, id, start, end, data) VALUES (?, ?, ?, ?, ?)");
    for (const c of cycles) up.run("cycle", String(c.id), sec(c.start), sec(c.end), JSON.stringify(c));
    for (const r of recoveries) up.run("recovery", String(r.cycle_id), cycleStart.get(r.cycle_id) ?? null, null, JSON.stringify(r));
    for (const s of sleeps) up.run("sleep", s.id, sec(s.start), sec(s.end), JSON.stringify(s));
    for (const w of workouts) up.run("workout", w.id, sec(w.start), sec(w.end), JSON.stringify(w));
  });

  // adopt WHOOP's measured values unless the user set their own
  const profile = getProfile(db);
  const patch: Parameters<typeof setProfile>[1] = {};
  try {
    const body = await api<{ height_meter: number; weight_kilogram: number; max_heart_rate: number }>(db, "/v2/user/measurement/body");
    if (!profile.maxHrOverride && body.max_heart_rate) patch.maxHrOverride = Math.round(body.max_heart_rate);
    if (body.weight_kilogram) patch.weightKg = Math.round(body.weight_kilogram * 10) / 10;
    if (body.height_meter) patch.heightCm = Math.round(body.height_meter * 100);
  } catch {
    /* body scope may be missing */
  }
  const lastMain = sleeps.filter((s) => !s.nap && s.score).at(-1);
  if (!profile.sleepNeedBaselineMin && lastMain?.score) patch.sleepNeedBaselineMin = Math.round(lastMain.score.sleep_needed.baseline_milli / 60000);
  if (Object.keys(patch).length) setProfile(db, patch);

  saveIntegration(db, "whoop", { state: { ...integrationRow(db, "whoop").state, lastSync: Math.floor(Date.now() / 1000) } });
  const cal = config.personalCalibration === false ? null : fitPersonalOffset(db);
  return `imported ${cycles.length} cycles, ${recoveries.length} recoveries, ${sleeps.length} sleeps, ${workouts.length} workouts${cal ? ` · personal offset ${cal.offset.toFixed(2)} from ${cal.n} nights` : ""}`;
}

// ── pairing & personal calibration ─────────────────────────────────────

export interface WhoopDay {
  recovery: number | null;
  hrv: number | null;
  rhr: number | null;
  strain: number | null;
  sleepPerformance: number | null;
}

/** WHOOP's scores for the cycle that started at our sleep onset (± 3 h). */
export function whoopFor(db: Db, cycleStart: number): WhoopDay | null {
  const c = get<{ id: string; data: string }>(db, "SELECT id, data FROM whoop_reference WHERE kind = 'cycle' AND start BETWEEN ? AND ? ORDER BY ABS(start - ?) LIMIT 1", cycleStart - 3 * 3600, cycleStart + 3 * 3600, cycleStart);
  if (!c) return null;
  const cyc = JSON.parse(c.data) as WCycle;
  const r = get<{ data: string }>(db, "SELECT data FROM whoop_reference WHERE kind = 'recovery' AND id = ?", c.id);
  const rec = r ? (JSON.parse(r.data) as WRecovery) : null;
  const s = get<{ data: string }>(db, "SELECT data FROM whoop_reference WHERE kind = 'sleep' AND start BETWEEN ? AND ? ORDER BY ABS(start - ?) LIMIT 1", cycleStart - 3 * 3600, cycleStart + 3 * 3600, cycleStart);
  const sl = s ? (JSON.parse(s.data) as WSleep) : null;
  const scored = rec?.score_state === "SCORED" && rec.score;
  return {
    recovery: scored ? rec.score!.recovery_score : null,
    hrv: scored ? rec.score!.hrv_rmssd_milli : null,
    rhr: scored ? rec.score!.resting_heart_rate : null,
    strain: cyc.score_state === "SCORED" && cyc.score ? Math.round(cyc.score.strain * 10) / 10 : null,
    sleepPerformance: sl?.score_state === "SCORED" && sl.score ? sl.score.sleep_performance_percentage : null,
  };
}

/** Paired OpenWhoop/WHOOP days, for the agreement report and calibration. */
export function pairedDays(db: Db) {
  return all<{ start: number; date: string; recovery: string | null; strain: string | null; sleep_score: string | null }>(db, "SELECT start, date, recovery, strain, sleep_score FROM cycles ORDER BY start")
    .map((c) => {
      const w = whoopFor(db, c.start);
      if (!w) return null;
      const ours = c.recovery ? (JSON.parse(c.recovery) as { score: number | null; raw?: number | null }) : null;
      return {
        date: c.date,
        ours: { recovery: ours?.score ?? null, rawRecovery: ours?.raw ?? ours?.score ?? null, strain: c.strain ? (JSON.parse(c.strain) as { strain: number }).strain : null, sleepPerformance: c.sleep_score ? (JSON.parse(c.sleep_score) as { performance: number }).performance : null },
        whoop: w,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export const MIN_PAIRED_NIGHTS = 14;

/**
 * The public-data model tracks day-to-day changes well (r ≈ 0.9) but each
 * person sits at their own offset. With enough paired nights we learn that
 * offset on the logit scale (median, robust to odd nights) and apply it.
 */
export function fitPersonalOffset(db: Db): { offset: number; n: number } | null {
  const pairs = pairedDays(db).filter((p) => p.ours.rawRecovery !== null && p.whoop.recovery !== null);
  if (pairs.length < MIN_PAIRED_NIGHTS) return null;
  const clampP = (x: number) => Math.min(0.99, Math.max(0.01, x / 100));
  const offset = median(pairs.slice(-90).map((p) => logit(clampP(p.whoop.recovery!)) - logit(clampP(p.ours.rawRecovery!))));
  const cal = { offset: Math.round(offset * 1000) / 1000, n: pairs.length, at: Math.floor(Date.now() / 1000) };
  setMeta(db, "recovery_calibration", cal);
  return cal;
}

export const personalOffset = (db: Db) => getMeta<{ offset: number } | null>(db, "recovery_calibration", null)?.offset ?? 0;

export function agreement(db: Db) {
  const pairs = pairedDays(db);
  const metric = (pick: (p: (typeof pairs)[number]) => [number | null, number | null]) => {
    const xs = pairs.map(pick).filter((x): x is [number, number] => x[0] !== null && x[1] !== null);
    if (xs.length < 3) return { n: xs.length, mae: null, r: null };
    const mae = xs.reduce((a, [o, w]) => a + Math.abs(o - w), 0) / xs.length;
    const mo = xs.reduce((a, [o]) => a + o, 0) / xs.length, mw = xs.reduce((a, [, w]) => a + w, 0) / xs.length;
    let sow = 0, soo = 0, sww = 0;
    for (const [o, w] of xs) {
      sow += (o - mo) * (w - mw);
      soo += (o - mo) ** 2;
      sww += (w - mw) ** 2;
    }
    return { n: xs.length, mae: Math.round(mae * 10) / 10, r: soo && sww ? Math.round((sow / Math.sqrt(soo * sww)) * 100) / 100 : null };
  };
  return {
    recovery: metric((p) => [p.ours.recovery, p.whoop.recovery]),
    strain: metric((p) => [p.ours.strain, p.whoop.strain]),
    sleepPerformance: metric((p) => [p.ours.sleepPerformance, p.whoop.sleepPerformance]),
    calibration: getMeta(db, "recovery_calibration", null),
  };
}

export const whoop: Integration = {
  id: "whoop",
  name: "WHOOP (official API)",
  description: "Companion mode: import WHOOP's own scores to compare with OpenWhoop and calibrate it to you.",
  fields: [
    { key: "clientId", label: "Client ID", help: "From developer-dashboard.whoop.com" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "personalCalibration", label: "Calibrate recovery to my WHOOP scores", type: "boolean" },
  ],
  status(ctx) {
    const { state } = integrationRow(ctx.db, "whoop");
    return { connected: !!state.tokens };
  },
  routes(app, ctx) {
    app.get("/api/integrations/whoop/connect", (c) => {
      const { config, state } = integrationRow(ctx.db, "whoop");
      if (!config.clientId) return c.text("Add your WHOOP client ID first", 400);
      const nonce = randomBytes(12).toString("hex");
      saveIntegration(ctx.db, "whoop", { state: { ...state, nonce } });
      const url = new URL(`${BASE}/oauth/oauth2/auth`);
      url.search = new URLSearchParams({ client_id: String(config.clientId), response_type: "code", redirect_uri: `${ctx.baseUrl(c.req.url)}/api/integrations/whoop/callback`, scope: SCOPES, state: nonce }).toString();
      return c.redirect(url.toString());
    });
    app.get("/api/integrations/whoop/callback", async (c) => {
      const { config, state } = integrationRow(ctx.db, "whoop");
      if (!state.nonce || c.req.query("state") !== state.nonce) return c.text("Invalid OAuth state", 400);
      const code = c.req.query("code");
      if (!code) return c.redirect("/settings?whoop=denied");
      const res = await fetch(`${BASE}/oauth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: String(config.clientId), client_secret: String(config.clientSecret), redirect_uri: `${ctx.baseUrl(c.req.url)}/api/integrations/whoop/callback` }),
      });
      if (!res.ok) return c.redirect("/settings?whoop=error");
      const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
      saveIntegration(ctx.db, "whoop", { enabled: true, config: { personalCalibration: true, ...config }, state: { tokens: { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + j.expires_in } } });
      void syncWhoop(ctx).then(() => rescoreHook?.()).catch((e) => saveIntegration(ctx.db, "whoop", { lastError: String(e) }));
      return c.redirect("/settings?whoop=connected");
    });
    app.get("/api/integrations/whoop/agreement", (c) => c.json(agreement(ctx.db)));
  },
  async sync(ctx) {
    const msg = await syncWhoop(ctx);
    rescoreHook?.();
    return msg;
  },
};

/** Set by the server so a new personal offset re-scores existing cycles. */
let rescoreHook: (() => void) | null = null;
export const setWhoopRescore = (fn: () => void) => {
  rescoreHook = fn;
};
