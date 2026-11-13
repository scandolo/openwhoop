import { describe, expect, it } from "vitest";
import { simulate } from "../sim/synth.ts";
import { encodePacket } from "../protocol/packet.ts";
import { encodeHistoryData } from "../protocol/history.ts";
import { PacketType } from "../protocol/constants.ts";
import { all, get, openDb } from "./db.ts";
import { ingestFrames, reprocessRaw } from "./ingest.ts";
import { processRange } from "./pipeline.ts";
import { setProfile } from "./settings.ts";

describe("ingest → pipeline", () => {
  it("turns raw strap frames into scored cycles", () => {
    const db = openDb(":memory:");
    setProfile(db, { timezone: "Europe/Rome", birthYear: 1995 });
    const end = Date.parse("2026-11-10T12:00:00Z") / 1000;
    const { records, days } = simulate({ days: 9, seed: 21, end });
    // ingest day by day, as real frames, like a browser sync would
    for (let i = 0; i < records.length; i += 86400) {
      const frames = records.slice(i, i + 86400).map((r, k) => encodePacket({ type: PacketType.HISTORICAL_DATA, seq: 12, cmd: 0, data: encodeHistoryData(r, i + k) }));
      const res = ingestFrames(db, "WHOOP 4C1865229", frames);
      expect(res.records).toBe(frames.length);
      processRange(db, res.range![0], res.range![1]);
    }
    const cycles = all<{ date: string; recovery: string | null; strain: string; sleep_score: string }>(db, "SELECT * FROM cycles ORDER BY start");
    expect(cycles.length).toBeGreaterThanOrEqual(days.length - 2);
    const scored = cycles.map((c) => (c.recovery ? JSON.parse(c.recovery).score : null)).filter((x) => x !== null);
    expect(scored.length).toBeGreaterThanOrEqual(4); // after 3 calibration nights
    for (const r of scored) expect(r).toBeGreaterThan(0);
    const strains = cycles.slice(0, -1).map((c) => JSON.parse(c.strain).strain as number);
    expect(Math.max(...strains)).toBeGreaterThan(8);
    expect(Math.min(...strains)).toBeGreaterThan(2);
    const perf = JSON.parse(cycles[3]!.sleep_score).performance;
    expect(perf).toBeGreaterThan(40);
    expect(get<{ n: number }>(db, "SELECT COUNT(*) n FROM minutes WHERE stress IS NOT NULL")!.n).toBeGreaterThan(1000);
    expect(get<{ n: number }>(db, "SELECT COUNT(*) n FROM workouts")!.n).toBeGreaterThan(2);
    expect(reprocessRaw(db).records).toBe(records.length);
  }, 120_000);
});
