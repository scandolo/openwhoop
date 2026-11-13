import { describe, expect, it } from "vitest";
import { simulate } from "../sim/synth.ts";
import { cleanRR, respiratoryRateFromRR, rmssd } from "./hrv.ts";
import { buildSeries, epochs, recordToSample } from "./series.ts";
import { detectSleep, sleepMetrics, stageSleep, STAGES } from "./sleep.ts";
import { gellishMaxHr, loadFromStrain, strainFromHr, strainFromLoad, strainTarget, zoneOf, loadWeight } from "./strain.ts";
import { recovery, recoveryBand, updateBaseline, type Baseline } from "./recovery.ts";
import { sleepConsistency, sleepDebt, sleepNeed, sleepPerformance } from "./sleep-score.ts";
import { highStressEpisodes } from "./stress.ts";
import { journalInsights, type JournalDay } from "./insights.ts";
import { nextLocalTime, shouldWake, type AlarmConfig } from "./alarm.ts";
import { rng } from "./stats.ts";

describe("hrv", () => {
  it("removes ectopic beats before RMSSD", () => {
    const rr = [1000, 1010, 990, 1005, 500, 995, 1000, 1700, 1002, 998];
    const clean = cleanRR(rr);
    expect(clean).not.toContain(500);
    expect(clean).not.toContain(1700);
    expect(rmssd(clean)).toBeLessThan(20);
  });

  it("recovers breathing rate from respiratory sinus arrhythmia", () => {
    const r = rng(1);
    const rr: number[] = [];
    let t = 0;
    while (t < 300) {
      const x = 950 + 45 * Math.sin(2 * Math.PI * 0.25 * t) + r.normal() * 8;
      rr.push(x);
      t += x / 1000;
    }
    expect(respiratoryRateFromRR(rr)).toBeCloseTo(15, 0);
  });
});

describe("strain", () => {
  const rhr = 55, max = 190;
  const hrAt = (x: number) => rhr + x * (max - rhr);
  const p = { restingHr: rhr, maxHr: max, weightKg: 75, heightCm: 180, age: 30, sex: "male" as const };

  it("uses WHOOP's %HRR zones", () => {
    expect(zoneOf(0.45)).toBe(0);
    expect(zoneOf(0.55)).toBe(1);
    expect(zoneOf(0.75)).toBe(3);
    expect(zoneOf(0.95)).toBe(5);
    expect(loadWeight(0.1)).toBe(0); // sitting doesn't count
  });

  it("matches WHOOP's published anchors", () => {
    // 1 h running ≈ 12.0 (WHOOP Strain Coach article)
    const run = strainFromHr(new Float32Array(3600).fill(hrAt(0.75)), p).strain;
    expect(run).toBeGreaterThan(10.5);
    expect(run).toBeLessThan(13.5);
    // two marathons barely move the needle above one (20.4 → 20.6)
    const one = 20.4;
    const two = strainFromLoad(2 * loadFromStrain(one));
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(21);
    // a day of sitting is light
    expect(strainFromHr(new Float32Array(16 * 3600).fill(hrAt(0.12)), p).strain).toBeLessThan(2);
  });

  it("is monotone, capped at 21 and invertible", () => {
    let prev = -1;
    for (const load of [0, 5, 20, 80, 300, 1000, 5000, 1e6]) {
      const s = strainFromLoad(load);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThanOrEqual(21);
      prev = s;
    }
    expect(strainFromLoad(loadFromStrain(12))).toBeCloseTo(12, 5);
  });

  it("estimates max HR with Gellish and targets more strain when recovered", () => {
    expect(gellishMaxHr(30)).toBe(186);
    expect(strainTarget(90).low).toBeGreaterThan(strainTarget(20).high);
  });
});

describe("recovery", () => {
  const base: Baseline = { lnHrv: Math.log(60), rhr: 55, resp: 15, skinTemp: 34.5, nights: 10 };

  it("rises with HRV, falls with resting HR", () => {
    const at = (hrv: number, rhr: number) => recovery({ hrv, rhr, resp: 15, skinTemp: 34.5 }, 90, base).score!;
    expect(at(80, 55)).toBeGreaterThan(at(60, 55));
    expect(at(60, 55)).toBeGreaterThan(at(45, 55));
    expect(at(60, 50)).toBeGreaterThan(at(60, 62));
    expect(recoveryBand(at(85, 50))).toBe("green");
    expect(recoveryBand(at(35, 66))).toBe("red");
  });

  it("calibrates for the first nights", () => {
    let b = null as Baseline | null;
    b = updateBaseline(b, { hrv: 60, rhr: 55, resp: 15, skinTemp: 34.5 });
    const r = recovery({ hrv: 60, rhr: 55, resp: 15, skinTemp: 34.5 }, 90, b);
    expect(r.calibrating).toBe(true);
    expect(r.score).toBeNull();
  });
});

describe("sleep scores", () => {
  it("adds strain and debt to sleep need, subtracts naps", () => {
    const rested = sleepNeed(470, 0, 8, 0).total;
    expect(sleepNeed(470, 0, 16, 0).total).toBeGreaterThan(rested);
    expect(sleepNeed(470, 60, 8, 0).total).toBeGreaterThan(rested);
    expect(sleepNeed(470, 0, 8, 30).total).toBeLessThan(rested);
  });

  it("accumulates debt from short nights and forgets it", () => {
    const short = { needMin: 480, asleepMin: 360, napMin: 0 };
    const full = { needMin: 480, asleepMin: 480, napMin: 0 };
    expect(sleepDebt([short, short, short])).toBeGreaterThan(sleepDebt([short]));
    expect(sleepDebt([full, full, full, full, short])).toBeLessThan(5);
  });

  it("scores performance like WHOOP", () => {
    expect(sleepPerformance(480, 480, 95, null)).toBe(100);
    expect(sleepPerformance(360, 480, 95, null)).toBe(75); // classic hours-vs-needed
    expect(sleepPerformance(480, 480, 95, 90)).toBeGreaterThan(sleepPerformance(480, 480, 80, 60));
  });

  it("scores regular schedules as consistent", () => {
    const night = (d: number, on: number, off: number) => [d * 86400 + on * 3600, d * 86400 + off * 3600] as [number, number];
    const regular = [0, 1, 2, 3].map((d) => night(d, 23, 31));
    const messy = [night(0, 22, 29), night(1, 25.5, 33), night(2, 23, 28), night(3, 26, 34.5)];
    expect(sleepConsistency(regular)!).toBeGreaterThan(80);
    expect(sleepConsistency(messy)!).toBeLessThan(sleepConsistency(regular)!);
    expect(sleepConsistency(regular.slice(0, 3))).toBeNull();
  });
});

describe("pipeline on simulated nights", () => {
  const { records, days } = simulate({ days: 6, seed: 9, end: 1_790_000_000 });
  const rows = records.map(recordToSample);
  const s = buildSeries(rows, rows[0]!.ts, rows.at(-1)!.ts + 1);
  const ep = epochs(s);
  const periods = detectSleep(ep).filter((p) => !p.nap);

  it("finds one main sleep per night, near the true times", () => {
    expect(periods.length).toBeGreaterThanOrEqual(4);
    for (const p of periods) {
      const truth = days.find((d) => Math.abs(d.bed - p.start) < 3 * 3600);
      expect(truth).toBeDefined();
      expect(Math.abs(p.end - truth!.wake)).toBeLessThan(30 * 60);
    }
  });

  it("stages sleep well above chance (simulated, so optimistic)", () => {
    let hit = 0, total = 0;
    for (const p of periods) {
      const truth = days.find((d) => Math.abs(d.bed - p.start) < 3 * 3600)!;
      for (const g of stageSleep(ep, p)) {
        for (let t = g.start; t < g.end; t += 30) {
          const real = truth.stages.find((z) => t >= z.start && t < z.end)?.stage ?? "wake";
          total++;
          if (real === g.stage) hit++;
        }
      }
    }
    expect(hit / total).toBeGreaterThan(0.75);
  });

  it("reports vitals in physiological ranges", () => {
    const p = periods[1]!;
    const m = sleepMetrics(s, p, stageSleep(ep, p));
    expect(m.hrv).toBeGreaterThan(30);
    expect(m.hrv).toBeLessThan(150);
    expect(m.rhr).toBeGreaterThan(45);
    expect(m.rhr).toBeLessThan(70);
    expect(m.respRate).toBeGreaterThan(12);
    expect(m.respRate).toBeLessThan(18);
    expect(m.spo2).toBeGreaterThan(92);
    expect(m.efficiency).toBeGreaterThan(0.8);
    expect(STAGES).toContain("deep");
  });
});

describe("stress episodes", () => {
  it("needs sustained high stress", () => {
    const t = Array.from({ length: 60 }, (_, i) => i * 60);
    const s = t.map((_, i) => (i >= 10 && i < 25 ? 2.4 : i >= 40 && i < 44 ? 2.8 : 0.9));
    const ep = highStressEpisodes(t, s);
    expect(ep).toHaveLength(1);
    expect(ep[0]!.start).toBe(600);
  });
});

describe("journal insights", () => {
  it("recovers a real behaviour effect and ignores noise", () => {
    const r = rng(3);
    const days: JournalDay[] = Array.from({ length: 80 }, () => {
      const alcohol = r.chance(0.3), reading = r.chance(0.5);
      return { answers: { alcohol, reading }, recovery: 60 - (alcohol ? 18 : 0) + r.normal() * 8, hrv: 60, rhr: 55, prevStrain: 10 + r.normal() * 3 };
    });
    const ins = journalInsights(days);
    const alc = ins.find((i) => i.behaviour === "alcohol")!;
    expect(alc.effect).toBeLessThan(-10);
    expect(alc.confident).toBe(true);
    expect(Math.abs(ins.find((i) => i.behaviour === "reading")!.effect)).toBeLessThan(6);
  });
});

describe("smart alarm", () => {
  const cfg: AlarmConfig = { enabled: true, mode: "sleep_goal", latestWake: "07:30", windowMin: 60, goalPct: 85 };
  const latest = 1_000_000;
  const base = { now: latest - 1800, latestWake: latest, asleepMin: 420, needMin: 480, stage: "light" as const, provisionalRecovery: 70 };

  it("wakes in light sleep once the goal is met, never in deep", () => {
    expect(shouldWake(cfg, base).wake).toBe(true);
    expect(shouldWake(cfg, { ...base, stage: "deep" }).wake).toBe(false);
    expect(shouldWake(cfg, { ...base, asleepMin: 300 }).wake).toBe(false);
    expect(shouldWake(cfg, { ...base, now: latest - 2 * 3600 }).wake).toBe(false);
  });

  it("always wakes at the latest time", () => {
    expect(shouldWake(cfg, { ...base, now: latest, stage: "deep", asleepMin: 10 }).wake).toBe(true);
  });

  it("finds the next local wall-clock time", () => {
    const now = Date.parse("2026-11-13T20:00:00Z") / 1000;
    expect(new Date(nextLocalTime("07:30", now, 60) * 1000).toISOString()).toBe("2026-11-14T06:30:00.000Z");
  });
});
