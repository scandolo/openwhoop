"""Tests for V12/V24, generic, and IMU packet decoders."""

import struct

import pytest

from openwhoop.protocol.packet import WhoopPacket
from openwhoop.protocol.constants import PacketType
from openwhoop.protocol.decoder import (
    is_v12_v24,
    decode_v12_v24,
    decode_generic,
    decode_historical,
    parse_binary_dump,
)


class TestV12V24Decoder:
    def test_decode_v12(self, sample_v12_data):
        pkt = WhoopPacket.from_data(sample_v12_data)
        assert is_v12_v24(pkt)

        reading = decode_v12_v24(pkt)
        assert reading.unix_ts == 1700000000
        assert reading.subseconds == 1000
        assert reading.heart_rate == 72
        assert reading.rr_intervals == [830, 845]
        assert reading.seq == 12

    def test_sensor_data(self, sample_v12_data):
        pkt = WhoopPacket.from_data(sample_v12_data)
        reading = decode_v12_v24(pkt)
        sensor = reading.sensor

        assert sensor is not None
        assert sensor.ppg_green == 5000
        assert sensor.ppg_red_ir == 3000
        assert abs(sensor.gravity_x - 0.01) < 1e-5
        assert abs(sensor.gravity_z - 0.98) < 1e-5
        assert sensor.skin_contact == 1
        assert sensor.on_wrist is True
        assert sensor.spo2_red == 1200
        assert sensor.spo2_ir == 1500
        assert sensor.skin_temp_raw == 850
        assert abs(sensor.skin_temp_celsius - 34.0) < 0.01
        assert sensor.resp_rate_raw == 16
        assert sensor.signal_quality == 95

    def test_v24_also_detected(self, sample_v12_data):
        """seq=24 should also be detected as V12/V24."""
        # Rebuild with seq=24
        from tests.conftest import build_framed_packet

        data = bytearray(96)
        struct.pack_into("<I", data, 4, 1700000000)
        data[14] = 72
        frame = build_framed_packet(PacketType.HISTORICAL_DATA, 24, 0, bytes(data))

        pkt = WhoopPacket.from_data(frame)
        assert is_v12_v24(pkt)

    def test_non_v12_not_detected(self, sample_generic_data):
        pkt = WhoopPacket.from_data(sample_generic_data)
        assert not is_v12_v24(pkt)


class TestGenericDecoder:
    def test_decode_generic(self, sample_generic_data):
        pkt = WhoopPacket.from_data(sample_generic_data)
        reading = decode_generic(pkt)

        assert reading.unix_ts == 1700000000
        assert reading.heart_rate == 65
        assert reading.rr_intervals == [920]
        assert reading.sensor is None


class TestAutoDetect:
    def test_auto_detects_v12(self, sample_v12_data):
        pkt = WhoopPacket.from_data(sample_v12_data)
        reading = decode_historical(pkt)
        assert reading.sensor is not None

    def test_auto_detects_generic(self, sample_generic_data):
        pkt = WhoopPacket.from_data(sample_generic_data)
        reading = decode_historical(pkt)
        assert reading.sensor is None

    def test_wrong_type_raises(self):
        frame = WhoopPacket.command(42).framed()
        pkt = WhoopPacket.from_data(frame)
        with pytest.raises(ValueError, match="not a historical"):
            decode_historical(pkt)


class TestBinaryDump:
    def test_parse_concatenated(self, sample_v12_data, sample_generic_data):
        dump = sample_v12_data + sample_generic_data
        readings = parse_binary_dump(dump)
        assert len(readings) == 2
        assert readings[0].heart_rate == 72
        assert readings[1].heart_rate == 65

    def test_parse_empty(self):
        assert parse_binary_dump(b"") == []
