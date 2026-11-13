// `npm run demo [-- --days 45]`: fill ./data-demo with simulated weeks and
// start the server on it. Your real data directory is never touched.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { simulate } from "../src/sim/synth.ts";
import { recordToSample } from "../src/algorithms/series.ts";
import { all, get, openDb, run, tx } from "../src/server/db.ts";
import { insertSamples } from "../src/server/ingest.ts";
import { processRange } from "../src/server/pipeline.ts";
import { localDate, setProfile } from "../src/server/settings.ts";

const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 45;
const dir = resolve(process.env.OPENWHOOP_DATA_DIR ?? "data-demo");
process.env.OPENWHOOP_DATA_DIR = dir;
const dbPath = resolve(dir, "openwhoop.db");

if (!existsSync(dbPath) || process.argv.includes("--reset")) {
  if (existsSync(dbPath)) for (const f of ["", "-wal", "-shm"]) await import("node:fs").then((fs) => fs.rmSync(dbPath + f, { force: true }));
  const db = openDb(dbPath);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  setProfile(db, { name: "Demo athlete", birthYear: 1995, sex: "male", weightKg: 76, heightCm: 180, timezone: tz });
  const tzOffsetMin = -new Date().getTimezoneOffset();
  console.log(`Simulating ${days} days…`);
  const sim = simulate({ days, seed: 2026, tzOffsetMin });
  tx(db, () => {
    insertSamples(db, sim.records.map(recordToSample));
    run(db, "INSERT INTO devices (id, name, firmware, battery, last_sync_at) VALUES ('demo', 'WHOOP 4C1865229 (simulated)', '41.17.2.0', 64, ?)", Math.floor(Date.now() / 1000) - 600);
  });
  console.log("Scoring…");
  const t = performance.now();
  processRange(db, sim.records[0]!.ts, sim.records.at(-1)!.ts);
  console.log(`Scored in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  // journal answers (behaviour on the evening each night started) and sport labels
  tx(db, () => {
    for (const d of sim.days) {
      if (d.bed > Date.now() / 1000) continue;
      const date = localDate(tz, d.bed - 6 * 3600);
      for (const [q, a] of Object.entries(d.journal)) run(db, "INSERT OR REPLACE INTO journal (date, question, answer) VALUES (?, ?, ?)", date, q, a ? 1 : 0);
      for (const w of d.workouts) {
        const name = { running: "Running", cycling: "Cycling", strength: "Weightlifting", hiit: "HIIT" }[w.sport] ?? "Activity";
        run(db, "UPDATE workouts SET sport = ?, name = ?, source = 'manual' WHERE source = 'detected' AND start < ? AND end > ?", w.sport, name, w.end, w.start);
      }
    }
  });
  const n = get<{ n: number }>(db, "SELECT COUNT(*) n FROM cycles")!.n;
  console.log(`Demo ready: ${n} cycles, ${all(db, "SELECT id FROM workouts").length} workouts.`);
  db.close();
}

await import("../src/server/main.ts");
