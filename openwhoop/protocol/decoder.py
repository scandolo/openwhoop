"""Decode historical packets into HistoryReading / ImuPacket objects.

Supports three modes:
- V12/V24: Full 96-byte sensor data (seq=12 or seq=24, payload >= 77 bytes)
- Generic: HR + RR only (any other historical packet)
- IMU: 100 accelerometer + gyroscope samples (>= 1188 bytes)
"""

from __future__ import annotations

import struct

from ..models import HistoryReading, SensorData, ImuSample, ImuPacket
from .constants import PacketType
from .packet import WhoopPacket


def is_v12_v24(pkt: WhoopPacket) -> bool:
    """Check if packet is a V12/V24 full-sensor historical packet."""
    return (
        pkt.type == PacketType.HISTORICAL_DATA
        and pkt.seq in (12, 24)
        and len(pkt.data) >= 77
    )


def is_imu_packet(pkt: WhoopPacket) -> bool:
    """Check if packet is a historical IMU packet."""
    return (
        pkt.type == PacketType.HISTORICAL_IMU_DATA_STREAM
        and len(pkt.data) >= 1188
    )


def decode_v12_v24(pkt: WhoopPacket) -> HistoryReading:
    """Decode a V12/V24 packet into a HistoryReading with full sensor data.

    Byte offsets (within pkt.data, which starts after type+seq+cmd):
      [0:4]   u32 LE  sequence number
      [4:8]   u32 LE  unix timestamp
      [8:10]  u16 LE  subseconds
      [10:12] u16 LE  flags
      [12]    u8      sensor_m
      [13]    u8      sensor_n
      [14]    u8      heart rate
      [15]    u8      RR count (0-4)
      [16:24] u16 LE  RR intervals ×4
      [24:26] u16 LE  ppg_flags
      [26:28] u16 LE  ppg_green
      [28:30] u16 LE  ppg_red_ir
      [33:45] f32 LE  gravity [x, y, z]
      [48]    u8      skin_contact
      [61:63] u16 LE  spo2_red
      [63:65] u16 LE  spo2_ir
      [65:67] u16 LE  skin_temp_raw
      [67:69] u16 LE  ambient_light
      [69:71] u16 LE  led_drive_1
      [71:73] u16 LE  led_drive_2
      [73:75] u16 LE  resp_rate_raw
      [75:77] u16 LE  signal_quality
    """
    d = pkt.data
    seq_num = struct.unpack_from("<I", d, 0)[0]
    unix_ts = struct.unpack_from("<I", d, 4)[0]
    subsec = struct.unpack_from("<H", d, 8)[0]
    flags = struct.unpack_from("<H", d, 10)[0]
    sensor_m = d[12]
    sensor_n = d[13]
    heart_rate = d[14]
    rr_count = d[15]

    rr = [struct.unpack_from("<H", d, 16 + i * 2)[0] for i in range(min(rr_count, 4))]

    sensor = SensorData(
        ppg_flags=struct.unpack_from("<H", d, 24)[0],
        ppg_green=struct.unpack_from("<H", d, 26)[0],
        ppg_red_ir=struct.unpack_from("<H", d, 28)[0],
        gravity_x=struct.unpack_from("<f", d, 33)[0],
        gravity_y=struct.unpack_from("<f", d, 37)[0],
        gravity_z=struct.unpack_from("<f", d, 41)[0],
        skin_contact=d[48],
        spo2_red=struct.unpack_from("<H", d, 61)[0],
        spo2_ir=struct.unpack_from("<H", d, 63)[0],
        skin_temp_raw=struct.unpack_from("<H", d, 65)[0],
        ambient_light=struct.unpack_from("<H", d, 67)[0],
        led_drive_1=struct.unpack_from("<H", d, 69)[0],
        led_drive_2=struct.unpack_from("<H", d, 71)[0],
        resp_rate_raw=struct.unpack_from("<H", d, 73)[0],
        signal_quality=struct.unpack_from("<H", d, 75)[0],
    )

    return HistoryReading(
        unix_ts=unix_ts,
        subseconds=subsec,
        heart_rate=heart_rate,
        rr_intervals=rr,
        sensor=sensor,
        seq=pkt.seq,
        flags=flags,
        sensor_m=sensor_m,
        sensor_n=sensor_n,
    )


def decode_generic(pkt: WhoopPacket) -> HistoryReading:
    """Decode a generic historical packet (HR + RR only, like whoomp's parser).

    pkt.data layout:
      [0:4]   u32 LE  sequence number
      [4:8]   u32 LE  unix timestamp
      [8:10]  u16 LE  subseconds
      [10:14] u32 LE  unknown/flags
      [14]    u8      heart rate
      [15]    u8      RR count
      [16:24] u16 LE  RR intervals ×4
    """
    d = pkt.data
    unix_ts = struct.unpack_from("<I", d, 4)[0]
    subsec = struct.unpack_from("<H", d, 8)[0]
    flags = struct.unpack_from("<I", d, 10)[0]
    heart_rate = d[14]
    rr_count = d[15]

    rr = [struct.unpack_from("<H", d, 16 + i * 2)[0] for i in range(min(rr_count, 4))]

    return HistoryReading(
        unix_ts=unix_ts,
        subseconds=subsec,
        heart_rate=heart_rate,
        rr_intervals=rr,
        seq=pkt.seq,
        flags=flags,
    )


def decode_imu(pkt: WhoopPacket) -> ImuPacket:
    """Decode a historical IMU packet (100 samples of accel + gyro).

    Offsets within pkt.data:
      ACC_X: 85,  100 × i16 BE, /1875.0 → g
      ACC_Y: 285, 100 × i16 BE, /1875.0 → g
      ACC_Z: 485, 100 × i16 BE, /1875.0 → g
      GYR_X: 688, 100 × i16 BE, /15.0 → dps
      GYR_Y: 888, 100 × i16 BE, /15.0 → dps
      GYR_Z: 1088,100 × i16 BE, /15.0 → dps
    """
    d = pkt.data
    unix_ts = struct.unpack_from("<I", d, 4)[0]
    subsec = struct.unpack_from("<H", d, 8)[0]

    samples = []
    for i in range(100):
        ax = struct.unpack_from(">h", d, 85 + i * 2)[0] / 1875.0
        ay = struct.unpack_from(">h", d, 285 + i * 2)[0] / 1875.0
        az = struct.unpack_from(">h", d, 485 + i * 2)[0] / 1875.0
        gx = struct.unpack_from(">h", d, 688 + i * 2)[0] / 15.0
        gy = struct.unpack_from(">h", d, 888 + i * 2)[0] / 15.0
        gz = struct.unpack_from(">h", d, 1088 + i * 2)[0] / 15.0
        samples.append(ImuSample(ax, ay, az, gx, gy, gz))

    return ImuPacket(unix_ts=unix_ts, subseconds=subsec, samples=samples)


def decode_historical(pkt: WhoopPacket) -> HistoryReading:
    """Auto-detect and decode any historical data packet."""
    if pkt.type != PacketType.HISTORICAL_DATA:
        raise ValueError(f"not a historical packet: {pkt.type}")
    if is_v12_v24(pkt):
        return decode_v12_v24(pkt)
    return decode_generic(pkt)


def parse_binary_dump(data: bytes) -> list[HistoryReading]:
    """Parse a raw binary dump file (concatenated framed packets) into readings."""
    readings = []
    pos = 0
    while pos < len(data):
        if pos + 4 > len(data):
            break
        length = struct.unpack_from("<H", data, pos + 1)[0] + 4  # +4 for CRC-32
        if pos + length > len(data):
            break
        try:
            pkt = WhoopPacket.from_data(data[pos : pos + length])
            if pkt.type == PacketType.HISTORICAL_DATA:
                readings.append(decode_historical(pkt))
        except (ValueError, struct.error):
            pass
        pos += length
    return readings
