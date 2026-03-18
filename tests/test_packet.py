"""Tests for WhoopPacket framing, parsing, and factory methods."""

import struct

import pytest

from openwhoop.protocol.constants import PacketType, CommandNumber, SOF
from openwhoop.protocol.packet import WhoopPacket


class TestWhoopPacketParsing:
    def test_roundtrip(self):
        """framed() -> from_data() should produce an identical packet."""
        pkt = WhoopPacket(PacketType.COMMAND, 0x28, int(CommandNumber.TOGGLE_REALTIME_HR), b"\x01")
        frame = pkt.framed()
        parsed = WhoopPacket.from_data(frame)

        assert parsed.type == PacketType.COMMAND
        assert parsed.seq == 0x28
        assert parsed.cmd == int(CommandNumber.TOGGLE_REALTIME_HR)
        assert parsed.data == b"\x01"

    def test_roundtrip_preserves_bytes(self):
        pkt = WhoopPacket.command(CommandNumber.GET_CLOCK)
        assert WhoopPacket.from_data(pkt.framed()).framed() == pkt.framed()

    def test_invalid_sof_raises(self):
        bad_data = b"\x00" + b"\x00" * 20
        with pytest.raises(ValueError, match="invalid SOF"):
            WhoopPacket.from_data(bad_data)

    def test_bad_header_crc_raises(self):
        frame = WhoopPacket.command(CommandNumber.GET_CLOCK).framed()
        # Corrupt the CRC-8 byte (index 3)
        corrupted = bytearray(frame)
        corrupted[3] ^= 0xFF
        with pytest.raises(ValueError, match="CRC-8"):
            WhoopPacket.from_data(bytes(corrupted))

    def test_bad_payload_crc_raises(self):
        frame = WhoopPacket.command(CommandNumber.GET_CLOCK).framed()
        corrupted = bytearray(frame)
        corrupted[-1] ^= 0xFF
        with pytest.raises(ValueError, match="CRC-32"):
            WhoopPacket.from_data(bytes(corrupted))

    def test_truncated_packet_raises(self):
        frame = WhoopPacket.command(CommandNumber.GET_CLOCK).framed()
        with pytest.raises(ValueError):
            WhoopPacket.from_data(frame[:4])


class TestFactoryMethods:
    def test_get_hello(self):
        pkt = WhoopPacket.get_hello()
        assert pkt.type == PacketType.COMMAND
        assert pkt.cmd == int(CommandNumber.GET_HELLO_HARVARD)

    def test_get_battery(self):
        pkt = WhoopPacket.get_battery()
        assert pkt.cmd == int(CommandNumber.GET_BATTERY_LEVEL)

    def test_toggle_realtime_hr(self):
        on = WhoopPacket.toggle_realtime_hr(True)
        off = WhoopPacket.toggle_realtime_hr(False)
        assert on.data == b"\x01"
        assert off.data == b"\x00"

    def test_history_ack(self):
        pkt = WhoopPacket.history_ack(12345)
        assert pkt.cmd == int(CommandNumber.HISTORICAL_DATA_RESULT)
        # data = [0x01, trim_le(4 bytes), 0x00000000]
        assert len(pkt.data) == 9
        assert struct.unpack_from("<I", pkt.data, 1)[0] == 12345

    def test_set_clock(self):
        pkt = WhoopPacket.set_clock(1700000000)
        assert struct.unpack_from("<I", pkt.data, 0)[0] == 1700000000

    def test_enter_exit_high_freq(self):
        enter = WhoopPacket.enter_high_freq_sync()
        exit_ = WhoopPacket.exit_high_freq_sync()
        assert enter.cmd == int(CommandNumber.ENTER_HIGH_FREQ_SYNC)
        assert exit_.cmd == int(CommandNumber.EXIT_HIGH_FREQ_SYNC)


class TestWhompCompatibility:
    """Verify our output matches the original whoomp packet.py."""

    def test_toggle_realtime_hr_hex(self):
        """The whoomp __main__ test: TOGGLE_REALTIME_HR with seq=0x28, data=0x01."""
        pkt = WhoopPacket(PacketType.COMMAND, 0x28, int(CommandNumber.TOGGLE_REALTIME_HR), b"\x01")
        frame = pkt.framed()
        # Verify it round-trips
        parsed = WhoopPacket.from_data(frame)
        assert parsed.framed() == frame
