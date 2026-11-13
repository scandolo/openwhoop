// Turns stored samples into sleeps, workouts, minute aggregates and scored
// cycles. Incremental: `processRange` only rebuilds what new data touches,
// then replays the (cheap) recovery/debt/need chain over all cycles.
import { buildSeries, epochs, type Epoch } from "../algorithms/series.ts";
import { detectSleep, sleepMetrics, stageSleep, type SleepMetrics, type StageSegment } from "../algorithms/sleep.ts";
import { hrrFraction, strainFromHr, type Physiology, type StrainResult } from "../algorithms/strain.ts";
import { recovery, updateBaseline, vitalsOutOfRange, type Baseline, type RecoveryResult } from "../algorithms/recovery.ts";
import { sleepConsistency, sleepDebt, sleepNeed, sleepPerformance, type NeedBreakdown, type PastNight } from "../algorithms/sleep-score.ts";
import { highStressEpisodes, stressBaseline, stressSeries, type StressMinute } from "../algorithms/stress.ts";
import { all, get, now, run, tx, type Db } from "./db.ts";
import { emit } from "./events.ts";
import { loadSamples } from "./ingest.ts";
import { getProfile, localDate, physiology, sleepNeedBaseline, tzOffsetMin } from "./settings.ts";
import { personalOffset } from "./integrations/whoop.ts";

const H = 3600;
const DAY = 86400;

export interface SleepRow {
  id: number;
  start: number;
  end: number;
  nap: number;
  stages: string;
  metrics: string;
}

export interface CycleScore {
  sleep: { need: NeedBreakdown; debt: number; performance: number; consistency: number | null } | null;
  recovery: (RecoveryResult & { hrv: number | null; rhr: number | null; resp: number | null; skinTemp: number | null; flags: string[]; baseline: Baseline | null }) | null;
}

// ── window processing ─────────────────────────────────────────────────

export function processRange(db: Db, from: number, to: number, opts: { emit?: boolean } = {}) {
  const bounds = get<{ lo: number | null; hi: number | null }>(db, "SELECT MIN(ts) lo, MAX(ts) hi FROM samples");
  if (!bounds?.lo || !bounds.hi) return;
  const lo = Math.floor(Math.max(bounds.lo, from - 36 * H) / 60) * 60;
  const hi = Math.min(bounds.hi + 1, to + 2 * H);
  const newSleeps: number[] = [];
  const newWorkouts: number[] = [];
  // 2-day chunks with 30 h of look-back so a night is never cut in half
  for (let a = lo; a < hi; a += 2 * DAY) {
    const b = Math.min(hi, a + 2 * DAY);
    const r = processChunk(db, Math.floor(Math.max(bounds.lo, a - 30 * H) / 60) * 60, b, a);
    newSleeps.push(...r.sleeps);
    newWorkouts.push(...r.workouts);
  }
  const cycles = rebuildCycles(db, from - 2 * DAY);
  if (opts.emit) {
    for (const id of newSleeps) {
      const s = get<SleepRow>(db, "SELECT * FROM sleeps WHERE id = ?", id);
      if (s && !s.nap) emit(db, "sleep.scored", { sleepId: id, start: s.start, end: s.end, metrics: JSON.parse(s.metrics) });
    }
    for (const c of cycles.newlyScored) emit(db, "recovery.scored", c);
    for (const id of newWorkouts) emit(db, "workout.created", { workout: workoutById(db, id) });
    for (const ep of cycles.stressEpisodes) emit(db, "stress.high", ep);
  }
}

function processChunk(db: Db, loadFrom: number, to: number, keepFrom: number) {
  const rows = loadSamples(db, loadFrom, to);
  if (rows.length < 600) return { sleeps: [], workouts: [] };
  const s = buildSeries(rows, loadFrom, to);
  const ep = epochs(s);
  const p = currentPhysiology(db);

  // sleeps: replace everything that starts after keepFrom − 12 h
  const replaceFrom = keepFrom - 12 * H;
  const periods = detectSleep(ep).filter((x) => x.start >= replaceFrom);
  const insertedSleeps: number[] = [];
  const known = new Set(all<{ start: number }>(db, "SELECT start FROM sleeps WHERE start >= ? AND start < ?", replaceFrom, to).map((r) => r.start));
  tx(db, () => {
    run(db, "DELETE FROM sleeps WHERE start >= ? AND start < ?", replaceFrom, to);
    for (const period of periods) {
      const stages = stageSleep(ep, period);
      const m = sleepMetrics(s, period, stages);
      // a sleep that touches the end of the data may still be going on
      const partial = to - period.end < 15 * 60;
      const res = run(db, "INSERT OR REPLACE INTO sleeps (start, end, nap, stages, metrics, updated_at) VALUES (?, ?, ?, ?, ?, ?)", period.start, period.end, period.nap ? 1 : 0, JSON.stringify(stages), JSON.stringify({ ...m, partial }), now());
      if (!known.has(period.start) && !partial) insertedSleeps.push(Number(res.lastInsertRowid));
    }
  });

  // workouts (auto-detected): sustained HR near zone 1+ for ≥ 12 min
  const workouts = detectWorkouts(ep, p).filter((w) => w.start >= keepFrom - 2 * H);
  const insertedWorkouts: number[] = [];
  tx(db, () => {
    const keepKeys = new Set(all<{ start: number }>(db, "SELECT start FROM workouts WHERE source = 'detected' AND start >= ? AND start < ?", keepFrom - 2 * H, to).map((r) => r.start));
    run(db, "DELETE FROM workouts WHERE source = 'detected' AND start >= ? AND start < ?", keepFrom - 2 * H, to);
    const others = all<{ start: number; end: number }>(db, "SELECT start, end FROM workouts WHERE source != 'detected' AND end > ? AND start < ?", keepFrom - 2 * H, to);
    for (const w of workouts) {
      if (others.some((o) => o.start < w.end && o.end > w.start)) continue;
      if (to - w.end < 5 * 60) continue; // may still be going on
      const r = strainFromHr(s.hr.subarray(w.start - s.start, w.end - s.start), p);
      if (r.strain < 0.1) continue;
      const res = run(db, "INSERT INTO workouts (start, end, sport, name, source, strain, avg_hr, max_hr, kcal, zones) VALUES (?, ?, 'activity', 'Activity', 'detected', ?, ?, ?, ?, ?)", w.start, w.end, r.strain, r.avgHr, r.maxHr, r.kcal, JSON.stringify(r.zoneSeconds));
      if (!keepKeys.has(w.start)) insertedWorkouts.push(Number(res.lastInsertRowid));
    }
  });

  writeMinutes(db, s.start, ep.filter((e) => e.t >= keepFrom), periods);
  return { sleeps: insertedSleeps, workouts: insertedWorkouts };
}

function detectWorkouts(ep: Epoch[], p: Physiology) {
  const active = ep.map((e) => Number.isFinite(e.hr) && hrrFraction(e.hr, p.restingHr, p.maxHr) >= 0.45);
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < ep.length; ) {
    if (!active[i]) {
      i++;
      continue;
    }
    let j = i, gap = 0, last = i;
    while (j < ep.length && gap <= 6) {
      if (active[j]) {
        last = j;
        gap = 0;
      } else gap++;
      j++;
    }
    const start = ep[i]!.t, end = ep[last]!.t + 30;
    if (end - start >= 12 * 60) out.push({ start, end });
    i = last + 1;
  }
  return out;
}

function writeMinutes(db: Db, _base: number, ep: Epoch[], sleeps: { start: number; end: number }[]) {
  if (!ep.length) return;
  const from = ep[0]!.t, to = ep[ep.length - 1]!.t + 30;
  const workouts = all<{ start: number; end: number }>(db, "SELECT start, end FROM workouts WHERE end > ? AND start < ?", from, to);
  const mins: (StressMinute & { hr: number; hrMin: number; hrMax: number; rmssd: number; motion: number; off: boolean })[] = [];
  for (let i = 0; i + 1 < ep.length; i += 2) {
    const a = ep[i]!, b = ep[i + 1]!;
    if (a.t % 60 !== 0) {
      i--;
      continue;
    }
    const hrs = [a.hr, b.hr].filter(Number.isFinite);
    const rs = [a.rmssd, b.rmssd].filter(Number.isFinite);
    const t = a.t;
    mins.push({
      t,
      hr: hrs.length ? (hrs[0]! + (hrs[1] ?? hrs[0]!)) / 2 : NaN,
      hrMin: hrs.length ? Math.min(...hrs) : NaN,
      hrMax: hrs.length ? Math.max(...hrs) : NaN,
      rmssd: rs.length ? (rs[0]! + (rs[1] ?? rs[0]!)) / 2 : NaN,
      lnRmssd: rs.length ? Math.log((rs[0]! + (rs[1] ?? rs[0]!)) / 2) : NaN,
      motion: a.motion + b.motion,
      moving: a.moves + b.moves > 8,
      asleep: sleeps.some((s) => t >= s.start && t < s.end),
      workout: workouts.some((w) => t >= w.start && t < w.end),
      off: a.contact + b.contact < 1,
    });
  }
  // stress baseline: 14 days of stored calm minutes plus this window
  const hist = all<{ ts: number; hr: number; rmssd: number | null; state: string }>(db, "SELECT ts, hr, rmssd, state FROM minutes WHERE ts >= ? AND ts < ? AND state = 'rest'", from - 14 * DAY, from);
  const baseline = stressBaseline([
    ...hist.map((m) => ({ t: m.ts, hr: m.hr, lnRmssd: m.rmssd ? Math.log(m.rmssd) : NaN, moving: false, asleep: false, workout: false })),
    ...mins,
  ]);
  const stress = baseline ? stressSeries(mins, baseline) : mins.map(() => null);
  tx(db, () => {
    const st = db.prepare("INSERT OR REPLACE INTO minutes (ts, hr, hr_min, hr_max, rmssd, motion, stress, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    mins.forEach((m, i) => {
      const state = m.off ? "off" : m.asleep ? "sleep" : m.workout ? "workout" : m.moving ? "active" : "rest";
      const f = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
      st.run(m.t, f(m.hr), f(m.hrMin), f(m.hrMax), f(m.rmssd), Math.round(m.motion * 1000) / 1000, m.off ? null : stress[i] ?? null, state);
    });
  });
}

// ── cycles ─────────────────────────────────────────────────────────────

/** Resting HR (recent sleep RHR median) and max HR for strain/zone maths. */
export function currentPhysiology(db: Db, at = now()): Physiology {
  const profile = getProfile(db);
  const rhrs = all<{ m: string }>(db, "SELECT metrics m FROM sleeps WHERE nap = 0 AND end <= ? ORDER BY end DESC LIMIT 14", at + DAY)
    .map((r) => (JSON.parse(r.m) as SleepMetrics).rhr)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const rhr = rhrs.length ? rhrs[rhrs.length >> 1]! : 60;
  // A single artifact spike must not raise max HR (it would deflate every
  // strain score): use the third-highest daily peak of 1-minute average HR.
  const observed = get<{ m: number | null }>(db, "SELECT MAX(hr) m FROM minutes WHERE ts > ? AND state != 'off' GROUP BY ts / 86400 ORDER BY m DESC LIMIT 1 OFFSET 2", at - 180 * DAY)?.m ?? null;
  return physiology(profile, rhr, observed === null ? null : Math.round(observed));
}

interface CycleRow {
  start: number;
  end: number | null;
  sleep_id: number;
  date: string;
  sleep_score: string | null;
  recovery: string | null;
  strain: string | null;
}

function rebuildCycles(db: Db, dirtyFrom: number) {
  const profile = getProfile(db);
  const tz = profile.timezone;
  const sleeps = all<SleepRow>(db, "SELECT * FROM sleeps WHERE nap = 0 ORDER BY start");
  const naps = all<SleepRow>(db, "SELECT * FROM sleeps WHERE nap = 1 ORDER BY start");
  const existing = new Map(all<CycleRow>(db, "SELECT * FROM cycles").map((c) => [c.start, c]));
  const dataEnd = get<{ hi: number }>(db, "SELECT MAX(ts) hi FROM samples")?.hi ?? now();
  const baselineNeed = sleepNeedBaseline(profile);
  const offset = personalOffset(db);

  let baseline: Baseline | null = null;
  const past: (PastNight & { start: number; end: number })[] = [];
  const newlyScored: Record<string, unknown>[] = [];
  const out: CycleRow[] = [];
  let prevStrain = 0;
  let prevNaps = 0;

  for (let i = 0; i < sleeps.length; i++) {
    const s = sleeps[i]!;
    const m = JSON.parse(s.metrics) as SleepMetrics & { partial?: boolean };
    const nextStart = sleeps[i + 1]?.start ?? null;
    const end = nextStart;
    const old = existing.get(s.start);

    // sleep need for this night, from the previous cycle's strain and naps
    const debt = sleepDebt(past.slice().reverse());
    const need = sleepNeed(baselineNeed, debt, prevStrain, prevNaps);
    const local = (t: number) => t + tzOffsetMin(tz, t) * 60;
    const nights = [...past.slice(-3).map((p) => [local(p.start), local(p.end)] as [number, number]), [local(s.start), local(s.end)] as [number, number]];
    const consistency = sleepConsistency(nights);
    const asleepMin = m.asleep / 60;
    const performance = sleepPerformance(asleepMin, need.total, 100 * m.efficiency, consistency);

    // recovery from this night against the baseline of previous nights
    const enoughSleep = m.asleep >= 2 * H && !m.partial;
    const vitals = { hrv: m.hrv, rhr: m.rhr, resp: m.respRate, skinTemp: m.skinTemp };
    const rec = enoughSleep ? recovery(vitals, performance, baseline, offset) : null;
    const recJson = rec ? { ...rec, ...vitals, flags: vitalsOutOfRange(rec.deltas), baseline } : null;
    if (enoughSleep) baseline = updateBaseline(baseline, vitals);

    // strain over the cycle: recompute only where data changed
    const spanEnd = Math.min(end ?? dataEnd + 1, dataEnd + 1);
    let strain: StrainResult | null = old?.strain && old.end === end && spanEnd < dirtyFrom ? (JSON.parse(old.strain) as StrainResult) : null;
    if (!strain || spanEnd >= dirtyFrom) strain = cycleStrain(db, s.start, spanEnd);

    const cycleNaps = naps.filter((n) => n.start >= s.end && (end === null || n.start < end)).reduce((a, n) => a + (JSON.parse(n.metrics) as SleepMetrics).asleep / 60, 0);
    const row: CycleRow = {
      start: s.start,
      end,
      sleep_id: s.id,
      date: localDate(tz, s.end),
      sleep_score: JSON.stringify({ need, debt, performance, consistency }),
      recovery: recJson ? JSON.stringify(recJson) : null,
      strain: JSON.stringify(strain),
    };
    out.push(row);
    if (recJson?.score !== null && recJson && (!old?.recovery || JSON.parse(old.recovery).score === null) && s.end >= dirtyFrom) {
      newlyScored.push({ date: row.date, recovery: recJson.score, band: recJson.band, hrv: vitals.hrv, rhr: vitals.rhr, sleepPerformance: performance });
    }

    if (!m.partial) past.push({ start: s.start, end: s.end, needMin: need.total, asleepMin, napMin: cycleNaps });
    prevStrain = strain.strain;
    prevNaps = cycleNaps;
  }

  tx(db, () => {
    run(db, "DELETE FROM cycles");
    const st = db.prepare("INSERT INTO cycles (start, end, sleep_id, date, sleep_score, recovery, strain, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const c of out) st.run(c.start, c.end, c.sleep_id, c.date, c.sleep_score, c.recovery, c.strain, now());
  });

  // sustained high stress since the dirty point
  const mins = all<{ ts: number; stress: number | null }>(db, "SELECT ts, stress FROM minutes WHERE ts >= ? ORDER BY ts", Math.max(dirtyFrom, dataEnd - DAY));
  const stressEpisodes = highStressEpisodes(mins.map((m) => m.ts), mins.map((m) => m.stress)).map((e) => ({ ...e, peak: Math.round(e.peak * 10) / 10 }));
  return { newlyScored, stressEpisodes };
}

/** Re-run the recovery/sleep chain (e.g. after a new personal calibration); strains are reused. */
export function rescore(db: Db) {
  rebuildCycles(db, now() + 86400);
}

function cycleStrain(db: Db, from: number, to: number): StrainResult {
  const p = currentPhysiology(db, from);
  const hr = new Float32Array(Math.max(0, to - from)).fill(NaN);
  for (const r of all<{ ts: number; hr: number }>(db, "SELECT ts, hr FROM samples WHERE ts >= ? AND ts < ? AND hr > 0", from, to)) hr[r.ts - from] = r.hr;
  const res = strainFromHr(hr, p);
  // missing seconds count as basal energy only for time that has passed
  return { ...res, strain: Math.round(res.strain * 10) / 10, kcal: Math.round(res.kcal) };
}

export function workoutById(db: Db, id: number) {
  const w = get<Record<string, unknown>>(db, "SELECT * FROM workouts WHERE id = ?", id);
  return w ? { ...w, zones: w.zones ? JSON.parse(w.zones as string) : null, meta: w.meta ? JSON.parse(w.meta as string) : null } : null;
}

/** Score a manual/live/imported workout from stored samples. */
export function scoreWorkout(db: Db, start: number, end: number) {
  const p = currentPhysiology(db, start);
  const hr = new Float32Array(Math.max(0, end - start)).fill(NaN);
  for (const r of all<{ ts: number; hr: number }>(db, "SELECT ts, hr FROM samples WHERE ts >= ? AND ts < ? AND hr > 0", start, end)) hr[r.ts - start] = r.hr;
  return strainFromHr(hr, p);
}

export type { StageSegment };
