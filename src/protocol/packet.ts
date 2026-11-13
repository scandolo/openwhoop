// Gen4 frame:  SOF(0xAA) | len u16 LE | crc8(len) | payload | crc32(payload) u32 LE
// where len = payload.length + 4 and payload = type | seq | cmd | data...
import { crc32, crc8 } from "./crc.ts";
import { SOF } from "./constants.ts";

export interface Packet {
  type: number;
  seq: number;
  cmd: number;
  data: Uint8Array;
}

export function encodePacket(p: Packet): Uint8Array {
  const payloadLen = 3 + p.data.length;
  const len = payloadLen + 4;
  const out = new Uint8Array(4 + payloadLen + 4);
  const view = new DataView(out.buffer);
  out[0] = SOF;
  view.setUint16(1, len, true);
  out[3] = crc8(out.subarray(1, 3));
  out[4] = p.type;
  out[5] = p.seq;
  out[6] = p.cmd;
  out.set(p.data, 7);
  view.setUint32(4 + payloadLen, crc32(out.subarray(4, 4 + payloadLen)), true);
  return out;
}

export class FrameError extends Error {}

/** Total frame size implied by a header, or -1 if fewer than 4 bytes are available. */
export function frameLength(bytes: Uint8Array): number {
  if (bytes.length < 4) return -1;
  return (bytes[1]! | (bytes[2]! << 8)) + 4;
}

export function decodeFrame(frame: Uint8Array): Packet {
  if (frame.length < 11) throw new FrameError(`frame too short (${frame.length} bytes)`);
  if (frame[0] !== SOF) throw new FrameError(`bad SOF 0x${frame[0]!.toString(16)}`);
  if (crc8(frame.subarray(1, 3)) !== frame[3]) throw new FrameError("header CRC-8 mismatch");
  const total = frameLength(frame);
  if (frame.length < total) throw new FrameError(`truncated frame: need ${total}, got ${frame.length}`);
  const payload = frame.subarray(4, total - 4);
  const expected = new DataView(frame.buffer, frame.byteOffset).getUint32(total - 4, true);
  if (crc32(payload) !== expected) throw new FrameError("payload CRC-32 mismatch");
  return { type: payload[0]!, seq: payload[1]!, cmd: payload[2]!, data: payload.slice(3) };
}

/**
 * Reassembles packets that span several BLE notifications (MTU is ~244 bytes,
 * history packets can be larger). Emits the raw frame alongside the parsed
 * packet so callers can archive the exact bytes.
 */
export class FrameAssembler {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): { frame: Uint8Array; packet: Packet }[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: { frame: Uint8Array; packet: Packet }[] = [];
    for (;;) {
      const start = this.buf.indexOf(SOF);
      if (start === -1) {
        this.buf = new Uint8Array(0);
        break;
      }
      if (start > 0) this.buf = this.buf.slice(start);
      const total = frameLength(this.buf);
      if (total < 0 || this.buf.length < total) break;
      if (crc8(this.buf.subarray(1, 3)) !== this.buf[3] || total < 11) {
        this.buf = this.buf.slice(1); // not a real header, resync on next SOF
        continue;
      }
      const frame = this.buf.slice(0, total);
      try {
        out.push({ frame, packet: decodeFrame(frame) });
        this.buf = this.buf.slice(total);
      } catch {
        this.buf = this.buf.slice(1);
      }
    }
    return out;
  }

  reset() {
    this.buf = new Uint8Array(0);
  }
}
