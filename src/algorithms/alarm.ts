// Smart alarm decision, evaluated every few minutes during the night by the
// browser that holds the strap connection (WHOOP runs this on the phone too).
// The strap's own alarm is always programmed to the latest wake time as a
// fallback, so a closed tab or dead laptop still wakes you up.
import type { Stage } from "./sleep.ts";

export type AlarmMode = "exact" | "sleep_goal" | "in_the_green";

export interface AlarmConfig {
  enabled: boolean;
  mode: AlarmMode;
  latestWake: string; // "HH:MM" local
  windowMin: number; // smart window before latestWake (WHOOP uses 60)
  goalPct: 70 | 85 | 100; // for sleep_goal
}

export interface AlarmState {
  now: number;
  latestWake: number; // unix seconds
  asleepMin: number; // so far tonight
  needMin: number;
  stage: Stage | null; // most recent epoch stage
  provisionalRecovery: number | null; // from tonight's data so far
}

export interface AlarmDecision {
  wake: boolean;
  reason: string;
}

/** Light sleep and REM are good moments; deep sleep makes waking groggy. */
const GOOD_STAGES: (Stage | null)[] = ["light", "rem", "wake"];

export function shouldWake(cfg: AlarmConfig, s: AlarmState): AlarmDecision {
  if (!cfg.enabled) return { wake: false, reason: "alarm off" };
  if (s.now >= s.latestWake) return { wake: true, reason: "latest wake time" };
  if (cfg.mode === "exact") return { wake: false, reason: "waiting for the set time" };
  const windowStart = s.latestWake - cfg.windowMin * 60;
  if (s.now < windowStart) return { wake: false, reason: "before the wake window" };
  const goodMoment = GOOD_STAGES.includes(s.stage);
  if (cfg.mode === "sleep_goal") {
    const met = s.asleepMin >= (s.needMin * cfg.goalPct) / 100;
    if (met && goodMoment) return { wake: true, reason: `${cfg.goalPct}% of sleep need met, in ${s.stage ?? "light"} sleep` };
    return { wake: false, reason: met ? "goal met, waiting for light sleep" : "sleep goal not met yet" };
  }
  const green = s.provisionalRecovery !== null && s.provisionalRecovery >= 67;
  if (green && goodMoment) return { wake: true, reason: `recovery in the green (${s.provisionalRecovery}%)` };
  return { wake: false, reason: green ? "in the green, waiting for light sleep" : "not in the green yet" };
}

/** Next occurrence of a local "HH:MM" after `now`, given the UTC offset in minutes. */
export function nextLocalTime(hhmm: string, now: number, tzOffsetMin: number): number {
  const [h, m] = hhmm.split(":").map(Number);
  const local = now + tzOffsetMin * 60;
  const dayStart = Math.floor(local / 86400) * 86400;
  let t = dayStart + h! * 3600 + m! * 60 - tzOffsetMin * 60;
  if (t <= now) t += 86400;
  return t;
}
