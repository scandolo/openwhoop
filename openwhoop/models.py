"""Data models for parsed Whoop sensor readings."""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class SensorData:
    """Full sensor payload from a V12/V24 historical packet."""

    ppg_flags: int = 0
    ppg_green: int = 0
    ppg_red_ir: int = 0
    gravity_x: float = 0.0
    gravity_y: float = 0.0
    gravity_z: float = 0.0
    skin_contact: int = 0
    spo2_red: int = 0
    spo2_ir: int = 0
    skin_temp_raw: int = 0
    ambient_light: int = 0
    led_drive_1: int = 0
    led_drive_2: int = 0
    resp_rate_raw: int = 0
    signal_quality: int = 0

    @property
    def skin_temp_celsius(self) -> float:
        return self.skin_temp_raw * 0.04

    @property
    def on_wrist(self) -> bool:
        return self.skin_contact != 0


@dataclass
class HistoryReading:
    """One second of decoded historical data (HR, RR, and optional full sensor data)."""

    unix_ts: int
    subseconds: int
    heart_rate: int
    rr_intervals: list[int] = field(default_factory=list)
    sensor: SensorData | None = None

    # Packet-level metadata
    seq: int = 0
    flags: int = 0
    sensor_m: int = 0
    sensor_n: int = 0

    @property
    def timestamp(self) -> datetime:
        return datetime.fromtimestamp(self.unix_ts, tz=timezone.utc)

    @property
    def has_sensor_data(self) -> bool:
        return self.sensor is not None


@dataclass
class ImuSample:
    """A single IMU sample (accelerometer + gyroscope)."""

    accel_x: float  # g
    accel_y: float  # g
    accel_z: float  # g
    gyro_x: float  # degrees per second
    gyro_y: float  # degrees per second
    gyro_z: float  # degrees per second


@dataclass
class ImuPacket:
    """100 IMU samples from one historical IMU packet."""

    unix_ts: int
    subseconds: int
    samples: list[ImuSample] = field(default_factory=list)


@dataclass
class SleepCycle:
    """A detected sleep period."""

    start_ts: int
    end_ts: int

    @property
    def duration_seconds(self) -> int:
        return self.end_ts - self.start_ts

    @property
    def duration_hours(self) -> float:
        return self.duration_seconds / 3600


@dataclass
class ActivityPeriod:
    """A detected activity (non-sleep, non-rest) period."""

    start_ts: int
    end_ts: int

    @property
    def duration_seconds(self) -> int:
        return self.end_ts - self.start_ts

    @property
    def duration_minutes(self) -> float:
        return self.duration_seconds / 60
