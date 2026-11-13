// Typed user settings stored in the meta table.
import { z } from "zod";
import type { Db } from "./db.ts";
import { getMeta, setMeta } from "./db.ts";
import { gellishMaxHr, type Physiology } from "../algorithms/strain.ts";
import { DEFAULT_SLEEP_NEED_MIN } from "../algorithms/sleep-score.ts";

export const ProfileSchema = z.object({
  name: z.string().max(60).default(""),
  birthYear: z.number().int().min(1900).max(2100).nullable().default(null),
  sex: z.enum(["male", "female"]).default("male"),
  weightKg: z.number().min(25).max(300).default(75),
  heightCm: z.number().min(100).max(250).default(178),
  maxHrOverride: z.number().int().min(120).max(230).nullable().default(null),
  sleepNeedBaselineMin: z.number().int().min(300).max(660).nullable().default(null),
  timezone: z.string().default("UTC"),
  units: z.enum(["metric", "imperial"]).default("metric"),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const AlarmSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["exact", "sleep_goal", "in_the_green"]).default("sleep_goal"),
  latestWake: z.string().regex(/^\d{2}:\d{2}$/).default("07:30"),
  windowMin: z.number().int().min(10).max(90).default(60),
  goalPct: z.union([z.literal(70), z.literal(85), z.literal(100)]).default(100),
});
export type AlarmSettings = z.infer<typeof AlarmSchema>;

export const HapticsSchema = z.object({
  stressNudges: z.boolean().default(true),
  stressThreshold: z.number().min(1.5).max(3).default(2),
  stressMinutes: z.number().int().min(5).max(60).default(10),
  strainTargetBuzz: z.boolean().default(true),
  bedtimeNudge: z.boolean().default(true),
  quietStart: z.string().regex(/^\d{2}:\d{2}$/).default("22:30"),
  quietEnd: z.string().regex(/^\d{2}:\d{2}$/).default("07:00"),
});
export type HapticsSettings = z.infer<typeof HapticsSchema>;

export const JournalQuestionsSchema = z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().min(1).max(80), enabled: z.boolean() }));
export type JournalQuestion = z.infer<typeof JournalQuestionsSchema>[number];

export const DEFAULT_QUESTIONS: JournalQuestion[] = [
  { id: "alcohol", label: "Drink any alcohol?", enabled: true },
  { id: "late_caffeine", label: "Have caffeine after 2pm?", enabled: true },
  { id: "late_meal", label: "Eat a meal close to bedtime?", enabled: true },
  { id: "screen_in_bed", label: "Use a screen in bed?", enabled: true },
  { id: "read_before_bed", label: "Read before bed?", enabled: true },
  { id: "meditation", label: "Meditate or do breathwork?", enabled: false },
  { id: "late_workout", label: "Work out within 3 hours of bed?", enabled: false },
  { id: "shared_bed", label: "Share your bed?", enabled: false },
];

export function getProfile(db: Db): Profile {
  return ProfileSchema.parse(getMeta(db, "profile", {}));
}
export function setProfile(db: Db, p: Partial<Profile>) {
  setMeta(db, "profile", ProfileSchema.parse({ ...getProfile(db), ...p }));
}
export function getAlarm(db: Db): AlarmSettings {
  return AlarmSchema.parse(getMeta(db, "alarm", {}));
}
export function getHaptics(db: Db): HapticsSettings {
  return HapticsSchema.parse(getMeta(db, "haptics", {}));
}
export function getQuestions(db: Db): JournalQuestion[] {
  return JournalQuestionsSchema.parse(getMeta(db, "journal_questions", DEFAULT_QUESTIONS));
}

export function age(p: Profile, at = Date.now()): number {
  return p.birthYear ? new Date(at).getUTCFullYear() - p.birthYear : 30;
}

/** Physiology used for strain and calories. RHR comes from recent recoveries. */
export function physiology(p: Profile, restingHr: number, observedMaxHr: number | null): Physiology {
  const a = age(p);
  const estimated = gellishMaxHr(a);
  return {
    restingHr,
    maxHr: p.maxHrOverride ?? Math.max(estimated, observedMaxHr ?? 0),
    weightKg: p.weightKg,
    heightCm: p.heightCm,
    age: a,
    sex: p.sex,
  };
}

export const sleepNeedBaseline = (p: Profile) => p.sleepNeedBaselineMin ?? DEFAULT_SLEEP_NEED_MIN;

// ── time zones ─────────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string, unix: number) {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(unix * 1000))) o[p.type] = p.value;
  return o;
}

/** UTC offset in minutes for a zone at a given instant (e.g. +60 for Rome in winter). */
export function tzOffsetMin(tz: string, unix: number): number {
  const o = parts(tz, unix);
  const asUtc = Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour), Number(o.minute), Number(o.second)) / 1000;
  return Math.round((asUtc - unix) / 60);
}

export function localDate(tz: string, unix: number): string {
  const o = parts(tz, unix);
  return `${o.year}-${o.month}-${o.day}`;
}

/** Unix seconds of local midnight that starts `date` in `tz`. */
export function localMidnight(tz: string, date: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`) / 1000;
  return guess - tzOffsetMin(tz, guess) * 60;
}
