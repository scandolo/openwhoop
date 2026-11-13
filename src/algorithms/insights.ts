// Journal insights: how a behaviour the evening before relates to the next
// morning's recovery. Like WHOOP, an insight unlocks after at least 5 "yes"
// and 5 "no" answers. The effect is the difference in mean recovery, adjusted
// for the previous day's strain (a common confounder) with least squares, and
// reported with a 95% interval so small samples read as uncertain.
import { mean, ols, std } from "./stats.ts";

export interface JournalDay {
  answers: Record<string, boolean>;
  recovery: number; // next morning
  hrv: number | null;
  rhr: number | null;
  prevStrain: number | null;
}

export interface Insight {
  behaviour: string;
  yes: number;
  no: number;
  effect: number; // recovery points, adjusted
  relative: number; // % vs "no" mean
  low: number; // 95% interval
  high: number;
  hrvEffectPct: number | null;
  rhrEffect: number | null;
  confident: boolean; // interval excludes zero
}

export const MIN_ANSWERS = 5;

export function journalInsights(days: JournalDay[]): Insight[] {
  const behaviours = [...new Set(days.flatMap((d) => Object.keys(d.answers)))];
  const out: Insight[] = [];
  for (const b of behaviours) {
    const rows = days.filter((d) => b in d.answers);
    const yes = rows.filter((d) => d.answers[b]);
    const no = rows.filter((d) => !d.answers[b]);
    if (yes.length < MIN_ANSWERS || no.length < MIN_ANSWERS) continue;

    const strainMean = mean(rows.filter((d) => d.prevStrain !== null).map((d) => d.prevStrain!)) || 10;
    const X = rows.map((d) => [1, d.answers[b] ? 1 : 0, (d.prevStrain ?? strainMean) - strainMean]);
    const y = rows.map((d) => d.recovery);
    const w = ols(X, y);
    const resid = rows.map((_, i) => y[i]! - (w[0]! + w[1]! * X[i]![1]! + w[2]! * X[i]![2]!));
    const sigma = std(resid);
    const se = sigma * Math.sqrt(1 / yes.length + 1 / no.length);
    const noMean = mean(no.map((d) => d.recovery));

    const diffPct = (pick: (d: JournalDay) => number | null, relative: boolean) => {
      const a = yes.map(pick).filter((x): x is number => x !== null);
      const c = no.map(pick).filter((x): x is number => x !== null);
      if (a.length < 3 || c.length < 3) return null;
      return relative ? (100 * (mean(a) - mean(c))) / mean(c) : mean(a) - mean(c);
    };

    out.push({
      behaviour: b,
      yes: yes.length,
      no: no.length,
      effect: w[1]!,
      relative: noMean ? (100 * w[1]!) / noMean : 0,
      low: w[1]! - 1.96 * se,
      high: w[1]! + 1.96 * se,
      hrvEffectPct: diffPct((d) => d.hrv, true),
      rhrEffect: diffPct((d) => d.rhr, false),
      confident: w[1]! - 1.96 * se > 0 || w[1]! + 1.96 * se < 0,
    });
  }
  return out.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
}
