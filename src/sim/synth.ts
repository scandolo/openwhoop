// Physiological simulator. Produces per-second strap records that look like a
// real WHOOP 4.0 history download, plus the ground truth that generated them
// (sleep stages, workouts, stress episodes, journal behaviours).
//
// It exists because the project is developed without a strap: it drives the
// demo instance, the end-to-end pipeline tests, and sanity checks for the
// sleep stager. It is a model, not data — see docs/algorithms.md.
import type { HistoryRecord } from "../protocol/history.ts";
import { rng, type Rng } from "../algorithms/stats.ts";

export type Stage = "wake" | "light" | "deep" | "rem";

export interface SimProfile {
  restingHr: number;
  maxHr: number;
  lnRmssd: number; // nightly baseline, ln(ms)
  respRate: number; // breaths/min during sleep
  bedtimeHour: number; // local, e.g. 23.25
  wakeHour: number; // local, e.g. 7.25
}

export interface SimSegment {
  start: number;
  end: number;
}

export interface SimDay {
  date: string; // local YYYY-MM-DD of the evening the night starts
  journal: Record<string, boolean>;
  readiness: number;
  sick: boolean;
  bed: number;
  wake: number;
  stages: (SimSegment & { stage: Stage })[];
  workouts: (SimSegment & { sport: string; intensity: number })[];
  stress: SimSegment[];
}

export const DEFAULT_PROFILE: SimProfile = {
  restingHr: 54,
  maxHr: 191,
  lnRmssd: Math.log(68),
  respRate: 14.6,
  bedtimeHour: 23.3,
  wakeHour: 7.2,
};

export const SIM_BEHAVIOURS = ["alcohol", "late_caffeine", "late_meal", "screen_in_bed", "read_before_bed"] as const;

interface State {
  hr: number; // target bpm
  lnR: number; // target ln RMSSD
  motion: number; // gravity jitter (g)
  temp: number; // skin °C
  resp: number; // breaths/min
  contact: boolean;
}

/** Local midnight (unix seconds) for a date string, given a fixed UTC offset in minutes. */
function localMidnight(date: string, tzOffsetMin: number): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000 - tzOffsetMin * 60;
}

function isoDate(unix: number, tzOffsetMin: number): string {
  return new Date((unix + tzOffsetMin * 60) * 1000).toISOString().slice(0, 10);
}

function planNight(r: Rng, bed: number, wake: number, alcohol: boolean): (SimSegment & { stage: Stage })[] {
  const out: (SimSegment & { stage: Stage })[] = [];
  let t = bed;
  const push = (stage: Stage, minutes: number) => {
    const end = Math.min(wake, t + Math.round(minutes * 60));
    if (end > t) out.push({ start: t, end, stage });
    t = end;
  };
  push("wake", r.range(6, 22)); // sleep latency
  const half = bed + (wake - bed) / 2;
  for (let cycle = 0; t < wake; cycle++) {
    push("light", r.range(14, 26) + (cycle === 0 ? 5 : 0) + (cycle >= 3 ? r.range(8, 18) : 0));
    const deep = [r.range(28, 45), r.range(18, 32), r.range(4, 14)][cycle] ?? r.range(0, 5);
    push("deep", deep);
    push("light", r.range(5, 12));
    let rem = [r.range(5, 12), r.range(12, 20), r.range(16, 25)][cycle] ?? r.range(16, 28);
    if (alcohol && t < half) rem *= 0.4;
    push("rem", rem);
    const wakeP = alcohol && t > half ? 0.85 : 0.55;
    if (r.chance(wakeP)) push("wake", r.range(1.5, alcohol ? 9 : 6));
  }
  return out;
}

/**
 * Simulate `days` days ending at `end` (exclusive). Days are aligned to local
 * midnight using `tzOffsetMin`. Returns records ordered by time and the truth.
 */
export function simulate(opts: {
  days: number;
  end?: number;
  seed?: number;
  tzOffsetMin?: number;
  profile?: SimProfile;
}): { records: HistoryRecord[]; days: SimDay[] } {
  const r = rng(opts.seed ?? 42);
  const p = opts.profile ?? DEFAULT_PROFILE;
  const tz = opts.tzOffsetMin ?? 60;
  const endUnix = opts.end ?? Math.floor(Date.now() / 1000);
  const lastDate = isoDate(endUnix, tz);
  const firstMidnight = localMidnight(lastDate, tz) - (opts.days - 1) * 86400;

  // ── plan every day ──────────────────────────────────────────────────
  const days: SimDay[] = [];
  let readiness = 0;
  let prevStrainLoad = 0;
  let sickLeft = 0;
  for (let d = 0; d < opts.days; d++) {
    const midnight = firstMidnight + d * 86400;
    const date = isoDate(midnight + 3600, tz);
    const dow = new Date(date + "T12:00:00Z").getUTCDay();
    const weekend = dow === 5 || dow === 6;
    if (sickLeft === 0 && r.chance(0.025)) sickLeft = 2 + Math.floor(r.range(0, 2));
    const sick = sickLeft > 0;
    if (sickLeft > 0) sickLeft--;
    const journal: Record<string, boolean> = {
      alcohol: r.chance(weekend ? 0.45 : 0.12),
      late_caffeine: r.chance(0.3),
      late_meal: r.chance(0.25),
      screen_in_bed: r.chance(0.5),
      read_before_bed: r.chance(0.35),
    };

    const workouts: SimDay["workouts"] = [];
    if (!sick && r.chance(0.62)) {
      const sport = ["running", "cycling", "strength", "hiit"][Math.floor(r.range(0, 4))]!;
      const hour = r.chance(0.5) ? r.range(7.8, 9) : r.range(17.5, 19.5);
      const start = Math.round(midnight + hour * 3600);
      const minutes = sport === "hiit" ? r.range(25, 40) : r.range(35, 85);
      const intensity = { running: r.range(0.62, 0.84), cycling: r.range(0.58, 0.8), strength: r.range(0.42, 0.6), hiit: r.range(0.7, 0.9) }[sport]!;
      workouts.push({ start, end: start + Math.round(minutes * 60), sport, intensity });
    }
    const load = workouts.reduce((s, w) => s + (w.end - w.start) / 60 * w.intensity ** 2, 0);

    const stress: SimSegment[] = [];
    const nStress = Math.floor(r.range(0, 2.6));
    for (let i = 0; i < nStress; i++) {
      const start = Math.round(midnight + r.range(10, 17) * 3600);
      if (workouts.some((w) => start < w.end + 1800 && start > w.start - 3600)) continue;
      stress.push({ start, end: start + Math.round(r.range(15, 40) * 60) });
    }

    // readiness drives the *next* night's physiology
    readiness = 0.55 * readiness + r.normal() * 0.55 - 0.012 * (prevStrainLoad - 25);
    prevStrainLoad = load;

    const bedShift = (weekend ? 0.8 : 0) + r.normal() * 0.55 + (journal.late_caffeine ? 0.35 : 0);
    const wakeShift = (dow === 6 || dow === 0 ? 1.0 : 0) + r.normal() * 0.35;
    const bed = Math.round(midnight + (p.bedtimeHour + bedShift) * 3600);
    const wake = Math.round(midnight + 86400 + (p.wakeHour + wakeShift) * 3600);
    const stages = planNight(r, bed, wake, journal.alcohol!);
    days.push({ date, journal, readiness, sick, bed, wake, stages, workouts, stress });
  }

  // ── render seconds ──────────────────────────────────────────────────
  const start = firstMidnight;
  const total = opts.days * 86400;
  const end = Math.min(start + total, endUnix);
  const records: HistoryRecord[] = [];

  // Fast lookups by time
  const stageAt = new Map<number, { stage: Stage; day: SimDay; onset: number }>();
  for (const day of days) {
    const onset = day.stages.find((s) => s.stage !== "wake")?.start ?? day.bed;
    for (const s of day.stages) for (let t = s.start; t < s.end; t += 30) stageAt.set(t - (t % 30), { stage: s.stage, day, onset });
  }

  let gravity: [number, number, number] = [0.05, -0.2, 0.97];
  let beatClock = start;
  let hrWalk = 0;
  let walkUntil = 0;
  let offUntil = 0;
  let prevDayIdx = -1;
  const effects = (day: SimDay) => {
    const j = day.journal;
    return {
      rhr: p.restingHr - 2.6 * day.readiness + (j.alcohol ? 5 : 0) + (j.late_meal ? 1.8 : 0) + (j.late_caffeine ? 0.8 : 0) + (day.sick ? 6 : 0),
      lnR: p.lnRmssd + 0.16 * day.readiness - (j.alcohol ? 0.32 : 0) - (j.late_meal ? 0.09 : 0) - (j.late_caffeine ? 0.07 : 0) - (j.screen_in_bed ? 0.02 : 0) + (j.read_before_bed ? 0.04 : 0) - (day.sick ? 0.35 : 0),
      temp: 34.6 + (day.sick ? 0.75 : 0) + (j.alcohol ? 0.15 : 0),
      resp: p.respRate + (day.sick ? 1.6 : 0),
    };
  };

  for (let t = start; t < end; t++) {
    const dayIdx = Math.min(days.length - 1, Math.floor((t - start) / 86400));
    const today = days[dayIdx]!;
    if (dayIdx !== prevDayIdx) {
      prevDayIdx = dayIdx;
      if (r.chance(0.6)) {
        const off = Math.round(start + dayIdx * 86400 + r.range(8, 21) * 3600);
        offUntil = off; // shower / off-wrist episode scheduled below
        (today as SimDay & { off?: number }).off = off;
      }
    }
    const offStart = (today as SimDay & { off?: number }).off;
    const offWrist = offStart !== undefined && t >= offStart && t < offStart + 600;
    void offUntil;

    const night = stageAt.get(t - (t % 30));
    let s: State;
    if (night) {
      const e = effects(night.day);
      const sinceOnset = Math.max(0, t - night.onset) / 60;
      const early = 6 * Math.exp(-sinceOnset / 100) + (night.day.journal.alcohol ? 4 * Math.exp(-sinceOnset / 240) : 0);
      const stageHr = { wake: 11, light: 2, deep: -2.5, rem: 5.5 }[night.stage];
      const stageR = { wake: 0.6, light: 1.0, deep: 1.25, rem: 0.72 }[night.stage];
      s = {
        hr: e.rhr + stageHr + early,
        lnR: e.lnR + Math.log(stageR),
        motion: night.stage === "wake" ? 0.02 : night.stage === "light" ? 0.0035 : 0.0012,
        temp: e.temp - (night.stage === "wake" ? 0.4 : 0),
        resp: e.resp + (night.stage === "rem" ? r.normal() * 1.2 : 0),
        contact: true,
      };
      if ((night.stage === "light" && r.chance(0.0016)) || (night.stage === "wake" && r.chance(0.01))) {
        gravity = randomPosture(r, true); // posture shift
        s.motion = 0.25;
      }
    } else {
      const next = days[Math.min(days.length - 1, dayIdx)]!;
      const e = effects(days[Math.max(0, dayIdx - 1)] ?? next);
      const wo = today.workouts.find((w) => t >= w.start && t < w.end + 1200);
      const st = today.stress.find((x) => t >= x.start && t < x.end);
      const local = (((t - start) % 86400) + 86400) % 86400 / 3600;
      s = { hr: e.rhr + 17 + 4 * Math.sin(((local - 15) / 24) * 2 * Math.PI), lnR: e.lnR - 0.65, motion: 0.012, temp: 33.3, resp: e.resp + 2, contact: true };
      if (wo) {
        const into = (t - wo.start) / 60;
        const dur = (wo.end - wo.start) / 60;
        const hrr = p.maxHr - e.rhr;
        let frac: number;
        if (t >= wo.end) frac = (wo.intensity - 0.15) * Math.exp(-(t - wo.end) / 240);
        else {
          frac = wo.intensity * Math.min(1, into / 6);
          if (wo.sport === "hiit" || wo.sport === "strength") frac *= 0.78 + 0.22 * Math.sin(into * 1.6) ** 2;
          if (into > dur - 5) frac *= 0.9;
        }
        s.hr = e.rhr + Math.max(0.12, frac) * hrr;
        s.lnR = Math.log(8 + 30 * (1 - frac));
        s.motion = t < wo.end ? (wo.sport === "cycling" ? 0.08 : 0.22) : 0.03;
        s.temp = 32.6;
        s.resp = 18 + 22 * frac;
      } else if (st) {
        s.hr += 13;
        s.lnR -= 0.55;
        s.motion = 0.006;
      } else {
        if (t > walkUntil && r.chance(1 / 2400)) walkUntil = t + Math.round(r.range(4, 15) * 60);
        if (t < walkUntil) {
          s.hr += 24;
          s.motion = 0.12;
          s.lnR -= 0.3;
        }
      }
      if (r.chance(s.motion > 0.05 ? 0.02 : 0.0008)) gravity = randomPosture(r, false);
    }
    if (offWrist) s.contact = false;

    const walkSd = night ? { wake: 0.8, light: 0.25, deep: 0.12, rem: 0.65 }[night.stage] : 0.6;
    hrWalk = 0.985 * hrWalk + r.normal() * walkSd;
    const hr = Math.max(38, s.hr + hrWalk);

    // gravity jitter
    const g: [number, number, number] = [gravity[0] + r.normal() * s.motion, gravity[1] + r.normal() * s.motion, gravity[2] + r.normal() * s.motion];
    const norm = Math.hypot(...g);
    for (let i = 0; i < 3; i++) g[i] = g[i]! / norm;

    // beats falling in this second
    const rr: number[] = [];
    const target = Math.exp(s.lnR);
    const A = 0.7 * target;
    const sigma = 0.5 * target;
    while (beatClock < t + 1) {
      let ibi = 60000 / hr + A * Math.sin(2 * Math.PI * (s.resp / 60) * beatClock) + sigma * r.normal();
      if (r.chance(0.003)) ibi *= r.chance(0.5) ? 0.55 : 1.7; // ectopic / missed beat
      ibi = Math.max(280, Math.min(2100, ibi));
      beatClock += ibi / 1000;
      const keep = s.motion < 0.1 || r.chance(0.35); // optical RR drops out under motion
      if (beatClock >= t && keep && rr.length < 4) rr.push(Math.round(ibi));
    }

    if (!s.contact) {
      records.push({ ts: t, hr: 0, rr: [], version: 12, sensor: sensorOff(g) });
      continue;
    }
    const phase = r.next() * 2 * Math.PI;
    records.push({
      ts: t,
      hr: Math.round(hr),
      rr,
      version: 12,
      sensor: {
        gravity: g,
        ppgGreen: Math.round(5200 + 120 * Math.sin(phase)),
        spo2Red: Math.round(1200 + 9 * Math.sin(phase)),
        spo2Ir: Math.round(1500 + 11 * Math.sin(phase)),
        skinTempRaw: Math.round((s.temp + r.normal() * 0.05) / 0.04),
        ambientLight: night ? 2 : 180,
      },
    });
  }
  return { records, days };
}

function randomPosture(r: Rng, lying: boolean): [number, number, number] {
  const v: [number, number, number] = lying
    ? [r.normal() * 0.6, r.normal() * 0.6, r.normal() * 0.6]
    : [r.normal() * 0.3, -0.5 + r.normal() * 0.3, 0.8 + r.normal() * 0.2];
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function sensorOff(g: [number, number, number]) {
  return { gravity: g, ppgGreen: 0, spo2Red: 0, spo2Ir: 0, skinTempRaw: 0, ambientLight: 300 };
}
