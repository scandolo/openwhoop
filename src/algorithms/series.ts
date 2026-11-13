import { skinTempC, type HistoryRecord } from "../protocol/history.ts";

// Dense per-second arrays built from stored samples, and 30-second epochs
// derived from them. Everything downstream (sleep, strain, stress) reads these.

/** A stored second, as kept in the database. */
export interface SampleRow {
  ts: number;
  hr: number; // 0 = missing
  rr: number[];
  gx: number | null;
  gy: number | null;
  gz: number | null;
  contact: number; // 1 on wrist
  tempC: number | null;
  spo2Red: number | null;
  spo2Ir: number | null;
}

export interface Series {
  start: number;
  length: number;
  hr: Float32Array; // NaN when missing / off wrist
  motion: Float32Array; // |Δgravity| per second in g, NaN when missing
  contact: Uint8Array;
  tempC: Float32Array;
  spo2Red: Float32Array;
  spo2Ir: Float32Array;
  beatT: Float64Array; // unix seconds at which each beat ended (approx.)
  beatRR: Float32Array; // ms
}

export function buildSeries(rows: SampleRow[], start: number, end: number): Series {
  const n = Math.max(0, end - start);
  const s: Series = {
    start,
    length: n,
    hr: new Float32Array(n).fill(NaN),
    motion: new Float32Array(n).fill(NaN),
    contact: new Uint8Array(n),
    tempC: new Float32Array(n).fill(NaN),
    spo2Red: new Float32Array(n).fill(NaN),
    spo2Ir: new Float32Array(n).fill(NaN),
    beatT: new Float64Array(0),
    beatRR: new Float32Array(0),
  };
  const bt: number[] = [];
  const br: number[] = [];
  let prev: SampleRow | undefined;
  for (const r of rows) {
    const i = r.ts - start;
    if (i < 0 || i >= n) continue;
    const on = r.contact === 1;
    s.contact[i] = on ? 1 : 0;
    if (on && r.hr > 0) s.hr[i] = r.hr;
    if (on && r.tempC !== null) s.tempC[i] = r.tempC;
    if (on && r.spo2Red && r.spo2Ir) {
      s.spo2Red[i] = r.spo2Red;
      s.spo2Ir[i] = r.spo2Ir;
    }
    if (r.gx !== null && prev && prev.gx !== null && prev.ts === r.ts - 1) {
      s.motion[i] = Math.hypot(r.gx - prev.gx, (r.gy ?? 0) - (prev.gy ?? 0), (r.gz ?? 0) - (prev.gz ?? 0));
    } else if (r.gx !== null) s.motion[i] = 0;
    if (on && r.rr.length) {
      let t = r.ts + 1;
      const local: number[] = [];
      for (let k = r.rr.length - 1; k >= 0; k--) {
        local.unshift(t);
        t -= r.rr[k]! / 1000;
      }
      for (let k = 0; k < r.rr.length; k++) {
        bt.push(local[k]!);
        br.push(r.rr[k]!);
      }
    }
    prev = r;
  }
  s.beatT = Float64Array.from(bt);
  s.beatRR = Float32Array.from(br);
  return s;
}

/** Index range [lo, hi) of beats whose timestamps fall in [t0, t1). */
export function beatRange(s: Series, t0: number, t1: number): [number, number] {
  const find = (t: number) => {
    let lo = 0, hi = s.beatT.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.beatT[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return [find(t0), find(t1)];
}

export function beatsIn(s: Series, t0: number, t1: number): number[] {
  const [a, b] = beatRange(s, t0, t1);
  return Array.from(s.beatRR.subarray(a, b));
}

export interface Epoch {
  t: number; // start (unix s)
  hr: number; // mean bpm, NaN if no data
  hrSd: number; // within-epoch HR instability
  motion: number; // summed |Δg| (activity count proxy)
  moves: number; // seconds with motion > 0.05 g
  contact: number; // fraction on wrist
  rmssd: number; // ms, from clean beats in a centred 5-minute window
}

export const EPOCH = 30;

/**
 * Artifact-free beats for the whole series, cleaned once. `pair[i]` is 1 when
 * beat i directly follows beat i-1 (no beat removed in between), so successive
 * differences are only taken across real neighbours.
 */
export function cleanBeats(s: Series) {
  const keep: number[] = [];
  const n = s.beatRR.length;
  for (let i = 0; i < n; i++) {
    const x = s.beatRR[i]!;
    if (x < 300 || x > 2000) continue;
    const nb: number[] = [];
    for (let k = Math.max(0, i - 4); k < Math.min(n, i + 5); k++) {
      const y = s.beatRR[k]!;
      if (y >= 300 && y <= 2000 && Math.abs(s.beatT[k]! - s.beatT[i]!) < 15) nb.push(y);
    }
    nb.sort((a, b) => a - b);
    const m = nb[nb.length >> 1]!;
    if (Math.abs(x - m) <= 0.2 * m) keep.push(i);
  }
  const t = new Float64Array(keep.length);
  const rr = new Float32Array(keep.length);
  const pair = new Uint8Array(keep.length);
  keep.forEach((idx, j) => {
    t[j] = s.beatT[idx]!;
    rr[j] = s.beatRR[idx]!;
    pair[j] = j > 0 && keep[j - 1] === idx - 1 && t[j]! - t[j - 1]! < 3 ? 1 : 0;
  });
  return { t, rr, pair };
}

export function epochs(s: Series, t0 = s.start, t1 = s.start + s.length): Epoch[] {
  const beats = cleanBeats(s);
  // prefix sums of squared successive differences, for O(1) windowed RMSSD
  const n = beats.t.length;
  const sq = new Float64Array(n + 1);
  const cnt = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const d = beats.pair[i] ? (beats.rr[i]! - beats.rr[i - 1]!) ** 2 : 0;
    sq[i + 1] = sq[i]! + d;
    cnt[i + 1] = cnt[i]! + beats.pair[i]!;
  }
  const lower = (x: number) => {
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats.t[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const out: Epoch[] = [];
  for (let t = t0; t + EPOCH <= t1; t += EPOCH) {
    const i0 = t - s.start;
    let hs = 0, hss = 0, hn = 0, motion = 0, moves = 0, contact = 0;
    for (let i = i0; i < i0 + EPOCH; i++) {
      const h = s.hr[i]!;
      if (h === h) {
        hs += h;
        hss += h * h;
        hn++;
      }
      const m = s.motion[i]!;
      if (m === m) {
        motion += m;
        if (m > 0.05) moves++;
      }
      contact += s.contact[i]!;
    }
    const a = lower(t - 135) + 1;
    const b = lower(t + 165);
    const pairs = b > a ? cnt[b]! - cnt[a]! : 0;
    const hrMean = hn ? hs / hn : NaN;
    out.push({
      t,
      hr: hn >= 10 ? hrMean : NaN,
      hrSd: hn >= 10 ? Math.sqrt(Math.max(0, (hss - hn * hrMean * hrMean) / (hn - 1))) : NaN,
      motion,
      moves,
      contact: contact / EPOCH,
      rmssd: pairs >= 40 ? Math.sqrt((sq[b]! - sq[a]!) / pairs) : NaN,
    });
  }
  return out;
}

/** Convert a decoded strap record to its stored form. HR 0 means off wrist. */
export function recordToSample(r: HistoryRecord): SampleRow {
  const s = r.sensor;
  return {
    ts: r.ts,
    hr: r.hr,
    rr: r.rr,
    gx: s ? s.gravity[0] : null,
    gy: s ? s.gravity[1] : null,
    gz: s ? s.gravity[2] : null,
    contact: r.hr > 0 ? 1 : 0,
    tempC: s ? skinTempC(s.skinTempRaw) : null,
    spo2Red: s && s.spo2Red > 0 ? s.spo2Red : null,
    spo2Ir: s && s.spo2Ir > 0 ? s.spo2Ir : null,
  };
}
