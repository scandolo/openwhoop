// Small numeric helpers shared by the scoring algorithms.

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const logit = (p: number) => Math.log(p / (1 - p));

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return xs.length ? s / xs.length : NaN;
}

export function std(xs: ArrayLike<number>): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i]! - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

export function quantile(xs: ArrayLike<number>, q: number): number {
  if (!xs.length) return NaN;
  const a = Array.from(xs).sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo]! + (a[hi]! - a[lo]!) * (pos - lo);
}

export const median = (xs: ArrayLike<number>) => quantile(xs, 0.5);

/** Ordinary least squares on a design matrix (rows include the intercept column). */
export function ols(X: number[][], y: number[], ridge = 1e-6): number[] {
  const k = X[0]!.length;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let r = 0; r < X.length; r++) {
    const row = X[r]!;
    for (let i = 0; i < k; i++) {
      b[i]! += row[i]! * y[r]!;
      for (let j = 0; j < k; j++) A[i]![j]! += row[i]! * row[j]!;
    }
  }
  for (let i = 0; i < k; i++) A[i]![i]! += ridge;
  return solve(A, b);
}

/** Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - ma, db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

/** Deterministic PRNG (mulberry32) so simulations and tests are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = 1 - next();
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, normal, chance: (p: number) => next() < p, range: (lo: number, hi: number) => lo + (hi - lo) * next() };
}
export type Rng = ReturnType<typeof rng>;

/** Nelder–Mead minimiser for small nonlinear fits (calibration scripts). */
export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { step?: number; iters?: number } = {}): { x: number[]; fx: number } {
  const n = x0.length;
  const step = opts.step ?? 0.1;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + (Math.abs(v) > 1e-9 ? v * step : step) : v)))];
  let vals = simplex.map(f);
  for (let it = 0; it < (opts.iters ?? 2000 * n); it++) {
    const order = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    simplex = order.map((i) => simplex[i]!);
    vals = order.map((i) => vals[i]!);
    if (Math.abs(vals[n]! - vals[0]!) < 1e-10 * (Math.abs(vals[0]!) + 1e-10)) break;
    const c = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j]! += simplex[i]![j]! / n;
    const at = (t: number) => c.map((cj, j) => cj + t * (simplex[n]![j]! - cj));
    const xr = at(-1), fr = f(xr);
    if (fr < vals[0]!) {
      const xe = at(-2), fe = f(xe);
      [simplex[n], vals[n]] = fe < fr ? [xe, fe] : [xr, fr];
    } else if (fr < vals[n - 1]!) {
      [simplex[n], vals[n]] = [xr, fr];
    } else {
      const xc = at(fr < vals[n]! ? -0.5 : 0.5), fc = f(xc);
      if (fc < Math.min(fr, vals[n]!)) [simplex[n], vals[n]] = [xc, fc];
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i]!.map((v, j) => simplex[0]![j]! + 0.5 * (v - simplex[0]![j]!));
          vals[i] = f(simplex[i]!);
        }
      }
    }
  }
  const best = vals.indexOf(Math.min(...vals));
  return { x: simplex[best]!, fx: vals[best]! };
}
