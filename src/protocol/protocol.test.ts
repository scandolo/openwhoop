import { describe, expect, it } from "vitest";
import { Command, PacketType } from "./constants.ts";
import { command, commands } from "./commands.ts";
import { decodeFrame, encodePacket, FrameAssembler, FrameError } from "./packet.ts";
import { decodeHistory, decodeMetadata, encodeHistoryData } from "./history.ts";
import { batteryEvent, decodeEvent, decodeRealtime, helloFromResponse, versionFromResponse } from "./device.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

// Real captures, CRC-verified (OpenStrap / noop corpora, see docs/protocol.md §8)
const V = {
  sendHistory: "aa0800a823461600699b4cfb",
  setAlarm: "aa100057236d4201d036656600000000f62deb81",
  realtime: "aa1800ff2802ad896566f0654201670600000000000001013ba00d4d",
  wristOn: "aa100057307e0900c2e96e67685d0000a2a61c12",
  battery: "aa2400fa30b003002e316966901f140002e9000000e90e000001010f0301002f01000000699d4a60",
  historyEnd: "aa1c00ab311002a9fc8367205337000000257e00000a0000000000007ac020f8",
  historyAck: "aa10005723001701257e00000a00000095660fa4",
  version: "aa50000c2477070a01012900000011000000020000000000000011000000020000000200000000000000030000000400000000000000000000000300000006000000000000000000000008050100000074b95569",
  hello: "aa8c004a2419230a0104ba02000000eedf6e67a0680000344331383635323239006233636265376430373232323366393138666261623236666536643061393962666236643932656634393436663231653930623031340600000002000000100000002900000010000000060000000000000008020100000000000011000000020000000200000000000000c3425a4e",
  v24: "aa6400a12f1805cb6cc100f7715c67300b805454015700000000000000000000005161cda013a03dcdcc1cbbd723133ee146873f00028a46cdcc1cbbd723133ee146873f28026d029c03700257019004010c020c3000000000000001b9120000000000000a9c4cac",
  v12: "aa5c00f02f0c053f940900da106966280080545401360195040000000000000000a34cff0050bf3b144efb3da4a4463f299c0dbf00004c42144efb3da4a4463f299c0dbff40155023b03530255016004010c020c2000000000000002e8c17c8d",
};

describe("framing", () => {
  it("reproduces the official app's frames byte for byte", () => {
    expect(hex(command(Command.SEND_HISTORICAL_DATA, [0], 0x46).frame)).toBe(V.sendHistory);
    expect(hex(command(Command.SET_ALARM_TIME, [1, 0xd0, 0x36, 0x65, 0x66, 0, 0, 0, 0], 0x6d).frame)).toBe(V.setAlarm);
  });

  it("pads the inner payload to a multiple of 4", () => {
    const f = commands.setClock(1_700_000_000).frame; // 3 + 9 = 12
    expect((f.length - 8) % 4).toBe(0);
    const g = commands.battery().frame; // 3 + 1 → 4
    expect(g.length).toBe(12);
  });

  it("rejects corrupted frames", () => {
    const frame = commands.getClock().frame;
    const badHeader = frame.slice();
    badHeader[3]! ^= 0xff;
    expect(() => decodeFrame(badHeader)).toThrow(FrameError);
    const badBody = frame.slice();
    badBody[badBody.length - 1]! ^= 0xff;
    expect(() => decodeFrame(badBody)).toThrow(/CRC-32/);
  });

  it("reassembles fragments, survives stray 0xAA and garbage", () => {
    const a = bytes(V.v24);
    const b = bytes(V.wristOn);
    const stream = new Uint8Array([0xaa, 0x02, 0x99, ...a, 0x00, ...b]);
    const asm = new FrameAssembler();
    const got = [];
    for (let i = 0; i < stream.length; i += 20) got.push(...asm.push(stream.subarray(i, i + 20)));
    expect(got.map((g) => hex(g.frame))).toEqual([V.v24, V.wristOn]);
  });
});

describe("history", () => {
  it("decodes a real v24 record", () => {
    const r = decodeHistory(decodeFrame(bytes(V.v24)))!;
    expect(r.ts).toBe(1734111735);
    expect(r.hr).toBe(87);
    expect(r.rr).toEqual([]);
    expect(r.sensor!.gravity[0]).toBeCloseTo(-0.0024, 3);
    expect(r.sensor!.gravity[1]).toBeCloseTo(0.1437, 3);
    expect(r.sensor!.gravity[2]).toBeCloseTo(1.0569, 3);
    expect(r.sensor!.spo2Red).toBe(552);
    expect(r.sensor!.skinTempRaw).toBe(924);
  });

  it("decodes a real v12 record with an RR interval", () => {
    const r = decodeHistory(decodeFrame(bytes(V.v12)))!;
    expect(r).toMatchObject({ ts: 1718161626, hr: 54, rr: [1173], version: 12 });
    expect(r.sensor!.gravity[1]).toBeCloseTo(0.7759, 3);
    expect(r.sensor!.skinTempRaw).toBe(827);
  });

  it("parses HISTORY_END and echoes its 8 bytes in the ack", () => {
    const m = decodeMetadata(decodeFrame(bytes(V.historyEnd)));
    expect(m).toMatchObject({ kind: "end", ts: 1736703145, trim: 32293 });
    expect(hex(command(Command.HISTORICAL_DATA_RESULT, [1, ...m.ack!], 0).frame)).toBe(V.historyAck);
  });

  it("round-trips the simulator's encoder", () => {
    const data = encodeHistoryData({ ts: 1_700_000_000, hr: 61, rr: [980, 1002], version: 12, sensor: { gravity: [0, 0.1, 0.99], ppgGreen: 1, spo2Red: 2, spo2Ir: 3, skinTempRaw: 860, ambientLight: 4 } });
    const r = decodeHistory(decodeFrame(encodePacket({ type: PacketType.HISTORICAL_DATA, seq: 12, cmd: 0, data })))!;
    expect(r).toMatchObject({ ts: 1_700_000_000, hr: 61, rr: [980, 1002] });
  });

  it("skips layouts without heart rate", () => {
    expect(decodeHistory({ type: PacketType.HISTORICAL_DATA, seq: 25, cmd: 0, data: new Uint8Array(100) })).toBeNull();
  });
});

describe("device packets", () => {
  it("decodes realtime heart rate", () => {
    expect(decodeRealtime(decodeFrame(bytes(V.realtime)))).toEqual({ ts: 1717930413, hr: 66, rr: [1639], wearing: true });
  });

  it("decodes events", () => {
    const wrist = decodeEvent(decodeFrame(bytes(V.wristOn)))!;
    expect(wrist).toMatchObject({ id: 9, ts: 1735322050 });
    const bat = batteryEvent(decodeEvent(decodeFrame(bytes(V.battery)))!)!;
    expect(bat.pct).toBeCloseTo(23.3);
    expect(bat.mV).toBe(3817);
    expect(bat.charging).toBe(true);
  });

  it("decodes hello and version replies", () => {
    expect(helloFromResponse(decodeFrame(bytes(V.hello)))).toMatchObject({ battery: 69.8, clock: 1735319534, serial: "4C1865229" });
    expect(versionFromResponse(decodeFrame(bytes(V.version)))).toEqual({ harvard: "41.17.2.0", boylston: "17.2.2.0" });
  });
});
