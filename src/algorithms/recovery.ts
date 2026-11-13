// Recovery (0-100%) from last night's HRV, resting heart rate, respiratory
// rate and sleep performance, each compared with a personal baseline.
// Functional form and weights are fitted to WHOOP recovery (docs/calibration.md):
//   recovery = 100·σ(b0 + b1·Δln HRV + b2·ΔRHR + b3·Δresp + b4·sleepPerf)
import { CALIBRATION } from "./calibration.ts";
import { sigmoid } from "./stats.ts";

const C = CALIBRATION.recovery;

export interface Baseline {
  lnHrv: number;
  rhr: number;
  resp: number;
  skinTemp: number | null;
  nights: number;
}

export interface NightVitals {
  hrv: number | null;
  rhr: number | null;
  resp: number | null;
  skinTemp: number | null;
}

/** Exponentially weighted baseline update (half-life in nights). */
export function updateBaseline(b: Baseline | null, v: NightVitals): Baseline | null {
  if (v.hrv === null || v.rhr === null) return b;
  const a = 1 - 0.5 ** (1 / C.baselineHalfLifeDays);
  const lnHrv = Math.log(v.hrv);
  if (!b) return { lnHrv, rhr: v.rhr, resp: v.resp ?? 15, skinTemp: v.skinTemp, nights: 1 };
  // skin temperature uses a slower (~30 night) baseline, like WHOOP's
  const at = 1 - 0.5 ** (1 / 21);
  return {
    lnHrv: b.lnHrv + a * (lnHrv - b.lnHrv),
    rhr: b.rhr + a * (v.rhr - b.rhr),
    resp: v.resp === null ? b.resp : b.resp + a * (v.resp - b.resp),
    skinTemp: v.skinTemp === null ? b.skinTemp : b.skinTemp === null ? v.skinTemp : b.skinTemp + at * (v.skinTemp - b.skinTemp),
    nights: b.nights + 1,
  };
}

export type RecoveryBand = "red" | "yellow" | "green";
export const recoveryBand = (r: number): RecoveryBand => (r >= 67 ? "green" : r >= 34 ? "yellow" : "red");

export interface RecoveryResult {
  score: number | null; // null while calibrating
  raw: number | null; // before any personal offset (what calibration fits against)
  band: RecoveryBand | null;
  calibrating: boolean;
  contributions: { hrv: number; rhr: number; resp: number; sleep: number }; // logit-scale terms, for the "why" view
  deltas: { hrvPct: number; rhr: number; resp: number; skinTemp: number | null };
}

/** WHOOP shows a coloured score after 3 recoveries; we need 3 baseline nights. */
export const CALIBRATION_NIGHTS = 3;

/** `offset` is a personal intercept shift (logit scale) learned from paired WHOOP scores. */
export function recovery(v: NightVitals, sleepPerformance: number, b: Baseline | null, offset = 0): RecoveryResult {
  const empty = { hrv: 0, rhr: 0, resp: 0, sleep: 0 };
  if (!b || v.hrv === null || v.rhr === null) {
    return { score: null, raw: null, band: null, calibrating: true, contributions: empty, deltas: { hrvPct: 0, rhr: 0, resp: 0, skinTemp: null } };
  }
  const dHrv = Math.log(v.hrv) - b.lnHrv;
  const dRhr = v.rhr - b.rhr;
  const dResp = v.resp === null ? 0 : v.resp - b.resp;
  const contributions = {
    hrv: C.lnHrv * dHrv,
    rhr: C.rhr * dRhr,
    resp: C.resp * dResp,
    sleep: C.sleepPerf * Math.min(1, sleepPerformance / 100),
  };
  const z = C.intercept + contributions.hrv + contributions.rhr + contributions.resp + contributions.sleep;
  const toScore = (x: number) => Math.round(Math.min(99, Math.max(1, 100 * sigmoid(x))));
  const score = toScore(z + offset);
  const deltas = {
    hrvPct: 100 * (Math.exp(dHrv) - 1),
    rhr: dRhr,
    resp: dResp,
    skinTemp: v.skinTemp !== null && b.skinTemp !== null ? v.skinTemp - b.skinTemp : null,
  };
  const calibrating = b.nights < CALIBRATION_NIGHTS;
  return { score: calibrating ? null : score, raw: calibrating ? null : toScore(z), band: calibrating ? null : recoveryBand(score), calibrating, contributions, deltas };
}

/**
 * Health-monitor style flag: several vitals off baseline at once is how
 * illness usually shows up (elevated RHR, respiratory rate and skin temp,
 * suppressed HRV). Thresholds are conservative, not diagnostic.
 */
export function vitalsOutOfRange(d: RecoveryResult["deltas"]): string[] {
  const out: string[] = [];
  if (d.rhr >= 5) out.push("resting heart rate");
  if (d.hrvPct <= -25) out.push("HRV");
  if (d.resp >= 1.0) out.push("respiratory rate");
  if (d.skinTemp !== null && Math.abs(d.skinTemp) >= 0.6) out.push("skin temperature");
  return out;
}
