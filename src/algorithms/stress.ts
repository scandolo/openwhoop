// Stress monitor (0-3), per minute.
//
// WHOOP: "HR and HRV compared with your personalised baseline from the past
// 14 days, and any motion is taken into account"; bands 0-1 low, 1-2 medium,
// 2-3 high. Here: a z-score of heart rate (up = stress) and ln RMSSD
// (down = stress) against the 14-day distribution of still, awake,
// non-workout minutes, mapped so the personal median sits at 1.0.
// Minutes with movement or inside a workout get no score.
import { clamp, median, quantile } from "./stats.ts";

export interface StressMinute {
  t: number;
  hr: number; // NaN when missing
  lnRmssd: number; // NaN when missing
  moving: boolean;
  asleep: boolean;
  workout: boolean;
}

export interface StressBaseline {
  hr: number;
  hrScale: number;
  lnR: number;
  lnRScale: number;
  minutes: number;
}

/** Build the baseline from (up to) 14 days of minutes. */
export function stressBaseline(mins: StressMinute[]): StressBaseline | null {
  const calm = mins.filter((m) => !m.moving && !m.asleep && !m.workout && m.hr > 0);
  if (calm.length < 240) return null;
  const hrs = calm.map((m) => m.hr);
  const lnr = calm.filter((m) => Number.isFinite(m.lnRmssd)).map((m) => m.lnRmssd);
  if (lnr.length < 120) return null;
  const iqr = (xs: number[]) => (quantile(xs, 0.75) - quantile(xs, 0.25)) / 1.349;
  return { hr: median(hrs), hrScale: Math.max(3, iqr(hrs)), lnR: median(lnr), lnRScale: Math.max(0.1, iqr(lnr)), minutes: calm.length };
}

/** Raw stress per minute (null where it can't be scored), then a 5-minute smoothing. */
export function stressSeries(mins: StressMinute[], b: StressBaseline): (number | null)[] {
  const raw = mins.map((m) => {
    if (m.moving || m.workout || !(m.hr > 0)) return null;
    const zHr = (m.hr - b.hr) / b.hrScale;
    const zR = Number.isFinite(m.lnRmssd) ? (b.lnR - m.lnRmssd) / b.lnRScale : zHr;
    const z = 0.55 * zHr + 0.45 * zR;
    return clamp((m.asleep ? 0.4 : 1.0) + 0.8 * z, 0, 3);
  });
  return raw.map((v, i) => {
    if (v === null) return null;
    let s = 0, n = 0;
    for (let k = Math.max(0, i - 4); k <= i; k++) {
      const x = raw[k];
      if (x !== null && x !== undefined) {
        s += x;
        n++;
      }
    }
    return Math.round((s / n) * 100) / 100;
  });
}

export type StressBand = "low" | "medium" | "high";
export const stressBand = (s: number): StressBand => (s < 1 ? "low" : s < 2 ? "medium" : "high");

/** Episodes of sustained high stress (≥ 2.0 for ≥ minMinutes, gaps ≤ 2 min tolerated). */
export function highStressEpisodes(t: number[], stress: (number | null)[], minMinutes = 10): { start: number; end: number; peak: number }[] {
  const out: { start: number; end: number; peak: number }[] = [];
  let start = -1, last = -1, peak = 0;
  for (let i = 0; i <= stress.length; i++) {
    const s = stress[i];
    const high = s !== null && s !== undefined && s >= 2;
    if (high) {
      if (start < 0) {
        start = i;
        peak = 0;
      }
      last = i;
      peak = Math.max(peak, s!);
    } else if (start >= 0 && (i - last > 2 || i === stress.length)) {
      if (last - start + 1 >= minMinutes) out.push({ start: t[start]!, end: t[last]! + 60, peak });
      start = -1;
    }
  }
  return out;
}
