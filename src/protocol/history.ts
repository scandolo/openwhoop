// Decoders for packets the strap sends during a history download.
import { MetadataType, PacketType } from "./constants.ts";
import type { Packet } from "./packet.ts";

export interface SensorFields {
  ppgGreen: number;
  ppgRedIr: number;
  gravity: [number, number, number]; // g
  skinContact: number; // 0 = off wrist
  spo2Red: number;
  spo2Ir: number;
  skinTempRaw: number;
  ambientLight: number;
  respRaw: number;
  signalQuality: number;
}

/** One stored second of data. */
export interface HistoryRecord {
  ts: number; // unix seconds (strap clock)
  hr: number; // bpm, 0 when unknown
  rr: number[]; // beat-to-beat intervals in ms, 0-4 per record
  version: number; // record layout, carried in the packet seq byte
  sensor?: SensorFields;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);

function view(p: Packet) {
  return new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
}

function readRR(p: Packet, v: DataView): number[] {
  const n = Math.min(p.data[15] ?? 0, 4);
  const rr: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = u16(v, 16 + i * 2);
    if (x > 0) rr.push(x);
  }
  return rr;
}

/** Full-sensor layout (record versions 12 and 24, >= 77 data bytes). */
export function isFullSensor(p: Packet): boolean {
  return p.type === PacketType.HISTORICAL_DATA && (p.seq === 12 || p.seq === 24) && p.data.length >= 77;
}

export function decodeHistory(p: Packet): HistoryRecord {
  if (p.type !== PacketType.HISTORICAL_DATA) throw new Error(`not a history packet (type ${p.type})`);
  if (p.data.length < 24) throw new Error(`history packet too short (${p.data.length} bytes)`);
  const v = view(p);
  const rec: HistoryRecord = { ts: v.getUint32(4, true), hr: p.data[14]!, rr: readRR(p, v), version: p.seq };
  if (isFullSensor(p)) {
    rec.sensor = {
      ppgGreen: u16(v, 26),
      ppgRedIr: u16(v, 28),
      gravity: [v.getFloat32(33, true), v.getFloat32(37, true), v.getFloat32(41, true)],
      skinContact: p.data[48]!,
      spo2Red: u16(v, 61),
      spo2Ir: u16(v, 63),
      skinTempRaw: u16(v, 65),
      ambientLight: u16(v, 67),
      respRaw: u16(v, 73),
      signalQuality: u16(v, 75),
    };
  }
  return rec;
}

export interface HistoryMeta {
  kind: "start" | "end" | "complete" | "other";
  ts?: number;
  /** Read pointer to acknowledge after a batch (HISTORY_END only). */
  trim?: number;
}

export function decodeMetadata(p: Packet): HistoryMeta {
  const v = view(p);
  const ts = p.data.length >= 4 ? v.getUint32(0, true) : undefined;
  switch (p.cmd) {
    case MetadataType.HISTORY_START:
      return { kind: "start", ts };
    case MetadataType.HISTORY_END:
      return { kind: "end", ts, trim: p.data.length >= 14 ? v.getUint32(10, true) : undefined };
    case MetadataType.HISTORY_COMPLETE:
      return { kind: "complete", ts };
    default:
      return { kind: "other", ts };
  }
}

/** Skin temperature in °C from the thermistor ADC (empirical, from openwhoop). */
export function skinTempC(raw: number): number | null {
  return raw >= 100 ? raw * 0.04 : null;
}

/**
 * Inverse of decodeHistory for full-sensor records. Used by the simulator and
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
    v.setUint16(28, s.ppgRedIr, true);
    v.setFloat32(33, s.gravity[0], true);
    v.setFloat32(37, s.gravity[1], true);
    v.setFloat32(41, s.gravity[2], true);
    d[48] = s.skinContact;
    v.setUint16(61, s.spo2Red, true);
    v.setUint16(63, s.spo2Ir, true);
    v.setUint16(65, s.skinTempRaw, true);
    v.setUint16(67, s.ambientLight, true);
    v.setUint16(73, s.respRaw, true);
    v.setUint16(75, s.signalQuality, true);
  }
  return d;
}
