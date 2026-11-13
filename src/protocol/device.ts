// Decoders for command responses, realtime heart rate and strap events.
import { Command, PacketType } from "./constants.ts";
import type { Packet } from "./packet.ts";

const dv = (p: Packet) => new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);

export interface CommandResponse {
  cmd: number;
  seq: number; // echoed request seq
  status: "fail" | "ok" | "pending" | "unsupported" | number;
  body: Uint8Array; // from d[2]
}

export function decodeResponse(p: Packet): CommandResponse | null {
  if (p.type !== PacketType.COMMAND_RESPONSE || p.data.length < 2) return null;
  const s = p.data[1]!;
  return { cmd: p.cmd, seq: p.data[0]!, status: (["fail", "ok", "pending", "unsupported"] as const)[s] ?? s, body: p.data.slice(2) };
}

export function batteryFromResponse(p: Packet): number | null {
  return p.cmd === Command.GET_BATTERY_LEVEL && p.data.length >= 4 ? dv(p).getUint16(2, true) / 10 : null;
}

export function clockFromResponse(p: Packet): number | null {
  return p.cmd === Command.GET_CLOCK && p.data.length >= 6 ? dv(p).getUint32(2, true) : null;
}

export interface Hello {
  battery: number;
  clock: number;
  serial: string;
}

export function helloFromResponse(p: Packet): Hello | null {
  if (p.cmd !== Command.GET_HELLO_HARVARD || p.data.length < 20) return null;
  const v = dv(p);
  let serial = "";
  for (let i = 16; i < p.data.length && p.data[i] !== 0 && serial.length < 32; i++) serial += String.fromCharCode(p.data[i]!);
  return { battery: v.getUint32(3, true) / 10, clock: v.getUint32(8, true), serial };
}

export function versionFromResponse(p: Packet): { harvard: string; boylston: string } | null {
  if (p.cmd !== Command.REPORT_VERSION_INFO || p.data.length < 35) return null;
  const v = dv(p);
  const quad = (o: number) => [0, 1, 2, 3].map((i) => v.getUint32(o + i * 4, true)).join(".");
  return { harvard: quad(3), boylston: quad(19) };
}

export interface RealtimeHr {
  ts: number;
  hr: number;
  rr: number[];
  wearing: boolean;
}

/** REALTIME_DATA (type 40): the unix time is split across cmd and d[0..2]. */
export function decodeRealtime(p: Packet): RealtimeHr | null {
  if (p.type !== PacketType.REALTIME_DATA || p.data.length < 16) return null;
  const v = dv(p);
  const ts = (p.cmd | (p.data[0]! << 8) | (p.data[1]! << 16) | (p.data[2]! << 24)) >>> 0;
  const n = Math.min(4, p.data[6]!);
  const rr: number[] = [];
  for (let i = 0; i < n; i++) rr.push(v.getUint16(7 + i * 2, true));
  return { ts, hr: p.data[5]!, rr, wearing: p.data[15] === 1 };
}

export interface StrapEvent {
  id: number;
  ts: number;
  body: Uint8Array;
}

/** EVENT (type 48): id is a u16 split across cmd and d[0]. */
export function decodeEvent(p: Packet): StrapEvent | null {
  if (p.type !== PacketType.EVENT || p.data.length < 9) return null;
  const v = dv(p);
  const len = v.getUint16(7, true);
  return { id: p.cmd | (p.data[0]! << 8), ts: v.getUint32(1, true), body: p.data.slice(9, 9 + len) };
}

export function batteryEvent(e: StrapEvent): { pct: number; mV: number; charging: boolean } | null {
  if (e.id !== 3 || e.body.length < 9) return null;
  const v = new DataView(e.body.buffer, e.body.byteOffset, e.body.byteLength);
  return { pct: v.getUint32(1, true) / 10, mV: v.getUint32(5, true), charging: (e.body[9] ?? 0) === 1 || (e.body[10] ?? 0) === 1 };
}
