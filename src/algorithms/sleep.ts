// Sleep detection, staging and per-night metrics.
//
// Detection: actigraphy (gravity-vector change) with an adaptive stillness
// threshold, gated by heart rate dropping below the day's level and by skin
// contact (a strap on a table is perfectly still).
//
// Staging: a 4-state hidden Markov model over 30 s epochs. Emissions are
// Gaussian in night-normalised heart rate, ln RMSSD, heart-rate instability
// and movement; the prior shifts deep sleep to the first third of the night
// and REM to the last, and the transition matrix encodes normal sleep
// architecture (no wake→deep jumps, sticky stages). Decoded with Viterbi.
import { cleanRR, respiratoryRateFromRR, rmssd } from "./hrv.ts";
import { beatsIn, EPOCH, type Epoch, type Series } from "./series.ts";
import { clamp, mean, median, quantile } from "./stats.ts";

export type Stage = "wake" | "light" | "deep" | "rem";
export const STAGES: Stage[] = ["wake", "light", "deep", "rem"];

export interface SleepPeriod {
  start: number;
  end: number;
  nap: boolean;
}

export interface StageSegment {
  start: number;
  end: number;
  stage: Stage;
}

const MIN = 60;

// ── detection ──────────────────────────────────────────────────────────

export function detectSleep(ep: Epoch[]): SleepPeriod[] {
  if (ep.length < 60) return [];
  const acts = ep.filter((e) => e.contact > 0.5).map((e) => e.motion);
  const floor = quantile(acts, 0.1);
  const still = Math.max(0.12, 4 * floor);
  const hrs = ep.filter((e) => !Number.isNaN(e.hr)).map((e) => e.hr);
  const hrGate = quantile(hrs, 0.5);

  const W = 30; // 15 min window (centred)
  const cand = new Uint8Array(ep.length);
  for (let i = 0; i < ep.length; i++) {
    let n = 0, stillN = 0, hrSum = 0, hrN = 0, contactN = 0;
    for (let k = i - W / 2; k < i + W / 2; k++) {
      const e = ep[k];
      if (!e) continue;
      n++;
      if (e.contact > 0.5) contactN++;
      if (e.motion < still && e.moves === 0) stillN++;
      if (!Number.isNaN(e.hr)) {
        hrSum += e.hr;
        hrN++;
      }
    }
    const hrOk = hrN > 0 && hrSum / hrN < hrGate;
    cand[i] = n > 0 && contactN / n > 0.8 && stillN / n >= 0.7 && hrOk ? 1 : 0;
  }

  // runs of candidate epochs
  let blocks: { a: number; b: number }[] = [];
  for (let i = 0; i < ep.length; ) {
    if (!cand[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < ep.length && cand[j]) j++;
    blocks.push({ a: i, b: j });
    i = j;
  }
  // merge gaps < 50 min: WHOOP keeps one sleep across shorter wake gaps
  const merged: typeof blocks = [];
  for (const blk of blocks) {
    const last = merged[merged.length - 1];
    if (last && blk.a - last.b < (50 * MIN) / EPOCH) last.b = blk.b;
    else merged.push({ ...blk });
  }
  blocks = merged.filter((blk) => ((blk.b - blk.a) * EPOCH) >= 20 * MIN);

  return blocks.map((blk) => {
    const start = ep[blk.a]!.t;
    const end = ep[blk.b - 1]!.t + EPOCH;
    return { start, end, nap: end - start < 60 * MIN };
  });
}

// ── staging ────────────────────────────────────────────────────────────

interface Features {
  zhr: number;
  zhrv: number;
  zsd: number;
  move: number;
  frac: number; // position in the night 0..1
}

// [mean, sd] per feature per stage, in night-normalised units.
const EMIT: Record<Stage, Record<"zhr" | "zhrv" | "zsd", [number, number]>> = {
  wake: { zhr: [2.0, 1.2], zhrv: [-1.3, 1.1], zsd: [1.6, 1.3] },
  light: { zhr: [0.0, 0.65], zhrv: [0.0, 0.75], zsd: [0.0, 0.8] },
  deep: { zhr: [-0.9, 0.55], zhrv: [0.9, 0.7], zsd: [-0.8, 0.6] },
  rem: { zhr: [0.9, 0.7], zhrv: [-1.0, 0.8], zsd: [1.2, 0.9] },
};

// P(next | current) per 30 s epoch.
const TRANS: Record<Stage, Record<Stage, number>> = {
  wake: { wake: 0.88, light: 0.115, deep: 0.0005, rem: 0.0045 },
  light: { wake: 0.012, light: 0.955, deep: 0.018, rem: 0.015 },
  deep: { wake: 0.004, light: 0.03, deep: 0.965, rem: 0.001 },
  rem: { wake: 0.012, light: 0.02, deep: 0.0005, rem: 0.9675 },
};

function logNorm(x: number, [m, s]: [number, number]) {
  if (Number.isNaN(x)) return 0; // missing feature: uninformative
  const z = (x - m) / s;
  return -0.5 * z * z - Math.log(s);
}

function emission(stage: Stage, f: Features): number {
  const e = EMIT[stage];
  let lp = logNorm(f.zhr, e.zhr) + logNorm(f.zhrv, e.zhrv) + 0.6 * logNorm(f.zsd, e.zsd);
  // movement: decisive for wake, mildly against REM (atonia) and deep
  if (stage === "wake") lp += f.move > 0 ? 2.2 + Math.min(2, f.move / 5) : -1.5;
  else if (stage === "light") lp += f.move > 0 ? 0.2 : 0;
  else lp += f.move > 0 ? -2.5 : 0;
  // time-of-night prior
  if (stage === "deep") lp += Math.log(0.15 + 1.4 * Math.exp(-f.frac / 0.3));
  if (stage === "rem") lp += Math.log(f.frac < 0.08 ? 0.05 : 0.45 + f.frac);
  return lp;
}

function robustZ(xs: number[]) {
  const finite = xs.filter((x) => Number.isFinite(x));
  const m = median(finite);
  const scale = (quantile(finite, 0.75) - quantile(finite, 0.25)) / 1.349 || 1;
  return xs.map((x) => (Number.isFinite(x) ? (x - m) / scale : NaN));
}

export function stageSleep(ep: Epoch[], period: SleepPeriod): StageSegment[] {
  const night = ep.filter((e) => e.t >= period.start && e.t < period.end);
  if (!night.length) return [];
  const zhr = robustZ(night.map((e) => e.hr));
  const zhrv = robustZ(night.map((e) => (e.rmssd > 0 ? Math.log(e.rmssd) : NaN)));
  const zsd = robustZ(night.map((e) => e.hrSd));
  const feats: Features[] = night.map((e, i) => ({
    zhr: zhr[i]!,
    zhrv: zhrv[i]!,
    zsd: zsd[i]!,
    move: e.moves,
    frac: (e.t - period.start) / (period.end - period.start),
  }));

  // Viterbi in log space
  const S = STAGES.length;
  const n = feats.length;
  const lt = STAGES.map((a) => STAGES.map((b) => Math.log(TRANS[a][b])));
  let score = STAGES.map((s) => (s === "wake" ? Math.log(0.7) : s === "light" ? Math.log(0.28) : Math.log(0.01)) + emission(s, feats[0]!));
  const back: Uint8Array[] = [];
  for (let t = 1; t < n; t++) {
    const next = new Array<number>(S);
    const bp = new Uint8Array(S);
    for (let j = 0; j < S; j++) {
      let best = -Infinity, arg = 0;
      for (let i = 0; i < S; i++) {
        const v = score[i]! + lt[i]![j]!;
        if (v > best) {
          best = v;
          arg = i;
        }
      }
      next[j] = best + emission(STAGES[j]!, feats[t]!);
      bp[j] = arg;
    }
    score = next;
    back.push(bp);
  }
  // force waking up at the end
  let state = score.indexOf(Math.max(...score));
  const path = new Array<number>(n);
  path[n - 1] = state;
  for (let t = n - 2; t >= 0; t--) {
    state = back[t]![state]!;
    path[t] = state;
  }

  const segs: StageSegment[] = [];
  for (let t = 0; t < n; t++) {
    const stage = STAGES[path[t]!]!;
    const last = segs[segs.length - 1];
    if (last && last.stage === stage) last.end = night[t]!.t + EPOCH;
    else segs.push({ start: night[t]!.t, end: night[t]!.t + EPOCH, stage });
  }
  return segs;
}

// ── metrics ────────────────────────────────────────────────────────────

export interface SleepMetrics {
  start: number;
  end: number;
  nap: boolean;
  inBed: number; // seconds
  asleep: number;
  awake: number;
  light: number;
  deep: number;
  rem: number;
  latency: number;
  disturbances: number;
  cycles: number;
  efficiency: number; // 0..1
  restorative: number; // (deep + rem) / asleep
  hrv: number | null; // ms, RMSSD weighted toward the last deep-sleep period
  rhr: number | null; // bpm, same weighting
  respRate: number | null; // breaths/min
  skinTemp: number | null; // °C, median during sleep
  spo2: number | null; // %, ratio-of-ratios estimate
  avgHr: number | null;
  lowestHr: number | null;
}

/**
 * HRV and RHR the way WHOOP's data-science team describes it: RMSSD over
 * overlapping 5-minute windows stepped every 30 s across the whole sleep,
 * wake removed, then a weighted average with more weight on slow-wave sleep
 * and later in the night. RHR uses the same windows and weights.
 */
function weightedNightVitals(s: Series, segs: StageSegment[], period: SleepPeriod) {
  const stageAt = (t: number) => segs.find((g) => t >= g.start && t < g.end)?.stage ?? "wake";
  const span = period.end - period.start;
  let hrvSum = 0, hrSum = 0, wSum = 0;
  for (let t = period.start; t + 300 <= period.end; t += 30) {
    let wakeN = 0, deepN = 0;
    for (let k = t; k < t + 300; k += 30) {
      const st = stageAt(k);
      if (st === "wake") wakeN++;
      if (st === "deep") deepN++;
    }
    if (wakeN > 0) continue;
    const beats = cleanRR(beatsIn(s, t, t + 300));
    if (beats.length < 150) continue; // ≥ ~50% beat coverage at sleeping HR
    const w = (1 + 2 * (deepN / 10)) * (0.5 + (t + 150 - period.start) / span);
    hrvSum += Math.log(rmssd(beats)) * w;
    hrSum += (60000 / mean(beats)) * w;
    wSum += w;
  }
  // geometric weighting for HRV: one wild window shouldn't dominate
  return { hrv: wSum ? Math.exp(hrvSum / wSum) : null, rhr: wSum ? hrSum / wSum : null };
}

export function sleepMetrics(s: Series, period: SleepPeriod, segs: StageSegment[]): SleepMetrics {
  const dur = (st: Stage) => segs.filter((g) => g.stage === st).reduce((a, g) => a + g.end - g.start, 0);
  const awake = dur("wake");
  const inBed = period.end - period.start;
  const asleep = inBed - awake;
  const firstSleep = segs.find((g) => g.stage !== "wake");
  const latency = firstSleep ? firstSleep.start - period.start : inBed;
  const lastSleep = segs.filter((g) => g.stage !== "wake").at(-1);
  const disturbances = segs.filter((g) => g.stage === "wake" && firstSleep && g.start > firstSleep.start && lastSleep && g.end <= lastSleep.end).length;
  let cycles = 0;
  for (let i = 1; i < segs.length; i++) if (segs[i]!.stage === "rem" && segs[i - 1]!.stage !== "rem" && segs[i]!.end - segs[i]!.start >= 3 * MIN) cycles++;

  const { hrv, rhr } = weightedNightVitals(s, segs, period);

  // respiratory rate: median over 5-min still NREM windows
  const resp: number[] = [];
  for (const g of segs) {
    if (g.stage !== "deep" && g.stage !== "light") continue;
    for (let t = g.start; t + 300 <= g.end; t += 300) {
      const rr = cleanRR(beatsIn(s, t, t + 300));
      const v = respiratoryRateFromRR(rr);
      if (Number.isFinite(v)) resp.push(v);
    }
  }

  const i0 = period.start - s.start;
  const temps: number[] = [];
  const hrs: number[] = [];
  for (let i = i0; i < i0 + inBed; i++) {
    if (Number.isFinite(s.tempC[i]!)) temps.push(s.tempC[i]!);
    if (Number.isFinite(s.hr[i]!)) hrs.push(s.hr[i]!);
  }
  // lowest 5-minute rolling mean HR
  let lowest: number | null = null;
  for (let i = 0; i + 300 <= hrs.length; i += 60) {
    const m = mean(hrs.slice(i, i + 300));
    if (lowest === null || m < lowest) lowest = m;
  }

  return {
    start: period.start,
    end: period.end,
    nap: period.nap,
    inBed,
    asleep,
    awake,
    light: dur("light"),
    deep: dur("deep"),
    rem: dur("rem"),
    latency,
    disturbances,
    cycles,
    efficiency: inBed ? asleep / inBed : 0,
    restorative: asleep ? (dur("deep") + dur("rem")) / asleep : 0,
    hrv,
    rhr,
    respRate: resp.length >= 3 ? median(resp) : null,
    skinTemp: temps.length ? median(temps) : null,
    spo2: spo2During(s, period),
    avgHr: hrs.length ? mean(hrs) : null,
    lowestHr: lowest,
  };
}

/**
 * Ratio-of-ratios SpO2 over 30 s windows (AC = std, DC = mean of the raw
 * red/IR samples), SpO2 = 110 − 25·R, median over the night. The constants
 * are the textbook transmissive-oximetry calibration, not a WHOOP-specific
 * one, so treat the absolute value as an estimate.
 */
export function spo2During(s: Series, period: SleepPeriod): number | null {
  const vals: number[] = [];
  const i0 = period.start - s.start;
  for (let i = i0; i + 30 <= i0 + (period.end - period.start); i += 30) {
    const red: number[] = [];
    const ir: number[] = [];
    for (let k = i; k < i + 30; k++) {
      if (Number.isFinite(s.spo2Red[k]!) && Number.isFinite(s.spo2Ir[k]!)) {
        red.push(s.spo2Red[k]!);
        ir.push(s.spo2Ir[k]!);
      }
    }
    if (red.length < 20) continue;
    const mr = mean(red), mi = mean(ir);
    const sr = Math.sqrt(mean(red.map((x) => (x - mr) ** 2)));
    const si = Math.sqrt(mean(ir.map((x) => (x - mi) ** 2)));
    if (!mr || !mi || !si) continue;
    const R = sr / mr / (si / mi);
    vals.push(clamp(110 - 25 * R, 70, 100));
  }
  return vals.length >= 10 ? median(vals) : null;
}
