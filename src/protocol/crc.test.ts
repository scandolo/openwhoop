import { describe, expect, it } from "vitest";
import { crc32, crc8 } from "./crc.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("crc", () => {
  it("crc8 matches the reference table", () => {
    expect(crc8(new Uint8Array())).toBe(0);
    expect(crc8(new Uint8Array([0x01]))).toBe(0x07);
    expect(crc8(new Uint8Array([0xff]))).toBe(0xf3);
    expect(crc8(enc("123456789"))).toBe(0xf4); // CRC-8/SMBUS check value
  });

  it("crc32 matches zlib", () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(enc("hello world"))).toBe(0x0d4a1185);
  });
});
