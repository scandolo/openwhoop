// Strain (0-21), heart-rate zones and calories.
//
// Load is time-in-zone weighted by intensity (%HRR, WHOOP's zone definition:
// zone k starts at 40 + 10k % of heart-rate reserve), and strain is a
// logarithmic function of load. Zone weights, A and B are fitted to WHOOP
// activity strain (docs/calibration.md). Below zone 1 the weight ramps up
// from 20% to 40% HRR so walking counts and sitting does not.
import { CALIBRATION } from "./calibration.ts";
import { clamp } from "./stats.ts";

const { zoneWeights, A, B } = CALIBRATION.strain;

/** Gellish et al. (2007) non-linear max-HR estimate, the formula WHOOP cites. */
export const gellishMaxHr = (age: number) => Math.round(192 - 0.007 * age * age);

export const hrrFraction = (hr: number, rhr: number, maxHr: number) => (hr - rhr) / Math.max(1, maxHr - rhr);

/** Zone 0-5 from %HRR: Z1 50-60, Z2 60-70, Z3 70-80, Z4 80-90, Z5 90-100. */
export function zoneOf(x: number): number {
  if (x < 0.5) return 0;
  return Math.min(5, Math.floor((x - 0.4) * 10));
}

/** Load (weighted minutes) contributed by one minute at intensity x. */
export function loadWeight(x: number): number {
  if (x >= 0.5) return zoneWeights[zoneOf(x)]!;
  return zoneWeights[0]! * clamp((x - 0.2) / 0.2, 0, 1);
}

const softcap = (s: number) => (s < 17 ? s : 17 + 4 * Math.tanh((s - 17) / 4));

export const strainFromLoad = (load: number) => clamp(softcap(A * Math.log(1 + Math.max(0, load) / B)), 0, 21);
export const loadFromStrain = (strain: number) => B * (Math.exp(strain / A) - 1);

export interface StrainResult {
  strain: number;
  load: number;
  zoneSeconds: number[]; // time in zones 0-5 (zone 0 = below 50% HRR)
  avgHr: number | null;
  maxHr: number | null;
  kcal: number;
}

export interface Physiology {
  restingHr: number;
  maxHr: number;
  weightKg: number;
  heightCm: number;
  age: number;
  sex: "male" | "female";
}

/** Mifflin–St Jeor basal metabolic rate, kcal/day. */
export function bmr(p: Physiology): number {
  return 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.sex === "male" ? 5 : -161);
}

/**
 * Energy per second (kcal). Basal rate at rest; above 30% HRR, the larger of
 * BMR and the Keytel et al. (2005) heart-rate equation. Like WHOOP, the
 * thermic effect of food is not included.
 */
export function kcalPerSecond(hr: number, p: Physiology): number {
  const base = bmr(p) / 86400;
  if (!(hr > 0) || hrrFraction(hr, p.restingHr, p.maxHr) < 0.3) return base;
  const kjPerMin = p.sex === "male"
    ? -55.0969 + 0.6309 * hr + 0.1988 * p.weightKg + 0.2017 * p.age
    : -20.4022 + 0.4472 * hr - 0.1263 * p.weightKg + 0.074 * p.age;
  return Math.max(base, kjPerMin / 4.184 / 60);
}

/** Strain for a span of per-second heart rate (NaN = missing). */
export function strainFromHr(hr: ArrayLike<number>, p: Physiology): StrainResult {
  let load = 0, kcal = 0, sum = 0, n = 0, max = 0;
  const zoneSeconds = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < hr.length; i++) {
    const h = hr[i]!;
    if (!(h > 0)) {
      kcal += bmr(p) / 86400;
      continue;
    }
    const x = hrrFraction(h, p.restingHr, p.maxHr);
    load += loadWeight(x) / 60;
    zoneSeconds[zoneOf(x)]!++;
    kcal += kcalPerSecond(h, p);
    sum += h;
    n++;
    if (h > max) max = h;
  }
  return { strain: strainFromLoad(load), load, zoneSeconds, avgHr: n ? sum / n : null, maxHr: n ? max : null, kcal };
}

export type StrainBand = "light" | "moderate" | "high" | "all_out";
export const strainBand = (s: number): StrainBand => (s < 10 ? "light" : s < 14 ? "moderate" : s < 18 ? "high" : "all_out");

/**
 * Strain target for the day from recovery (a "strain coach"). WHOOP does not
 * publish its mapping; this one targets light days in the red, moderate in
 * the yellow and high in the green, which matches its published guidance.
 */
export function strainTarget(recovery: number | null): { low: number; high: number } {
  if (recovery === null) return { low: 10, high: 14 };
  const mid = 6.5 + 0.11 * recovery;
  return { low: Math.round((mid - 1.5) * 10) / 10, high: Math.round((mid + 1.5) * 10) / 10 };
}
