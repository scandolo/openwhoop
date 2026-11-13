// HTTP API. Everything the web app uses is also available to API tokens
// (read, or read+write), except auth, tokens and webhook management.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { all, get, now, run, setMeta, type Db } from "./db.ts";
import { authMode, createSession, createToken, destroySession, listTokens, rateLimited, recordFailure, requireAuth, revokeAllSessions, savePassword, verifyPassword, type AuthState, type Principal } from "./auth.ts";
import type { Config } from "./config.ts";
import { emit, EVENT_TYPES } from "./events.ts";
import { ingestFrames } from "./ingest.ts";
import { currentPhysiology, processRange, scoreWorkout, workoutById, type SleepRow } from "./pipeline.ts";
import { AlarmSchema, getAlarm, getHaptics, getProfile, getQuestions, HapticsSchema, JournalQuestionsSchema, localDate, ProfileSchema, sleepNeedBaseline, tzOffsetMin } from "./settings.ts";
import { createWebhook, deliver, listWebhooks } from "./integrations/webhooks.ts";
import { INTEGRATIONS, integrationRow, runIntegration, saveIntegration, type IntegrationContext } from "./integrations/index.ts";
import { strainBand, strainTarget, type StrainResult } from "../algorithms/strain.ts";
import { sleepBand, recommendedBedtime, sleepDebt, sleepNeed } from "../algorithms/sleep-score.ts";
import { journalInsights, type JournalDay } from "../algorithms/insights.ts";
import { nextLocalTime, shouldWake } from "../algorithms/alarm.ts";
import type { SleepMetrics, StageSegment } from "../algorithms/sleep.ts";
import type { CycleScore } from "./pipeline.ts";

type Env = { Variables: { principal: Principal } };

interface CycleDb {
  start: number;
  end: number | null;
  sleep_id: number;
  date: string;
  sleep_score: string | null;
  recovery: string | null;
  strain: string | null;
}

const j = <T>(s: string | null | undefined): T | null => (s ? (JSON.parse(s) as T) : null);

// ── processing scheduler: debounce work while a long sync streams in ──
function scheduler(db: Db) {
  let dirty: [number, number] | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastRun = 0;
  const flush = (emitEvents: boolean) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    const [a, b] = dirty;
    dirty = null;
    lastRun = Date.now();
    processRange(db, a, b, { emit: emitEvents });
  };
  return {
    mark(range: [number, number]) {
      dirty = dirty ? [Math.min(dirty[0], range[0]), Math.max(dirty[1], range[1])] : range;
      if (timer) clearTimeout(timer);
      // process at most once a minute while data streams, or after 10 s of quiet
      timer = setTimeout(() => flush(true), Date.now() - lastRun > 60_000 ? 10_000 : 60_000);
    },
    flush,
  };
}

export function buildApi(db: Db, cfg: Config, auth: AuthState) {
  const app = new Hono<Env>();
  const sched = scheduler(db);
  const secure = (c: Context) => (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https";
  const ip = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const ctx: IntegrationContext = { db, baseUrl: (u) => cfg.publicUrl ?? new URL(u).origin };

  app.get("/api/health", (c) => c.json({ ok: true }));

  // ── auth ───────────────────────────────────────────────────────────
  app.get("/api/auth/state", (c) => {
    const mode = authMode(auth, cfg);
    return c.json({ mode, hasPassword: !!auth.passwordHash, envPassword: !!cfg.password });
  });

  app.post("/api/auth/setup", async (c) => {
    const body = z.object({ password: z.string().min(8).max(200), token: z.string().optional() }).parse(await c.req.json());
    const mode = authMode(auth, cfg);
    if (mode === "locked") return c.json({ error: "already set up" }, 409);
    if (mode === "setup" && body.token !== auth.setupToken) return c.json({ error: "invalid setup token — check the server log" }, 403);
    savePassword(db, auth, body.password);
    createSession(db, c, secure(c));
    return c.json({ ok: true });
  });

  app.post("/api/auth/login", async (c) => {
    if (rateLimited(ip(c))) return c.json({ error: "too many attempts, try again in 15 minutes" }, 429);
    const { password } = z.object({ password: z.string().max(200) }).parse(await c.req.json());
    if (!auth.passwordHash || !verifyPassword(password, auth.passwordHash)) {
      recordFailure(ip(c));
      return c.json({ error: "wrong password" }, 401);
    }
    createSession(db, c, secure(c));
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    destroySession(db, c);
    return c.json({ ok: true });
  });

  // everything below needs auth
  app.use("/api/*", requireAuth(db, auth, cfg));

  app.post("/api/auth/password", async (c) => {
    const { current, next } = z.object({ current: z.string().optional(), next: z.string().min(8).max(200) }).parse(await c.req.json());
    if (cfg.password) return c.json({ error: "password is set by OPENWHOOP_PASSWORD" }, 409);
    if (auth.passwordHash && !verifyPassword(current ?? "", auth.passwordHash)) return c.json({ error: "current password is wrong" }, 401);
    savePassword(db, auth, next);
    revokeAllSessions(db);
    createSession(db, c, secure(c));
    return c.json({ ok: true });
  });

  // ── ingest ─────────────────────────────────────────────────────────
  app.post("/api/ingest", async (c) => {
    const body = z.object({ device: z.string().min(1).max(64), frames: z.array(z.string().max(8000)).max(20000) }).parse(await c.req.json());
    const res = ingestFrames(db, body.device, body.frames.map((f) => Uint8Array.from(Buffer.from(f, "base64"))));
    if (res.range) sched.mark(res.range);
    return c.json(res);
  });

  app.post("/api/sync/complete", async (c) => {
    const body = z.object({ device: z.string().max(64), records: z.number().int().min(0) }).partial().parse(await c.req.json().catch(() => ({})));
    sched.flush(true);
    pruneRaw(db, cfg.rawRetentionDays);
    emit(db, "sync.completed", { device: body.device ?? null, records: body.records ?? null });
    return c.json({ ok: true });
  });

  app.post("/api/device", async (c) => {
    const d = z.object({ id: z.string().min(1).max(64), name: z.string().max(64).optional(), firmware: z.string().max(64).optional(), battery: z.number().min(0).max(100).optional() }).parse(await c.req.json());
    run(db, `INSERT INTO devices (id, name, firmware, battery) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name), firmware = COALESCE(excluded.firmware, firmware), battery = COALESCE(excluded.battery, battery)`, d.id, d.name ?? null, d.firmware ?? null, d.battery ?? null);
    return c.json({ ok: true });
  });

  app.get("/api/device", (c) => c.json(get(db, "SELECT * FROM devices ORDER BY last_sync_at DESC NULLS LAST LIMIT 1") ?? null));

  // ── views ──────────────────────────────────────────────────────────
  app.get("/api/overview", (c) => {
    const tz = getProfile(db).timezone;
    const date = c.req.query("date");
    const cycle = date ? get<CycleDb>(db, "SELECT * FROM cycles WHERE date = ? ORDER BY start DESC LIMIT 1", date) : get<CycleDb>(db, "SELECT * FROM cycles ORDER BY start DESC LIMIT 1");
    const latestDate = get<{ date: string }>(db, "SELECT date FROM cycles ORDER BY start DESC LIMIT 1")?.date ?? null;
    if (!cycle) return c.json({ empty: true, latestDate, device: get(db, "SELECT * FROM devices ORDER BY last_sync_at DESC NULLS LAST LIMIT 1") ?? null });
    const v = cycleView(db, cycle);
    const prev = get<CycleDb>(db, "SELECT date FROM cycles WHERE start < ? ORDER BY start DESC LIMIT 1", cycle.start);
    const next = get<CycleDb>(db, "SELECT date FROM cycles WHERE start > ? ORDER BY start ASC LIMIT 1", cycle.start);
    const isCurrent = cycle.end === null;
    const workouts = all<Record<string, unknown>>(db, "SELECT * FROM workouts WHERE start >= ? AND start < ? ORDER BY start", cycle.start, cycle.end ?? now() + 86400).map((w) => workoutById(db, w.id as number));
    const stress = get<{ avg: number | null; low: number; med: number; high: number }>(db, "SELECT AVG(stress) avg, SUM(stress < 1) low, SUM(stress >= 1 AND stress < 2) med, SUM(stress >= 2) high FROM minutes WHERE ts >= ? AND ts < ? AND state != 'sleep'", cycle.start, cycle.end ?? now() + 86400);
    const lastStress = get<{ stress: number | null; ts: number }>(db, "SELECT stress, ts FROM minutes WHERE ts >= ? AND stress IS NOT NULL ORDER BY ts DESC LIMIT 1", cycle.start);
    const recScore = v.recovery?.score ?? null;
    const journalDate = localDate(tz, cycle.start - 3600); // the day before this cycle's wake-up
    const answered = get<{ n: number }>(db, "SELECT COUNT(*) n FROM journal WHERE date = ?", journalDate)!.n > 0;
    return c.json({
      date: cycle.date,
      prevDate: prev?.date ?? null,
      nextDate: next?.date ?? null,
      latestDate,
      isCurrent,
      ...v,
      strainTarget: strainTarget(recScore),
      workouts,
      stress: { current: isCurrent ? lastStress?.stress ?? null : null, avg: stress?.avg ?? null, minutes: { low: stress?.low ?? 0, medium: stress?.med ?? 0, high: stress?.high ?? 0 } },
      journal: { date: journalDate, answered },
      tonight: isCurrent ? tonightPlan(db) : null,
      baselines: baselines30(db, cycle.start),
      device: get(db, "SELECT * FROM devices ORDER BY last_sync_at DESC NULLS LAST LIMIT 1") ?? null,
    });
  });

  app.get("/api/day", (c) => {
    const date = c.req.query("date");
    const cycle = date ? get<CycleDb>(db, "SELECT * FROM cycles WHERE date = ? ORDER BY start DESC LIMIT 1", date) : get<CycleDb>(db, "SELECT * FROM cycles ORDER BY start DESC LIMIT 1");
    if (!cycle) return c.json({ minutes: [] });
    const end = cycle.end ?? now() + 60;
    const minutes = all<{ ts: number; hr: number | null; stress: number | null; state: string }>(db, "SELECT ts, hr, stress, state FROM minutes WHERE ts >= ? AND ts < ? ORDER BY ts", cycle.start, end);
    const sleep = get<SleepRow>(db, "SELECT * FROM sleeps WHERE id = ?", cycle.sleep_id);
    return c.json({ start: cycle.start, end: cycle.end, minutes, stages: j<StageSegment[]>(sleep?.stages), physiology: currentPhysiology(db, cycle.start) });
  });

  app.get("/api/sleep", (c) => {
    const date = c.req.query("date");
    const cycle = date ? get<CycleDb>(db, "SELECT * FROM cycles WHERE date = ? ORDER BY start DESC LIMIT 1", date) : get<CycleDb>(db, "SELECT * FROM cycles ORDER BY start DESC LIMIT 1");
    if (!cycle) return c.json(null);
    const sleep = get<SleepRow>(db, "SELECT * FROM sleeps WHERE id = ?", cycle.sleep_id)!;
    const hr = all<{ ts: number; hr: number | null; rmssd: number | null }>(db, "SELECT ts, hr, rmssd FROM minutes WHERE ts >= ? AND ts < ? ORDER BY ts", sleep.start, sleep.end);
    const naps = all<SleepRow>(db, "SELECT * FROM sleeps WHERE nap = 1 AND start >= ? AND start < ? ORDER BY start", cycle.start, cycle.end ?? now()).map((n) => ({ start: n.start, end: n.end, metrics: j<SleepMetrics>(n.metrics) }));
    return c.json({ date: cycle.date, ...cycleView(db, cycle), stages: j<StageSegment[]>(sleep.stages), hr, naps });
  });

  app.get("/api/trends", (c) => {
    const days = Math.min(400, Math.max(7, Number(c.req.query("days") ?? 30)));
    const rows = all<CycleDb>(db, "SELECT * FROM cycles ORDER BY start DESC LIMIT ?", days).reverse();
    return c.json(rows.map((r) => {
      const v = cycleView(db, r);
      return {
        date: r.date,
        recovery: v.recovery?.score ?? null,
        hrv: v.recovery?.hrv ?? v.sleep?.metrics.hrv ?? null,
        rhr: v.recovery?.rhr ?? v.sleep?.metrics.rhr ?? null,
        resp: v.sleep?.metrics.respRate ?? null,
        skinTempDev: v.recovery?.deltas?.skinTemp ?? null,
        strain: v.strain?.strain ?? null,
        kcal: v.strain?.kcal ?? null,
        sleepPerformance: v.sleep?.performance ?? null,
        asleepH: v.sleep ? v.sleep.metrics.asleep / 3600 : null,
        needH: v.sleep ? v.sleep.need.total / 60 : null,
        consistency: v.sleep?.consistency ?? null,
        efficiency: v.sleep ? Math.round(v.sleep.metrics.efficiency * 100) : null,
        restorative: v.sleep ? Math.round(v.sleep.metrics.restorative * 100) : null,
      };
    }));
  });

  // ── journal ────────────────────────────────────────────────────────
  app.get("/api/journal", (c) => {
    const date = c.req.query("date") ?? localDate(getProfile(db).timezone, now() - 86400);
    const answers = Object.fromEntries(all<{ question: string; answer: number }>(db, "SELECT question, answer FROM journal WHERE date = ?", date).map((r) => [r.question, !!r.answer]));
    return c.json({ date, questions: getQuestions(db).filter((q) => q.enabled), answers });
  });

  app.put("/api/journal", async (c) => {
    const body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), answers: z.record(z.string(), z.boolean()) }).parse(await c.req.json());
    const st = db.prepare("INSERT INTO journal (date, question, answer) VALUES (?, ?, ?) ON CONFLICT(date, question) DO UPDATE SET answer = excluded.answer");
    for (const [q, a] of Object.entries(body.answers)) st.run(body.date, q, a ? 1 : 0);
    emit(db, "journal.updated", body);
    return c.json({ ok: true });
  });

  app.get("/api/insights", (c) => {
    const answers = all<{ date: string; question: string; answer: number }>(db, "SELECT * FROM journal");
    const byDate = new Map<string, Record<string, boolean>>();
    for (const a of answers) byDate.set(a.date, { ...(byDate.get(a.date) ?? {}), [a.question]: !!a.answer });
    const cycles = all<CycleDb>(db, "SELECT * FROM cycles ORDER BY start");
    const days: JournalDay[] = [];
    for (let i = 1; i < cycles.length; i++) {
      const cyc = cycles[i]!;
      const rec = j<NonNullable<CycleScore["recovery"]>>(cyc.recovery);
      if (!rec || rec.score === null) continue;
      // answers describe the day before this morning's recovery
      const behaviourDate = localDate(getProfile(db).timezone, cyc.start - 3600);
      const ans = byDate.get(behaviourDate);
      if (!ans) continue;
      days.push({ answers: ans, recovery: rec.score, hrv: rec.hrv, rhr: rec.rhr, prevStrain: j<StrainResult>(cycles[i - 1]!.strain)?.strain ?? null });
    }
    const labels = Object.fromEntries(getQuestions(db).map((q) => [q.id, q.label]));
    return c.json({ days: days.length, insights: journalInsights(days).map((i) => ({ ...i, label: labels[i.behaviour] ?? i.behaviour })) });
  });

  // ── workouts ───────────────────────────────────────────────────────
  app.get("/api/workouts", (c) => {
    const limit = Math.min(200, Number(c.req.query("limit") ?? 50));
    return c.json(all<{ id: number }>(db, "SELECT id FROM workouts ORDER BY start DESC LIMIT ?", limit).map((w) => workoutById(db, w.id)));
  });

  app.post("/api/workouts", async (c) => {
    const w = z.object({ start: z.number().int(), end: z.number().int(), sport: z.string().min(1).max(40), name: z.string().max(80).optional(), source: z.enum(["manual", "live"]).default("manual") }).refine((x) => x.end > x.start && x.end - x.start < 86400).parse(await c.req.json());
    const s = scoreWorkout(db, w.start, w.end);
    run(db, "DELETE FROM workouts WHERE source = 'detected' AND start < ? AND end > ?", w.end, w.start);
    const r = run(db, "INSERT INTO workouts (start, end, sport, name, source, strain, avg_hr, max_hr, kcal, zones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", w.start, w.end, w.sport, w.name ?? null, w.source, s.strain, s.avgHr, s.maxHr, s.kcal, JSON.stringify(s.zoneSeconds));
    const workout = workoutById(db, Number(r.lastInsertRowid));
    emit(db, "workout.created", { workout });
    return c.json(workout);
  });

  app.patch("/api/workouts/:id", async (c) => {
    const p = z.object({ sport: z.string().min(1).max(40).optional(), name: z.string().max(80).optional() }).parse(await c.req.json());
    run(db, "UPDATE workouts SET sport = COALESCE(?, sport), name = COALESCE(?, name), source = CASE source WHEN 'detected' THEN 'manual' ELSE source END WHERE id = ?", p.sport ?? null, p.name ?? null, Number(c.req.param("id")));
    return c.json(workoutById(db, Number(c.req.param("id"))));
  });

  app.delete("/api/workouts/:id", (c) => {
    run(db, "DELETE FROM workouts WHERE id = ?", Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  // ── settings ───────────────────────────────────────────────────────
  app.get("/api/settings", (c) => c.json({ profile: getProfile(db), alarm: getAlarm(db), haptics: getHaptics(db), questions: getQuestions(db), physiology: currentPhysiology(db) }));

  app.put("/api/settings/:section", async (c) => {
    const body = await c.req.json();
    const section = c.req.param("section");
    if (section === "profile") {
      const before = getProfile(db);
      const p = ProfileSchema.parse({ ...before, ...body });
      setMeta(db, "profile", p);
      if (p.timezone !== before.timezone || p.sleepNeedBaselineMin !== before.sleepNeedBaselineMin || p.maxHrOverride !== before.maxHrOverride || p.birthYear !== before.birthYear) {
        const lo = get<{ lo: number }>(db, "SELECT MIN(ts) lo FROM samples")?.lo;
        if (lo) processRange(db, lo, now());
      }
    } else if (section === "alarm") setMeta(db, "alarm", AlarmSchema.parse({ ...getAlarm(db), ...body }));
    else if (section === "haptics") setMeta(db, "haptics", HapticsSchema.parse({ ...getHaptics(db), ...body }));
    else if (section === "questions") setMeta(db, "journal_questions", JournalQuestionsSchema.parse(body));
    else return c.json({ error: "unknown section" }, 404);
    return c.json({ ok: true });
  });

  // ── alarm ──────────────────────────────────────────────────────────
  app.get("/api/alarm/plan", (c) => {
    const a = getAlarm(db);
    const tz = getProfile(db).timezone;
    const latest = nextLocalTime(a.latestWake, now(), tzOffsetMin(tz, now()));
    return c.json({ ...a, latestWakeAt: latest, windowStartAt: a.mode === "exact" ? latest : latest - a.windowMin * 60 });
  });

  app.get("/api/alarm/decision", (c) => {
    const a = getAlarm(db);
    const tz = getProfile(db).timezone;
    const latestWake = Number(c.req.query("latestWakeAt")) || nextLocalTime(a.latestWake, now(), tzOffsetMin(tz, now()));
    // the sleep in progress is the most recent (possibly partial) main sleep
    const s = get<SleepRow>(db, "SELECT * FROM sleeps ORDER BY start DESC LIMIT 1");
    const dataEnd = get<{ hi: number }>(db, "SELECT MAX(ts) hi FROM samples")?.hi ?? 0;
    const inProgress = s && dataEnd - s.end < 20 * 60 && now() - dataEnd < 30 * 60;
    const m = inProgress ? j<SleepMetrics>(s.metrics)! : null;
    const stages = inProgress ? j<StageSegment[]>(s.stages)! : [];
    const plan = tonightPlan(db);
    const decision = shouldWake(a, {
      now: now(),
      latestWake,
      asleepMin: m ? m.asleep / 60 : 0,
      needMin: plan.needMin,
      stage: stages.at(-1)?.stage ?? null,
      provisionalRecovery: j<{ score: number | null }>(get<{ r: string | null }>(db, "SELECT recovery r FROM cycles WHERE sleep_id = ?", s?.id ?? -1)?.r)?.score ?? null,
    });
    return c.json({ ...decision, sleeping: !!inProgress, dataAgeSec: now() - dataEnd });
  });

  app.post("/api/alarm/fired", async (c) => {
    const body = z.object({ reason: z.string().max(200) }).parse(await c.req.json());
    emit(db, "alarm.fired", body);
    return c.json({ ok: true });
  });

  // ── haptic sessions & live events logged by the browser ─────────────
  app.post("/api/log", async (c) => {
    const body = z.object({ type: z.enum(["breathe.session", "stress.nudge", "strain.target", "bedtime.nudge", "double_tap"]), data: z.record(z.string(), z.unknown()).default({}) }).parse(await c.req.json());
    run(db, "INSERT INTO events (ts, type, data) VALUES (?, ?, ?)", now(), body.type, JSON.stringify(body.data));
    return c.json({ ok: true });
  });

  app.get("/api/events", (c) => {
    const limit = Math.min(500, Number(c.req.query("limit") ?? 100));
    return c.json(all<{ id: number; ts: number; type: string; data: string | null }>(db, "SELECT * FROM events ORDER BY id DESC LIMIT ?", limit).map((e) => ({ ...e, data: j(e.data) })));
  });

  // ── tokens, webhooks, integrations ─────────────────────────────────
  app.get("/api/tokens", (c) => c.json(listTokens(db)));
  app.post("/api/tokens", async (c) => {
    const b = z.object({ name: z.string().min(1).max(60), scope: z.enum(["read", "write"]).default("read") }).parse(await c.req.json());
    return c.json({ token: createToken(db, b.name, b.scope) });
  });
  app.delete("/api/tokens/:id", (c) => {
    run(db, "DELETE FROM api_tokens WHERE id = ?", Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.get("/api/webhooks", (c) => c.json({ events: EVENT_TYPES, webhooks: listWebhooks(db) }));
  app.post("/api/webhooks", async (c) => {
    const b = z.object({ url: z.string().url().max(500), events: z.array(z.string()).min(1) }).parse(await c.req.json());
    return c.json(createWebhook(db, b.url, b.events));
  });
  app.delete("/api/webhooks/:id", (c) => {
    run(db, "DELETE FROM webhooks WHERE id = ?", Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/api/webhooks/:id/test", async (c) => {
    const h = listWebhooks(db).find((w) => w.id === Number(c.req.param("id")));
    if (!h) return c.json({ error: "not found" }, 404);
    const status = await deliver(db, h, { type: "sync.completed", ts: now(), data: { test: true } }, 3);
    return c.json({ status });
  });

  app.get("/api/integrations", (c) =>
    c.json(INTEGRATIONS.map((i) => {
      const row = integrationRow(db, i.id);
      const config = Object.fromEntries(i.fields.map((f) => [f.key, f.secret ? (row.config[f.key] ? "••••••" : "") : row.config[f.key] ?? (f.type === "boolean" ? false : "")]));
      return { id: i.id, name: i.name, description: i.description, fields: i.fields, enabled: row.enabled, config, ...i.status(ctx), lastRunAt: row.lastRunAt, lastError: row.lastError };
    })),
  );
  app.put("/api/integrations/:id/config", async (c) => {
    const i = INTEGRATIONS.find((x) => x.id === c.req.param("id"));
    if (!i) return c.json({ error: "not found" }, 404);
    const body = z.object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.union([z.string().max(500), z.boolean()])).optional() }).parse(await c.req.json());
    const row = integrationRow(db, i.id);
    const config = { ...row.config };
    for (const f of i.fields) {
      const v = body.config?.[f.key];
      if (v === undefined || (f.secret && v === "••••••")) continue;
      config[f.key] = v;
    }
    saveIntegration(db, i.id, { enabled: body.enabled, config });
    return c.json({ ok: true });
  });
  app.post("/api/integrations/:id/sync", async (c) => {
    const i = INTEGRATIONS.find((x) => x.id === c.req.param("id"));
    if (!i) return c.json({ error: "not found" }, 404);
    try {
      return c.json({ message: await runIntegration(ctx, i) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });
  app.delete("/api/integrations/:id/config", (c) => {
    saveIntegration(db, c.req.param("id"), { enabled: false, state: {}, lastError: null });
    return c.json({ ok: true });
  });
  for (const i of INTEGRATIONS) i.routes?.(app as unknown as Hono, ctx);

  // ── export ─────────────────────────────────────────────────────────
  app.get("/api/export/cycles.csv", (c) => {
    const tz = getProfile(db).timezone;
    const fmt = (t: number | null) => {
      if (t === null) return "";
      const off = tzOffsetMin(tz, t);
      return new Date((t + off * 60) * 1000).toISOString().replace("T", " ").slice(0, 19);
    };
    const head = ["Cycle start time", "Cycle end time", "Cycle timezone", "Recovery score %", "Resting heart rate (bpm)", "Heart rate variability (ms)", "Skin temp (celsius)", "Day Strain", "Energy burned (cal)", "Max HR (bpm)", "Average HR (bpm)", "Sleep onset", "Wake onset", "Sleep performance %", "Respiratory rate (rpm)", "Asleep duration (min)", "In bed duration (min)", "Light sleep duration (min)", "Deep (SWS) duration (min)", "REM duration (min)", "Awake duration (min)", "Sleep need (min)", "Sleep debt (min)", "Sleep efficiency %", "Sleep consistency %"];
    const lines = [head.join(",")];
    for (const r of all<CycleDb>(db, "SELECT * FROM cycles ORDER BY start DESC")) {
      const v = cycleView(db, r);
      const m = v.sleep?.metrics;
      const off = tzOffsetMin(tz, r.start);
      const tzs = `UTC${off >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}:${String(Math.abs(off) % 60).padStart(2, "0")}`;
      const n = (x: number | null | undefined, d = 0) => (x === null || x === undefined ? "" : x.toFixed(d));
      lines.push([fmt(r.start), fmt(r.end), tzs, n(v.recovery?.score), n(v.recovery?.rhr), n(v.recovery?.hrv), n(m?.skinTemp, 2), n(v.strain?.strain, 1), n(v.strain?.kcal), n(v.strain?.maxHr), n(v.strain?.avgHr), fmt(m?.start ?? null), fmt(m?.end ?? null), n(v.sleep?.performance), n(m?.respRate, 1), n(m ? m.asleep / 60 : null), n(m ? m.inBed / 60 : null), n(m ? m.light / 60 : null), n(m ? m.deep / 60 : null), n(m ? m.rem / 60 : null), n(m ? m.awake / 60 : null), n(v.sleep?.need.total), n(v.sleep?.debt), n(m ? m.efficiency * 100 : null), n(v.sleep?.consistency)].join(","));
    }
    c.header("content-disposition", 'attachment; filename="openwhoop_physiological_cycles.csv"');
    return c.body(lines.join("\n"), 200, { "content-type": "text/csv" });
  });

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues.slice(0, 5) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "invalid JSON" }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  return { app, ctx, sched };
}

// ── view helpers ────────────────────────────────────────────────────────

function cycleView(db: Db, cycle: CycleDb) {
  const sleepRow = get<SleepRow>(db, "SELECT * FROM sleeps WHERE id = ?", cycle.sleep_id);
  const metrics = j<SleepMetrics>(sleepRow?.metrics);
  const score = j<NonNullable<CycleScore["sleep"]>>(cycle.sleep_score);
  const recovery = j<NonNullable<CycleScore["recovery"]>>(cycle.recovery);
  const strain = j<StrainResult>(cycle.strain);
  return {
    cycle: { start: cycle.start, end: cycle.end },
    recovery,
    sleep: metrics && score ? { ...score, band: sleepBand(score.performance), metrics } : null,
    strain: strain ? { ...strain, band: strainBand(strain.strain) } : null,
  };
}

/** Tonight's sleep need and suggested bedtime (for the open cycle). */
function tonightPlan(db: Db) {
  const profile = getProfile(db);
  const cycles = all<CycleDb>(db, "SELECT * FROM cycles ORDER BY start DESC LIMIT 6");
  const cur = cycles[0];
  const past = cycles.map((c) => {
    const sc = j<NonNullable<CycleScore["sleep"]>>(c.sleep_score);
    const m = j<SleepMetrics>(get<SleepRow>(db, "SELECT metrics FROM sleeps WHERE id = ?", c.sleep_id)?.metrics);
    return sc && m ? { needMin: sc.need.total, asleepMin: m.asleep / 60, napMin: 0 } : null;
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  const strain = j<StrainResult>(cur?.strain)?.strain ?? 0;
  const naps = all<SleepRow>(db, "SELECT metrics FROM sleeps WHERE nap = 1 AND start >= ?", cur?.start ?? now()).reduce((a, n) => a + (j<SleepMetrics>(n.metrics)?.asleep ?? 0) / 60, 0);
  const need = sleepNeed(sleepNeedBaseline(profile), sleepDebt(past), strain, naps);
  const recent = all<SleepRow>(db, "SELECT metrics FROM sleeps WHERE nap = 0 ORDER BY start DESC LIMIT 7").map((r) => j<SleepMetrics>(r.metrics)!);
  const eff = recent.length ? recent.reduce((a, m) => a + m.efficiency, 0) / recent.length : 0.9;
  const lat = recent.length ? recent.reduce((a, m) => a + m.latency, 0) / recent.length / 60 : 12;
  const alarm = getAlarm(db);
  const tzOff = tzOffsetMin(profile.timezone, now());
  const wakeAt = nextLocalTime(alarm.latestWake, now() + 3 * 3600, tzOff);
  return {
    needMin: Math.round(need.total),
    need,
    wakeAt,
    bedtimes: ([100, 85, 70] as const).map((g) => ({ goal: g, at: recommendedBedtime(wakeAt, need.total, g, eff, lat) })),
  };
}

function baselines30(db: Db, before: number) {
  const rows = all<CycleDb>(db, "SELECT recovery, strain FROM cycles WHERE start < ? ORDER BY start DESC LIMIT 30", before);
  const recs = rows.map((r) => j<NonNullable<CycleScore["recovery"]>>(r.recovery)).filter((r): r is NonNullable<typeof r> => !!r);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return {
    hrv: avg(recs.map((r) => r.hrv)),
    rhr: avg(recs.map((r) => r.rhr)),
    resp: avg(recs.map((r) => r.resp)),
    recovery: avg(recs.map((r) => r.score)),
    strain: avg(rows.map((r) => j<StrainResult>(r.strain)?.strain ?? null)),
  };
}

function pruneRaw(db: Db, days: number) {
  if (days > 0) run(db, "DELETE FROM raw_batches WHERE received_at < ?", now() - days * 86400);
}

