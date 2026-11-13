import type { SleepMetrics, StageSegment } from "../algorithms/sleep.ts";
import type { NeedBreakdown } from "../algorithms/sleep-score.ts";
import type { StrainResult } from "../algorithms/strain.ts";
import type { RecoveryResult, Baseline } from "../algorithms/recovery.ts";

export type { SleepMetrics, StageSegment };

export interface Recovery extends RecoveryResult {
  hrv: number | null;
  rhr: number | null;
  resp: number | null;
  skinTemp: number | null;
  flags: string[];
  baseline: Baseline | null;
}

export interface SleepScore {
  need: NeedBreakdown;
  debt: number;
  performance: number;
  consistency: number | null;
  band: "optimal" | "sufficient" | "poor";
  metrics: SleepMetrics;
}

export interface Workout {
  id: number;
  start: number;
  end: number;
  sport: string;
  name: string | null;
  source: string;
  strain: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  kcal: number | null;
  zones: number[] | null;
  meta: { url?: string } | null;
}

export interface CycleView {
  cycle: { start: number; end: number | null };
  recovery: Recovery | null;
  sleep: SleepScore | null;
  strain: (StrainResult & { band: string }) | null;
}

export interface Overview extends CycleView {
  empty?: boolean;
  date: string;
  prevDate: string | null;
  nextDate: string | null;
  latestDate: string | null;
  isCurrent: boolean;
  strainTarget: { low: number; high: number };
  workouts: Workout[];
  stress: { current: number | null; avg: number | null; minutes: { low: number; medium: number; high: number } };
  journal: { date: string; answered: boolean };
  tonight: { needMin: number; need: NeedBreakdown; wakeAt: number; bedtimes: { goal: number; at: number }[] } | null;
  baselines: { hrv: number | null; rhr: number | null; resp: number | null; recovery: number | null; strain: number | null };
  device: { id: string; name: string | null; battery: number | null; last_sync_at: number | null } | null;
}

export interface TrendPoint {
  date: string;
  recovery: number | null;
  hrv: number | null;
  rhr: number | null;
  resp: number | null;
  skinTempDev: number | null;
  strain: number | null;
  kcal: number | null;
  sleepPerformance: number | null;
  asleepH: number | null;
  needH: number | null;
  consistency: number | null;
  efficiency: number | null;
  restorative: number | null;
}

export interface DayData {
  start: number;
  end: number | null;
  minutes: { ts: number; hr: number | null; stress: number | null; state: string }[];
  stages: StageSegment[] | null;
  physiology: { restingHr: number; maxHr: number };
}
