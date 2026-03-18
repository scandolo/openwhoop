"""Shared test fixtures — sample packets, in-memory DB."""

import struct
import zlib

import pytest

from openwhoop.protocol.constants import PacketType, CommandNumber, SOF
from openwhoop.protocol.crc import crc8, crc32
from openwhoop.protocol.packet import WhoopPacket
from openwhoop.models import HistoryReading, SensorData


def build_framed_packet(packet_type: int, seq: int, cmd: int, data: bytes) -> bytes:
    """Build a raw framed packet for testing."""
    payload = struct.pack("<BBB", packet_type, seq, cmd) + data
    length_bytes = struct.pack("<H", len(payload) + 4)
    hdr_crc = struct.pack("<B", crc8(length_bytes))
    body_crc = struct.pack("<I", crc32(payload))
    return struct.pack("<B", SOF) + length_bytes + hdr_crc + payload + body_crc


@pytest.fixture
def sample_command_frame() -> bytes:
    """A framed TOGGLE_REALTIME_HR command (from whoomp's __main__ test)."""
    pkt = WhoopPacket.command(CommandNumber.TOGGLE_REALTIME_HR, b"\x01", seq=0x28)
    return pkt.framed()


@pytest.fixture
def sample_v12_data() -> bytes:
    """Build a synthetic V12 historical packet with known sensor values."""
    # Construct 96 bytes of data payload
    data = bytearray(96)
    # sequence number
    struct.pack_into("<I", data, 0, 42)
    # unix timestamp
    struct.pack_into("<I", data, 4, 1700000000)
    # subseconds
    struct.pack_into("<H", data, 8, 1000)
    # flags
    struct.pack_into("<H", data, 10, 0)
    # sensor_m, sensor_n
    data[12] = 1
    data[13] = 2
    # heart rate
    data[14] = 72
    # rr count
    data[15] = 2
    # rr intervals
    struct.pack_into("<H", data, 16, 830)
    struct.pack_into("<H", data, 18, 845)
    # ppg
    struct.pack_into("<H", data, 24, 0)
    struct.pack_into("<H", data, 26, 5000)
    struct.pack_into("<H", data, 28, 3000)
    # gravity
    struct.pack_into("<f", data, 33, 0.01)
    struct.pack_into("<f", data, 37, 0.02)
    struct.pack_into("<f", data, 41, 0.98)
    # skin contact
    data[48] = 1
    # spo2
    struct.pack_into("<H", data, 61, 1200)
    struct.pack_into("<H", data, 63, 1500)
    # skin temp
    struct.pack_into("<H", data, 65, 850)
    # ambient
    struct.pack_into("<H", data, 67, 100)
    # led drives
    struct.pack_into("<H", data, 69, 200)
    struct.pack_into("<H", data, 71, 150)
    # resp rate
    struct.pack_into("<H", data, 73, 16)
    # signal quality
    struct.pack_into("<H", data, 75, 95)

    return build_framed_packet(PacketType.HISTORICAL_DATA, 12, 0, bytes(data))


@pytest.fixture
def sample_generic_data() -> bytes:
    """Build a synthetic generic historical packet (not V12/V24)."""
    data = bytearray(24)
    struct.pack_into("<I", data, 0, 1)       # sequence
    struct.pack_into("<I", data, 4, 1700000000)  # unix ts
    struct.pack_into("<H", data, 8, 500)     # subseconds
    struct.pack_into("<I", data, 10, 0)      # flags
    data[14] = 65                            # heart rate
    data[15] = 1                             # rr count
    struct.pack_into("<H", data, 16, 920)    # rr interval

    return build_framed_packet(PacketType.HISTORICAL_DATA, 6, 0, bytes(data))


@pytest.fixture
def in_memory_db():
    """Create an in-memory SQLite database handler."""
    from openwhoop.db.database import DatabaseHandler
    return DatabaseHandler("sqlite:///:memory:")


@pytest.fixture
def sample_readings() -> list[HistoryReading]:
    """Generate a list of sample readings for algorithm tests."""
    readings = []
    base_ts = 1700000000
    for i in range(1000):
        sensor = SensorData(
            gravity_x=0.01 + (0.001 if i % 100 > 80 else 0.0),
            gravity_y=0.02,
            gravity_z=0.98,
            skin_contact=1,
            spo2_red=1200 + (i % 10),
            spo2_ir=1500 + (i % 10),
            skin_temp_raw=850,
        )
        readings.append(HistoryReading(
            unix_ts=base_ts + i,
            subseconds=0,
            heart_rate=60 + (i % 30),
            rr_intervals=[800 + (i % 50), 810 + (i % 50)],
            sensor=sensor,
        ))
    return readings
