// Fit OpenWhoop's score models to real WHOOP app exports.
//
//   npm run calibrate -- <dir-with-exports> [--write]
//
// <dir> is searched recursively for folders containing physiological_cycles.csv
// (the WHOOP "Data Export" layout). Every model is scored with
// leave-one-person-out cross-validation; the final constants are fitted on all
// people. With --write, they are saved to src/algorithms/calibration.ts and
// the report to docs/calibration.md. Raw exports are never copied.
import { writeFileSync } from "node:fs";
import { findExports, readExport, type WhoopExport } from "../src/server/whoop-export.ts";
import { logit, mean, median, nelderMead, ols, pearson, sigmoid } from "../src/algorithms/stats.ts";

const root = process.argv[2];
if (!root) {
  console.error("usage: npm run calibrate -- <dir-with-whoop-exports> [--write]");
  process.exit(1);
}
const write = process.argv.includes("--write");
const MAY_2025 = Date.parse("2025-05-01") / 1000;
const exps: WhoopExport[] = findExports(root)
  .map((d, i) => readExport(d, `person-${i + 1}`))
  .filter((e) => e.cycles.length > 60);
const report: string[] = [];
const log = (s: string) => {
  console.log(s);
  report.push(s);
};
log(`Exports: ${exps.length} people, ${exps.reduce((a, e) => a + e.cycles.length, 0)} cycles, ${exps.reduce((a, e) => a + e.workouts.length, 0)} workouts.`);

function lopo<T extends { person: string }>(rows: T[], fit: (train: T[]) => (r: T) => number, target: (r: T) => number) {
  const people = [...new Set(rows.map((r) => r.person))].filter((p) => rows.filter((r) => r.person === p).length >= 50);
  const errs: number[] = [];
  const rs: number[] = [];
  for (const p of people) {
    const test = rows.filter((r) => r.person === p);
    const model = fit(rows.filter((r) => r.person !== p));
    errs.push(...test.map((r) => Math.abs(model(r) - target(r))));
    rs.push(pearson(test.map(model), test.map(target)));
  }
  return { mae: mean(errs), rMedian: median(rs), people: people.length };
}

// ── Recovery ───────────────────────────────────────────────────────────
// logit(recovery) = b0 + b1·Δln(HRV) + b2·ΔRHR + b3·Δresp + b4·sleepPerf,
// Δ against an exponentially weighted personal baseline (half-life H days).
const HALF_LIFE = 7;
type RecRow = { person: string; rec: number; x: number[] };
const recRows: RecRow[] = [];
for (const e of exps) {
  const a = 1 - 0.5 ** (1 / HALF_LIFE);
  let bh = NaN, br = NaN, bp = NaN, n = 0;
  for (const c of e.cycles) {
    if (c.recovery === null || !c.hrv || !c.rhr || !c.resp) continue;
    const lh = Math.log(c.hrv);
    if (n >= 4) recRows.push({ person: e.name, rec: c.recovery, x: [1, lh - bh, c.rhr - br, c.resp - bp, Math.min(1, (c.sleepPerf ?? 80) / 100)] });
    if (Number.isNaN(bh)) [bh, br, bp] = [lh, c.rhr, c.resp];
    else {
      bh += a * (lh - bh);
      br += a * (c.rhr - br);
      bp += a * (c.resp - bp);
    }
    n++;
  }
}
const fitRecovery = (rows: RecRow[]) => {
  const w = ols(rows.map((r) => r.x), rows.map((r) => logit(Math.min(99, Math.max(1, r.rec)) / 100)));
  return (r: RecRow) => 100 * sigmoid(r.x.reduce((s, x, i) => s + x * w[i]!, 0));
};
const recCv = lopo(recRows, fitRecovery, (r) => r.rec);
const recW = ols(recRows.map((r) => r.x), recRows.map((r) => logit(Math.min(99, Math.max(1, r.rec)) / 100)));
log(`Recovery: n=${recRows.length}, LOPO MAE ${recCv.mae.toFixed(2)} pts, median within-person r ${recCv.rMedian.toFixed(2)} (${recCv.people} held-out people).`);

// ── Strain ─────────────────────────────────────────────────────────────
// load = Σ_zone minutes·w_z (zone 0 = time below zone 1 inside the workout),
// strain = softcap(A·ln(1 + load/B)); monotone zone weights, w1 = 1.
type WRow = { person: string; strain: number; mins: number[] };
const wRows: WRow[] = exps.flatMap((e) =>
  e.workouts
    .filter((w) => w.strain !== null && w.end > w.start)
    .map((w) => {
      const dur = (w.end - w.start) / 60;
      const z = w.zones.map((p) => (dur * p) / 100);
      return { person: e.name, strain: w.strain!, mins: [Math.max(0, dur - z.reduce((a, b) => a + b, 0)), ...z] };
    }),
);
const softcap = (s: number) => (s < 17 ? s : 17 + 4 * Math.tanh((s - 17) / 4));
const zoneWeights = (p: number[]) => {
  const w = [Math.exp(p[0]!), 1];
  for (let z = 2; z <= 5; z++) w.push(w[z - 1]! + Math.exp(p[z - 1]!));
  return w;
};
const strainOf = (p: number[], mins: number[]) => {
  const w = zoneWeights(p);
  return softcap(p[5]! * Math.log(1 + mins.reduce((s, m, i) => s + m * w[i]!, 0) / Math.abs(p[6]!)));
};
const fitStrainParams = (rows: WRow[]) => nelderMead((p) => mean(rows.map((r) => (strainOf(p, r.mins) - r.strain) ** 2)), [-2, -1, 0, 1, 1.5, 3.7, 3.5], { iters: 20000 }).x;
const strainCv = lopo(wRows, (tr) => {
  const p = fitStrainParams(tr);
  return (r) => strainOf(p, r.mins);
}, (r) => r.strain);
const sp = fitStrainParams(wRows);
const sw = zoneWeights(sp);
log(`Strain: n=${wRows.length} workouts, LOPO MAE ${strainCv.mae.toFixed(2)}, median within-person r ${strainCv.rMedian.toFixed(2)}.`);

// ── Sleep need ─────────────────────────────────────────────────────────
// need = baseline_person + d·debt + s1·max(0, strain−10) + s2·max(0, strain−14) − n·naps
type NRow = { person: string; need: number; x: number[] };
const needRows: NRow[] = [];
const people = exps.map((e) => e.name);
for (const e of exps) {
  const cs = e.cycles;
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!, prev = cs[i - 1]!;
    if (c.need === null || c.debt === null || prev.dayStrain === null || c.start >= MAY_2025) continue;
    const nap = e.sleeps.filter((s) => s.nap && s.start >= prev.start && s.start < c.start).reduce((a, s) => a + (s.asleep ?? 0), 0);
    const dummies = people.map((p) => (p === e.name ? 1 : 0));
    needRows.push({ person: e.name, need: c.need, x: [...dummies, c.debt, Math.max(0, prev.dayStrain - 10), Math.max(0, prev.dayStrain - 14), nap] });
  }
}
const needW = ols(needRows.map((r) => r.x), needRows.map((r) => r.need));
const k = people.length;
const baselines = needW.slice(0, k).filter((_, i) => needRows.some((r) => r.x[i] === 1));
const needMae = mean(needRows.map((r) => Math.abs(r.x.reduce((s, x, i) => s + x * needW[i]!, 0) - r.need)));
log(`Sleep need: n=${needRows.length} nights (pre-May-2025), in-sample MAE ${needMae.toFixed(1)} min; personal baselines ${baselines.map((b) => (b / 60).toFixed(2) + "h").join(", ")}.`);

// ── Sleep debt ─────────────────────────────────────────────────────────
// debt = max(0, a·Σ_{k=1..5} r^(k−1)·(need_k − asleep_k − naps_k))
type DRow = { person: string; debt: number; def: number[] };
const debtRows: DRow[] = [];
for (const e of exps) {
  const cs = e.cycles;
  for (let i = 5; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.debt === null) continue;
    const def: number[] = [];
    for (let j = 1; j <= 5; j++) {
      const p = cs[i - j]!;
      if (p.need === null || p.asleep === null || c.start - p.start > (j + 1.5) * 86400) break;
      const nap = e.sleeps.filter((s) => s.nap && s.start >= p.start && s.start < cs[i - j + 1]!.start).reduce((a, s) => a + (s.asleep ?? 0), 0);
      def.push(p.need - p.asleep - nap);
    }
    if (def.length === 5) debtRows.push({ person: e.name, debt: c.debt, def });
  }
}
const debtOf = (p: number[], def: number[]) => Math.max(0, def.reduce((s, d, i) => s + p[0]! * p[1]! ** i * d, 0));
const debtP = nelderMead((p) => mean(debtRows.map((r) => (debtOf(p, r.def) - r.debt) ** 2)), [0.5, 0.5]).x;
const debtCv = lopo(debtRows, (tr) => {
  const p = nelderMead((q) => mean(tr.map((r) => (debtOf(q, r.def) - r.debt) ** 2)), [0.5, 0.5]).x;
  return (r) => debtOf(p, r.def);
}, (r) => r.debt);
log(`Sleep debt: n=${debtRows.length}, LOPO MAE ${debtCv.mae.toFixed(1)} min.`);

// ── Sleep performance (post-May-2025 formula) ──────────────────────────
// perf = 100 − p_s·(100 − sufficiency) − p_e·(100 − efficiency) − p_c·(100 − consistency)
type PRow = { person: string; y: number; s: number; e: number; c: number };
const perfRows: PRow[] = exps.flatMap((e) =>
  e.cycles
    .filter((c) => c.start >= MAY_2025 && c.sleepPerf !== null && c.asleep && c.need && c.efficiency !== null && c.consistency !== null)
    .map((c) => ({ person: e.name, y: c.sleepPerf!, s: Math.min(100, (100 * c.asleep!) / c.need!), e: c.efficiency!, c: c.consistency! })),
);
const perfOf = (p: number[], r: PRow) => Math.max(0, Math.min(100, 100 - p[0]! * (100 - r.s) - p[1]! * (100 - r.e) - p[2]! * (100 - r.c)));
const perfP = nelderMead((p) => mean(perfRows.map((r) => (perfOf(p, r) - r.y) ** 2)), [0.5, 0.6, 0.3]).x;
const preCount = exps.reduce((a, e) => a + e.cycles.filter((c) => c.start < MAY_2025 && c.sleepPerf !== null).length, 0);
const perfCv = lopo(perfRows, (tr) => {
  const p = nelderMead((q) => mean(tr.map((r) => (perfOf(q, r) - r.y) ** 2)), [0.5, 0.6, 0.3]).x;
  return (r) => perfOf(p, r);
}, (r) => r.y);
log(`Sleep performance: pre-May-2025 equals min(100, asleep/need) (${preCount} nights); post-May penalty model n=${perfRows.length}, LOPO MAE ${perfCv.mae.toFixed(2)}.`);

// ── Sleep consistency ──────────────────────────────────────────────────
// y = c0 + c1·(% of 5-min clock slots where sleep/wake state matches on all 4 days)
type CRow = { person: string; y: number; same: number };
const consRows: CRow[] = [];
for (const e of exps) {
  const cs = e.cycles.filter((c) => c.sleepOnset && c.wakeOnset);
  for (let i = 3; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.consistency === null || c.start - cs[i - 3]!.start > 5 * 86400) continue;
    consRows.push({ person: e.name, y: c.consistency, same: stateAgreement(cs.slice(i - 3, i + 1).map((w) => [w.sleepOnset!, w.wakeOnset!] as [number, number])) });
  }
}
const consW = ols(consRows.map((r) => [1, r.same]), consRows.map((r) => r.y));
const consCv = lopo(consRows, (tr) => {
  const w = ols(tr.map((r) => [1, r.same]), tr.map((r) => r.y));
  return (r) => w[0]! + w[1]! * r.same;
}, (r) => r.y);
log(`Sleep consistency: n=${consRows.length}, LOPO MAE ${consCv.mae.toFixed(2)}.`);

/** % of 5-minute slots in a 24 h clock where every night agrees on asleep vs awake (times compared in UTC). */
function stateAgreement(nights: [number, number][]): number {
  let same = 0;
  for (let m = 0; m < 1440; m += 5) {
    const st = nights.map(([on, off]) => {
      const day = Math.floor(off / 86400) * 86400;
      return [day - 86400, day].some((b) => b + m * 60 >= on && b + m * 60 < off) ? 1 : 0;
    });
    if (st.every((s) => s === st[0])) same++;
  }
  return (100 * same) / 288;
}

// ── output ─────────────────────────────────────────────────────────────
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const constants = {
  recovery: { baselineHalfLifeDays: HALF_LIFE, intercept: r3(recW[0]!), lnHrv: r3(recW[1]!), rhr: r3(recW[2]!), resp: r3(recW[3]!), sleepPerf: r3(recW[4]!) },
  strain: { zoneWeights: sw.map(r3), A: r3(sp[5]!), B: r3(Math.abs(sp[6]!)) },
  sleepNeed: { defaultBaselineMin: Math.round(median(baselines)), debt: r3(needW[k]!), strainAbove10: r3(needW[k + 1]!), strainAbove14: r3(needW[k + 2]!), naps: r3(needW[k + 3]!) },
  sleepDebt: { weight: r3(debtP[0]!), decay: r3(debtP[1]!) },
  sleepPerformance: { sufficiency: r3(perfP[0]!), efficiency: r3(perfP[1]!), consistency: r3(perfP[2]!) },
  sleepConsistency: { intercept: r3(consW[0]!), agreement: r3(consW[1]!) },
};
console.log(JSON.stringify(constants, null, 2));

if (write) {
  writeFileSync(
    new URL("../src/algorithms/calibration.ts", import.meta.url),
    `// Generated by \`npm run calibrate\` from ${exps.length} people's WHOOP exports — do not edit by hand.\n// Fit quality: see docs/calibration.md.\nexport const CALIBRATION = ${JSON.stringify(constants, null, 2)} as const;\n`,
  );
  writeFileSync(new URL("../docs/calibration.md", import.meta.url), `# Calibration report\n\nGenerated by \`npm run calibrate\` on ${new Date().toISOString().slice(0, 10)}. MAE = mean absolute error; LOPO = leave-one-person-out cross-validation (the model never saw the person it is scored on).\n\n${report.map((l) => `- ${l}`).join("\n")}\n\n## Constants\n\n\`\`\`json\n${JSON.stringify(constants, null, 2)}\n\`\`\`\n`);
  console.log("wrote src/algorithms/calibration.ts and docs/calibration.md");
}
