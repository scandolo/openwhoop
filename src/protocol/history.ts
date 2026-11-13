// Decoders for packets the strap sends during a history download.
// Layouts and caveats: docs/protocol.md (field meanings marked "disputed"
// there are kept raw and labelled experimental in the app).
import { MetadataType, PacketType } from "./constants.ts";
import type { Packet } from "./packet.ts";

export interface SensorFields {
  gravity: [number, number, number]; // g, low-passed accelerometer
  ppgGreen: number;
  spo2Red: number; // raw; moves in lockstep with spo2Ir on 4.0, so no SpO2
  spo2Ir: number;
  skinTempRaw: number; // disputed meaning, see skinTempC()
  ambientLight: number;
}

/** One stored second of data. */
export interface HistoryRecord {
  ts: number; // unix seconds (strap clock)
  hr: number; // bpm, 0 = off wrist / unknown
  rr: number[]; // beat-to-beat intervals in ms, 0-4 per record
  version: number; // record layout, carried in the packet seq byte
  sensor?: SensorFields;
}

const dv = (p: Packet) => new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);

function readRR(p: Packet, v: DataView, countAt: number, at: number): number[] {
  const n = p.data[countAt] ?? 0;
  if (n > 4) return [];
  const rr: number[] = [];
  for (let i = 0; i < n && at + i * 2 + 2 <= p.data.length; i++) {
    const x = v.getUint16(at + i * 2, true);
    if (x >= 200 && x <= 2500) rr.push(x);
  }
  return rr;
}

/**
 * Decode a type-47 record. Returns null for layouts we can't use (no heart
 * rate, unknown versions) — the raw frame is archived either way.
 *   v12/v24  full sensor record (≥ 85 data bytes)
 *   v10      IMU burst (≥ 1188 bytes); gravity = mean accelerometer vector
 *   v9       HR at d[14]   ·   v7  HR at d[24]
 */
export function decodeHistory(p: Packet): HistoryRecord | null {
  if (p.type !== PacketType.HISTORICAL_DATA || p.data.length < 16) return null;
  const v = dv(p);
  const ts = v.getUint32(4, true);
  const version = p.seq;
  if ((version === 12 || version === 24) && p.data.length >= 85) {
    return {
      ts,
      hr: p.data[14]!,
      rr: readRR(p, v, 15, 16),
      version,
      sensor: {
        gravity: [v.getFloat32(33, true), v.getFloat32(37, true), v.getFloat32(41, true)],
        ppgGreen: v.getUint16(26, true),
        spo2Red: v.getUint16(61, true),
        spo2Ir: v.getUint16(63, true),
        skinTempRaw: v.getUint16(65, true),
        ambientLight: v.getUint16(67, true),
      },
    };
  }
  if (version === 10 && p.data.length >= 1188) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < 100; i++) {
      x += v.getInt16(85 + i * 2, false) / 1875;
      y += v.getInt16(285 + i * 2, false) / 1875;
      z += v.getInt16(485 + i * 2, false) / 1875;
    }
    return { ts, hr: p.data[14]!, rr: readRR(p, v, 15, 16), version, sensor: { gravity: [x / 100, y / 100, z / 100], ppgGreen: 0, spo2Red: 0, spo2Ir: 0, skinTempRaw: 0, ambientLight: 0 } };
  }
  if (version === 9 && p.data.length >= 24) return { ts, hr: p.data[14]!, rr: readRR(p, v, 15, 16), version };
  if (version === 7 && p.data.length >= 25) return { ts, hr: p.data[24]!, rr: [], version };
  return null;
}

export interface HistoryMeta {
  kind: "start" | "end" | "complete" | "other";
  ts?: number;
  /** END only: the 8 bytes (trim page + wrap count) to echo back in the ack. */
  ack?: Uint8Array;
  trim?: number;
  expected?: number;
}

export function decodeMetadata(p: Packet): HistoryMeta {
  const v = dv(p);
  const ts = p.data.length >= 4 ? v.getUint32(0, true) : undefined;
  switch (p.cmd) {
    case MetadataType.HISTORY_START:
      return { kind: "start", ts };
    case MetadataType.HISTORY_END:
      if (p.data.length < 18) return { kind: "other", ts };
      return { kind: "end", ts, ack: p.data.slice(10, 18), trim: v.getUint32(10, true), expected: v.getUint32(6, true) };
    case MetadataType.HISTORY_COMPLETE:
      return { kind: "complete", ts };
    default:
      return { kind: "other", ts };
  }
}

/**
 * Skin temperature (°C) from the u16 at d[65]. Disputed upstream: openwhoop
 * used raw × 0.04, noop a provisional 33 + (raw − 826) × 0.05, OpenStrap
 * doubts it is a temperature at all. We use raw × 0.04 and only ever show
 * deviations from the personal baseline, labelled experimental.
 */
export function skinTempC(raw: number): number | null {
  return raw >= 500 && raw <= 1300 ? raw * 0.04 : null;
}

/**
 * Inverse of decodeHistory for the v12/v24 layout. Used by the simulator and
 * tests to produce byte-exact frames the real pipeline can ingest.
 */
export function encodeHistoryData(rec: HistoryRecord, sequence = 0): Uint8Array {
  const d = new Uint8Array(96);
  const v = new DataView(d.buffer);
  v.setUint32(0, sequence, true);
  v.setUint32(4, rec.ts, true);
  d[14] = rec.hr;
  const rr = rec.rr.slice(0, 4);
  d[15] = rr.length;
  rr.forEach((x, i) => v.setUint16(16 + i * 2, x, true));
  const s = rec.sensor;
  if (s) {
    v.setUint16(26, s.ppgGreen, true);
    v.setFloat32(33, s.gravity[0], true);
    v.setFloat32(37, s.gravity[1], true);
    v.setFloat32(41, s.gravity[2], true);
    v.setUint16(61, s.spo2Red, true);
    v.setUint16(63, s.spo2Ir, true);
    v.setUint16(65, s.skinTempRaw, true);
    v.setUint16(67, s.ambientLight, true);
  }
  v.setUint16(73, 3073, true); // constant in every real capture
  v.setUint16(75, 3074, true);
  return d;
}
