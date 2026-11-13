// RR-interval cleaning and time/frequency-domain HRV.
import { mean, median, std } from "./stats.ts";

/**
 * Remove physiologically impossible intervals and ectopic/missed beats.
 * Range gate 300-2000 ms, then a local-median rule: drop beats that differ
 * from the median of their 9 neighbours by more than 20% (a robust variant of
 * the Malik criterion used by Kubios-style artifact correction).
 */
export function cleanRR(rr: ArrayLike<number>): number[] {
  const inRange = Array.from(rr).filter((x) => x >= 300 && x <= 2000);
  const out: number[] = [];
  for (let i = 0; i < inRange.length; i++) {
    const lo = Math.max(0, i - 4);
    const hi = Math.min(inRange.length, i + 5);
    const m = median(inRange.slice(lo, hi));
    if (Math.abs(inRange[i]! - m) <= 0.2 * m) out.push(inRange[i]!);
  }
  return out;
}

/** RMSSD in ms over successive *clean* intervals. */
export function rmssd(rr: ArrayLike<number>): number {
  if (rr.length < 3) return NaN;
  let s = 0;
  for (let i = 1; i < rr.length; i++) s += (rr[i]! - rr[i - 1]!) ** 2;
  return Math.sqrt(s / (rr.length - 1));
}

export const sdnn = (rr: ArrayLike<number>) => std(rr);
export const meanHr = (rr: ArrayLike<number>) => 60000 / mean(rr);

/**
 * Respiratory rate from respiratory sinus arrhythmia: resample the RR series
 * to 4 Hz, remove the trend, and find the dominant spectral peak in the
 * 0.1-0.5 Hz band (6-30 breaths/min). Works best on still, regular segments
 * (deep sleep). Returns breaths/min or NaN.
 */
export function respiratoryRateFromRR(rr: ArrayLike<number>): number {
  if (rr.length < 60) return NaN;
  const t: number[] = [];
  let acc = 0;
  for (let i = 0; i < rr.length; i++) {
    acc += rr[i]! / 1000;
    t.push(acc);
  }
  const fs = 4;
  const n = Math.floor((t[t.length - 1]! - t[0]!) * fs);
  if (n < 120) return NaN;
  const series = new Float64Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const tk = t[0]! + k / fs;
    while (j < t.length - 2 && t[j + 1]! < tk) j++;
    const f = (tk - t[j]!) / (t[j + 1]! - t[j]!);
    series[k] = rr[j]! + f * (rr[j + 1]! - rr[j]!);
  }
  // detrend with a 10 s moving average, then Hann window
  const w = fs * 10;
  const detr = new Float64Array(n);
  let run = 0;
  for (let k = 0; k < n; k++) {
    run += series[k]!;
    if (k >= w) run -= series[k - w]!;
    detr[k] = series[k]! - run / Math.min(k + 1, w);
  }
  for (let k = 0; k < n; k++) detr[k]! *= 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
  let bestF = NaN;
  let bestP = 0;
  for (let f = 0.1; f <= 0.5; f += 0.005) {
    let re = 0, im = 0;
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * f * k) / fs;
      re += detr[k]! * Math.cos(a);
      im -= detr[k]! * Math.sin(a);
    }
    const p = re * re + im * im;
    if (p > bestP) {
      bestP = p;
      bestF = f;
    }
  }
  return bestF * 60;
}
