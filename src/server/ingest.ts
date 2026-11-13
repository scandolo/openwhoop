// Ingest: archive raw frames, decode, store per-second samples.
import { gzipSync, gunzipSync } from "node:zlib";
import { PacketType } from "../protocol/constants.ts";
import { decodeFrame } from "../protocol/packet.ts";
import { decodeHistory, type HistoryRecord } from "../protocol/history.ts";
import { decodeEvent } from "../protocol/device.ts";
import { recordToSample, type SampleRow } from "../algorithms/series.ts";
import { all, now, run, tx, type Db } from "./db.ts";

const MIN_VALID_TS = Date.UTC(2020, 0, 1) / 1000; // strap with a lost RTC stamps 1971

export interface IngestResult {
  frames: number;
  records: number;
  skipped: number;
  events: number;
  range: [number, number] | null;
}

/** Concatenate frames with a u16 length prefix each, gzip'd. */
function packFrames(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((a, f) => a + 2 + f.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of frames) {
    out[o] = f.length & 0xff;
    out[o + 1] = f.length >> 8;
    out.set(f, o + 2);
    o += 2 + f.length;
  }
  return gzipSync(out);
}

export function unpackFrames(blob: Uint8Array): Uint8Array[] {
  const raw = gunzipSync(blob);
  const out: Uint8Array[] = [];
  for (let o = 0; o + 2 <= raw.length; ) {
    const n = raw[o]! | (raw[o + 1]! << 8);
    out.push(raw.subarray(o + 2, o + 2 + n));
    o += 2 + n;
  }
  return out;
}

export function ingestFrames(db: Db, deviceId: string, frames: Uint8Array[]): IngestResult {
  const records: HistoryRecord[] = [];
  const events: { ts: number; type: string; data: string }[] = [];
  let skipped = 0;
  for (const f of frames) {
    try {
      const p = decodeFrame(f);
      if (p.type === PacketType.HISTORICAL_DATA) {
        const r = decodeHistory(p);
        if (r && r.ts >= MIN_VALID_TS) records.push(r);
        else skipped++;
      } else if (p.type === PacketType.EVENT) {
        const e = decodeEvent(p);
        if (e && e.ts >= MIN_VALID_TS) events.push({ ts: e.ts, type: `strap.${e.id}`, data: JSON.stringify({ id: e.id, body: Buffer.from(e.body).toString("hex") }) });
      }
    } catch {
      skipped++;
    }
  }
  let range: [number, number] | null = null;
  for (const r of records) range = range ? [Math.min(range[0], r.ts), Math.max(range[1], r.ts)] : [r.ts, r.ts];
  tx(db, () => {
    if (frames.length) {
      run(db, "INSERT INTO raw_batches (device_id, received_at, first_ts, last_ts, frames, data) VALUES (?, ?, ?, ?, ?, ?)", deviceId, now(), range?.[0] ?? null, range?.[1] ?? null, frames.length, packFrames(frames));
    }
    insertSamples(db, records.map(recordToSample));
    const ins = db.prepare("INSERT INTO events (ts, type, data) VALUES (?, ?, ?)");
    for (const e of events) ins.run(e.ts, e.type, e.data);
    run(db, "INSERT INTO devices (id, last_sync_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_sync_at = excluded.last_sync_at", deviceId, now());
  });
  return { frames: frames.length, records: records.length, skipped, events: events.length, range };
}

const rrBlob = (rr: number[]) => (rr.length ? new Uint8Array(Uint16Array.from(rr).buffer) : null);

export function insertSamples(db: Db, rows: SampleRow[]) {
  const st = db.prepare("INSERT OR REPLACE INTO samples (ts, hr, rr, gx, gy, gz, contact, temp, spo2_red, spo2_ir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) st.run(r.ts, r.hr, rrBlob(r.rr), r.gx, r.gy, r.gz, r.contact, r.tempC, r.spo2Red, r.spo2Ir);
}

interface SampleDbRow {
  ts: number;
  hr: number;
  rr: Uint8Array | null;
  gx: number | null;
  gy: number | null;
  gz: number | null;
  contact: number;
  temp: number | null;
  spo2_red: number | null;
  spo2_ir: number | null;
}

export function loadSamples(db: Db, from: number, to: number): SampleRow[] {
  return all<SampleDbRow>(db, "SELECT * FROM samples WHERE ts >= ? AND ts < ? ORDER BY ts", from, to).map((r) => ({
    ts: r.ts,
    hr: r.hr,
    rr: r.rr ? Array.from(new Uint16Array(r.rr.buffer.slice(r.rr.byteOffset, r.rr.byteOffset + r.rr.byteLength))) : [],
    gx: r.gx,
    gy: r.gy,
    gz: r.gz,
    contact: r.contact,
    tempC: r.temp,
    spo2Red: r.spo2_red,
    spo2Ir: r.spo2_ir,
  }));
}

/** Re-decode every archived batch (after a decoder improvement). */
export function reprocessRaw(db: Db): { batches: number; records: number } {
  let records = 0;
  const batches = all<{ data: Uint8Array }>(db, "SELECT data FROM raw_batches ORDER BY id");
  tx(db, () => {
    for (const b of batches) {
      const recs = unpackFrames(b.data)
        .map((f) => {
          try {
            const p = decodeFrame(f);
            return p.type === PacketType.HISTORICAL_DATA ? decodeHistory(p) : null;
          } catch {
            return null;
          }
        })
        .filter((r): r is HistoryRecord => !!r && r.ts >= MIN_VALID_TS);
      insertSamples(db, recs.map(recordToSample));
      records += recs.length;
    }
  });
  return { batches: batches.length, records };
}
