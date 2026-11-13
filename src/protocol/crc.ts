// CRC-8 (poly 0x07, init 0x00) guards the 2-byte length header.
// CRC-32 (IEEE, same as zlib.crc32) guards the payload.

const CRC8_TABLE = new Uint8Array(256);
const CRC32_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let c8 = i;
  for (let b = 0; b < 8; b++) c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
  CRC8_TABLE[i] = c8;

  let c32 = i;
  for (let b = 0; b < 8; b++) c32 = c32 & 1 ? (c32 >>> 1) ^ 0xedb88320 : c32 >>> 1;
  CRC32_TABLE[i] = c32 >>> 0;
}

export function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = CRC8_TABLE[crc ^ b]!;
  return crc;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC32_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
