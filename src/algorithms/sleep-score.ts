// Sleep need, sleep debt, sleep consistency and sleep performance.
// All constants are fitted to WHOOP exports (docs/calibration.md).
import { CALIBRATION } from "./calibration.ts";
import { clamp } from "./stats.ts";

const N = CALIBRATION.sleepNeed;
const D = CALIBRATION.sleepDebt;
const P = CALIBRATION.sleepPerformance;
const K = CALIBRATION.sleepConsistency;

export interface PastNight {
  needMin: number;
  asleepMin: number;
  napMin: number; // naps taken during the cycle that followed this night
}

/** Unmet need from up to 5 previous nights, newest first, with decay. */
export function sleepDebt(previous: PastNight[]): number {
  let debt = 0;
  previous.slice(0, 5).forEach((n, i) => {
    debt += D.weight * D.decay ** i * (n.needMin - n.asleepMin - n.napMin);
  });
  return Math.max(0, debt);
}

export interface NeedBreakdown {
  baseline: number;
  debt: number;
  strain: number;
  naps: number;
  total: number; // minutes
}

/** Tonight's sleep need, from the baseline, debt, the day's strain and naps. */
export function sleepNeed(baselineMin: number, debtMin: number, dayStrain: number, napMin: number): NeedBreakdown {
  const strain = N.strainAbove10 * Math.max(0, dayStrain - 10) + N.strainAbove14 * Math.max(0, dayStrain - 14);
  const debt = N.debt * debtMin;
  const naps = N.naps * napMin; // negative coefficient
  return { baseline: baselineMin, debt, strain, naps, total: Math.max(240, baselineMin + debt + strain + naps) };
}

export const DEFAULT_SLEEP_NEED_MIN = N.defaultBaselineMin;

/**
 * WHOOP's definition: how likely your sleep/wake state is the same at a given
 * clock time across four consecutive days. Computed on 5-minute slots of a
 * 24 h clock in the user's time zone, then mapped onto WHOOP's scale.
 * `nights` are [onset, wake] in local seconds (unix + UTC offset).
 */
export function sleepConsistency(nights: [number, number][]): number | null {
  if (nights.length < 4) return null;
  const last4 = nights.slice(-4);
  let same = 0;
  for (let m = 0; m < 1440; m += 5) {
    const st = last4.map(([on, off]) => {
      const day = Math.floor(off / 86400) * 86400;
      return [day - 86400, day].some((b) => b + m * 60 >= on && b + m * 60 < off) ? 1 : 0;
    });
    if (st.every((s) => s === st[0])) same++;
  }
  return Math.round(clamp(K.intercept + K.agreement * ((100 * same) / 288), 0, 100));
}

/**
 * Sleep performance, WHOOP's 2025 definition: hours-vs-needed penalised by
 * poor efficiency and consistency. Before 4 nights of history (no
 * consistency yet) it falls back to the classic hours-vs-needed ratio.
 */
export function sleepPerformance(asleepMin: number, needMin: number, efficiencyPct: number, consistencyPct: number | null): number {
  const sufficiency = Math.min(100, (100 * asleepMin) / needMin);
  if (consistencyPct === null) return Math.round(sufficiency);
  return Math.round(clamp(100 - P.sufficiency * (100 - sufficiency) - P.efficiency * (100 - efficiencyPct) - P.consistency * (100 - consistencyPct), 0, 100));
}

export type SleepBand = "optimal" | "sufficient" | "poor";
export const sleepBand = (perf: number): SleepBand => (perf >= 85 ? "optimal" : perf >= 70 ? "sufficient" : "poor");

/**
 * Sleep planner: when to go to bed to hit `goalPct` of tonight's need,
 * given your recent sleep efficiency and latency.
 */
export function recommendedBedtime(wakeAt: number, needMin: number, goalPct: number, efficiency: number, latencyMin: number): number {
  const inBedMin = (needMin * goalPct) / 100 / Math.max(0.7, efficiency) + latencyMin;
  return wakeAt - Math.round(inBedMin * 60);
}
