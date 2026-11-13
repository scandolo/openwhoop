// Reader for the CSV files in a WHOOP app "Data Export". Used by the
// calibration script and by the importer (Settings → Import WHOOP export).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(header!.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** "2024-11-08 22:44:57" + "UTC-05:00" → unix seconds. */
export function whoopTime(local: string, tz: string): number | null {
  if (!local) return null;
  const m = /UTC([+-]\d{2}):?(\d{2})/.exec(tz);
  const offset = m ? `${m[1]}:${m[2]}` : "Z";
  const t = Date.parse(local.replace(" ", "T") + offset);
  return Number.isNaN(t) ? null : t / 1000;
}

const num = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s));

export interface ExportCycle {
  start: number;
  end: number | null;
  tz: string;
  recovery: number | null;
  rhr: number | null;
  hrv: number | null;
  skinTemp: number | null;
  spo2: number | null;
  dayStrain: number | null;
  energy: number | null;
  maxHr: number | null;
  avgHr: number | null;
  sleepOnset: number | null;
  wakeOnset: number | null;
  sleepPerf: number | null;
  resp: number | null;
  asleep: number | null; // minutes
  inBed: number | null;
  light: number | null;
  deep: number | null;
  rem: number | null;
  awake: number | null;
  need: number | null;
  debt: number | null;
  efficiency: number | null;
  consistency: number | null;
}

export interface ExportWorkout {
  start: number;
  end: number;
  name: string;
  strain: number | null;
  energy: number | null;
  maxHr: number | null;
  avgHr: number | null;
  zones: number[]; // % of duration in zones 1-5
}

export interface ExportSleep {
  start: number;
  end: number;
  nap: boolean;
  asleep: number | null;
}

export interface WhoopExport {
  name: string;
  cycles: ExportCycle[];
  workouts: ExportWorkout[];
  sleeps: ExportSleep[];
  journal: { cycleStart: number; question: string; answer: boolean }[];
}

export function readExport(dir: string, name = dir): WhoopExport {
  const read = (f: string) => (existsSync(join(dir, f)) ? parseCsv(readFileSync(join(dir, f), "utf8")) : []);
  const cycles = read("physiological_cycles.csv")
    .map((r): ExportCycle | null => {
      const tz = r["Cycle timezone"] ?? "";
      const start = whoopTime(r["Cycle start time"]!, tz);
      if (start === null) return null;
      return {
        start,
        end: whoopTime(r["Cycle end time"]!, tz),
        tz,
        recovery: num(r["Recovery score %"]),
        rhr: num(r["Resting heart rate (bpm)"]),
        hrv: num(r["Heart rate variability (ms)"]),
        skinTemp: num(r["Skin temp (celsius)"]),
        spo2: num(r["Blood oxygen %"]),
        dayStrain: num(r["Day Strain"]),
        energy: num(r["Energy burned (cal)"]),
        maxHr: num(r["Max HR (bpm)"]),
        avgHr: num(r["Average HR (bpm)"]),
        sleepOnset: whoopTime(r["Sleep onset"]!, tz),
        wakeOnset: whoopTime(r["Wake onset"]!, tz),
        sleepPerf: num(r["Sleep performance %"]),
        resp: num(r["Respiratory rate (rpm)"]),
        asleep: num(r["Asleep duration (min)"]),
        inBed: num(r["In bed duration (min)"]),
        light: num(r["Light sleep duration (min)"]),
        deep: num(r["Deep (SWS) duration (min)"]),
        rem: num(r["REM duration (min)"]),
        awake: num(r["Awake duration (min)"]),
        need: num(r["Sleep need (min)"]),
        debt: num(r["Sleep debt (min)"]),
        efficiency: num(r["Sleep efficiency %"]),
        consistency: num(r["Sleep consistency %"]),
      };
    })
    .filter((c): c is ExportCycle => c !== null)
    .sort((a, b) => a.start - b.start);

  const workouts = read("workouts.csv")
    .map((r): ExportWorkout | null => {
      const tz = r["Cycle timezone"] ?? "";
      const start = whoopTime(r["Workout start time"]!, tz);
      const end = whoopTime(r["Workout end time"]!, tz);
      if (start === null || end === null) return null;
      return {
        start,
        end,
        name: r["Activity name"] ?? "Activity",
        strain: num(r["Activity Strain"]),
        energy: num(r["Energy burned (cal)"]),
        maxHr: num(r["Max HR (bpm)"]),
        avgHr: num(r["Average HR (bpm)"]),
        zones: [1, 2, 3, 4, 5].map((z) => num(r[`HR Zone ${z} %`]) ?? 0),
      };
    })
    .filter((w): w is ExportWorkout => w !== null)
    .sort((a, b) => a.start - b.start);

  const sleeps = read("sleeps.csv")
    .map((r): ExportSleep | null => {
      const tz = r["Cycle timezone"] ?? "";
      const start = whoopTime(r["Sleep onset"]!, tz);
      const end = whoopTime(r["Wake onset"]!, tz);
      if (start === null || end === null) return null;
      return { start, end, nap: r["Nap"] === "true", asleep: num(r["Asleep duration (min)"]) };
    })
    .filter((s): s is ExportSleep => s !== null);

  const journal = read("journal_entries.csv")
    .map((r) => ({
      cycleStart: whoopTime(r["Cycle start time"]!, r["Cycle timezone"] ?? "") ?? 0,
      question: r["Question text"] ?? "",
      answer: r["Answered yes"] === "true",
    }))
    .filter((j) => j.cycleStart && j.question);

  return { name, cycles, workouts, sleeps, journal };
}

/** Every directory under `root` (inclusive) that contains physiological_cycles.csv. */
export function findExports(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (existsSync(join(d, "physiological_cycles.csv"))) out.push(d);
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory() && !e.startsWith(".")) walk(p);
    }
  };
  walk(root);
  return out;
}
