import { describe, expect, it } from "vitest";
import { Command, PacketType } from "./constants.ts";
import { commands } from "./commands.ts";
import { decodeFrame, encodePacket, FrameAssembler, FrameError } from "./packet.ts";
import { decodeHistory, decodeMetadata, encodeHistoryData, isFullSensor, skinTempC } from "./history.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("framing", () => {
  it("round-trips a command", () => {
    const frame = encodePacket({ type: PacketType.COMMAND, seq: 0x28, cmd: Command.TOGGLE_REALTIME_HR, data: Uint8Array.of(1) });
    // aa | len=8 | crc8(08 00)=a8 | 23 28 03 01 | crc32 — checked against Python's zlib
    expect(hex(frame)).toBe("aa0800a823280301c1abb7f9");
    const p = decodeFrame(frame);
    expect(p).toMatchObject({ type: PacketType.COMMAND, seq: 0x28, cmd: Command.TOGGLE_REALTIME_HR });
    expect(Array.from(p.data)).toEqual([1]);
  });

  it("rejects corrupted frames", () => {
    const frame = commands.getClock();
    const badHeader = frame.slice();
    badHeader[3]! ^= 0xff;
    expect(() => decodeFrame(badHeader)).toThrow(FrameError);
    const badBody = frame.slice();
    badBody[badBody.length - 1]! ^= 0xff;
    expect(() => decodeFrame(badBody)).toThrow(/CRC-32/);
    expect(() => decodeFrame(frame.subarray(0, 6))).toThrow(FrameError);
  });

  it("reassembles packets split across notifications and skips garbage", () => {
    const a = encodePacket({ type: PacketType.HISTORICAL_DATA, seq: 12, cmd: 0, data: encodeHistoryData({ ts: 1_700_000_000, hr: 61, rr: [980], version: 12 }) });
    const b = commands.battery();
    const stream = new Uint8Array([0x01, 0x02, ...a, ...b]);
    const asm = new FrameAssembler();
    const got = [...asm.push(stream.subarray(0, 50)), ...asm.push(stream.subarray(50, 90)), ...asm.push(stream.subarray(90))];
    expect(got).toHaveLength(2);
    expect(got[0]!.packet.type).toBe(PacketType.HISTORICAL_DATA);
    expect(hex(got[0]!.frame)).toBe(hex(a));
    expect(got[1]!.packet.cmd).toBe(Command.GET_BATTERY_LEVEL);
  });
});

describe("history records", () => {
  it("decodes the full-sensor layout", () => {
    const data = encodeHistoryData({
      ts: 1_700_000_000,
      hr: 72,
      rr: [830, 845],
      version: 12,
      sensor: {
        ppgGreen: 5000, ppgRedIr: 3000, gravity: [0.01, 0.02, 0.98], skinContact: 1,
        spo2Red: 1200, spo2Ir: 1500, skinTempRaw: 850, ambientLight: 100, respRaw: 16, signalQuality: 95,
      },
    });
    const p = decodeFrame(encodePacket({ type: PacketType.HISTORICAL_DATA, seq: 12, cmd: 0, data }));
    expect(isFullSensor(p)).toBe(true);
    const r = decodeHistory(p);
    expect(r).toMatchObject({ ts: 1_700_000_000, hr: 72, rr: [830, 845], version: 12 });
    expect(r.sensor!.gravity[2]).toBeCloseTo(0.98, 5);
    expect(r.sensor).toMatchObject({ skinContact: 1, spo2Red: 1200, spo2Ir: 1500, skinTempRaw: 850, respRaw: 16 });
    expect(skinTempC(850)).toBeCloseTo(34.0);
    expect(skinTempC(10)).toBeNull();
  });

  it("decodes the generic layout (HR + RR only)", () => {
    const data = new Uint8Array(24);
    const v = new DataView(data.buffer);
    v.setUint32(4, 1_700_000_000, true);
    data[14] = 65;
    data[15] = 1;
    v.setUint16(16, 920, true);
    const r = decodeHistory({ type: PacketType.HISTORICAL_DATA, seq: 6, cmd: 0, data });
    expect(r).toEqual({ ts: 1_700_000_000, hr: 65, rr: [920], version: 6 });
  });

  it("reads the trim pointer from HISTORY_END", () => {
    const data = new Uint8Array(20);
    new DataView(data.buffer).setUint32(10, 123456, true);
    expect(decodeMetadata({ type: PacketType.METADATA, seq: 0, cmd: 2, data })).toMatchObject({ kind: "end", trim: 123456 });
  });

  it("builds the history ack payload", () => {
    const p = decodeFrame(commands.ackHistory(12345));
    expect(p.cmd).toBe(Command.HISTORICAL_DATA_RESULT);
    expect(Array.from(p.data)).toEqual([1, 0x39, 0x30, 0, 0, 0, 0, 0, 0]);
  });
});
