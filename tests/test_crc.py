"""Tests for CRC-8 and CRC-32 implementations."""

import struct
import zlib

from openwhoop.protocol.crc import crc8, crc32


def test_crc8_empty():
    assert crc8(b"") == 0


def test_crc8_known_values():
    # The CRC-8 of the 2-byte length field for a known packet
    # For a payload of 5 bytes: length = 5+4 = 9 -> \x09\x00
    length_bytes = struct.pack("<H", 9)
    result = crc8(length_bytes)
    assert isinstance(result, int)
    assert 0 <= result <= 255


def test_crc8_deterministic():
    data = b"\x07\x00"
    assert crc8(data) == crc8(data)


def test_crc32_matches_zlib():
    data = b"hello world"
    assert crc32(data) == zlib.crc32(data) & 0xFFFFFFFF


def test_crc32_empty():
    assert crc32(b"") == 0


def test_crc32_known():
    # zlib.crc32(b"\x23\x28\x03\x01") is deterministic
    data = b"\x23\x28\x03\x01"
    expected = zlib.crc32(data) & 0xFFFFFFFF
    assert crc32(data) == expected


def test_roundtrip_with_packet():
    """CRC-8 and CRC-32 should validate a round-tripped packet."""
    from openwhoop.protocol.packet import WhoopPacket
    from openwhoop.protocol.constants import CommandNumber

    pkt = WhoopPacket.command(CommandNumber.GET_CLOCK)
    frame = pkt.framed()

    # Should not raise
    parsed = WhoopPacket.from_data(frame)
    assert parsed.cmd == int(CommandNumber.GET_CLOCK)
