"""SQLAlchemy ORM models for Whoop data storage."""

import json
from datetime import datetime, timezone

from sqlalchemy import (
    Column,
    Integer,
    Float,
    String,
    Boolean,
    Text,
    DateTime,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class HeartRateRecord(Base):
    """One-second heart rate + sensor reading."""

    __tablename__ = "heart_rate"
    __table_args__ = (UniqueConstraint("timestamp", "subseconds", name="uq_hr_timestamp"),)

    id = Column(Integer, primary_key=True)
    timestamp = Column(Integer, nullable=False, index=True)  # unix seconds
    subseconds = Column(Integer, default=0)
    bpm = Column(Integer, nullable=False)
    rr_intervals = Column(Text, default="[]")  # JSON list of ints (ms)

    # Sensor data (V12/V24 only — NULL for generic packets)
    ppg_green = Column(Integer)
    ppg_red_ir = Column(Integer)
    gravity_x = Column(Float)
    gravity_y = Column(Float)
    gravity_z = Column(Float)
    skin_contact = Column(Boolean)
    spo2_red = Column(Integer)
    spo2_ir = Column(Integer)
    skin_temp_raw = Column(Integer)
    ambient_light = Column(Integer)
    resp_rate_raw = Column(Integer)
    signal_quality = Column(Integer)

    # Computed (filled by algorithms later)
    activity = Column(String(16))  # "sleep", "active", "rest"
    stress = Column(Float)
    spo2 = Column(Float)
    skin_temp = Column(Float)

    synced = Column(Boolean, default=False)

    def get_rr_list(self) -> list[int]:
        return json.loads(self.rr_intervals) if self.rr_intervals else []

    def set_rr_list(self, rr: list[int]) -> None:
        self.rr_intervals = json.dumps(rr)


class SleepCycleRecord(Base):
    """A detected sleep period."""

    __tablename__ = "sleep_cycles"

    id = Column(Integer, primary_key=True)
    start_ts = Column(Integer, nullable=False, index=True)
    end_ts = Column(Integer, nullable=False)
    duration_seconds = Column(Integer, nullable=False)
    min_bpm = Column(Integer)
    max_bpm = Column(Integer)
    avg_bpm = Column(Float)
    min_hrv = Column(Float)
    max_hrv = Column(Float)
    avg_hrv = Column(Float)
    score = Column(Float)


class ActivityRecord(Base):
    """A detected activity period."""

    __tablename__ = "activities"

    id = Column(Integer, primary_key=True)
    start_ts = Column(Integer, nullable=False, index=True)
    end_ts = Column(Integer, nullable=False)
    duration_seconds = Column(Integer, nullable=False)
    activity_type = Column(String(32), default="active")
    strain = Column(Float)


class DailyScoreRecord(Base):
    """Daily summary scores."""

    __tablename__ = "daily_scores"
    __table_args__ = (UniqueConstraint("date", name="uq_daily_date"),)

    id = Column(Integer, primary_key=True)
    date = Column(String(10), nullable=False, index=True)  # YYYY-MM-DD
    recovery = Column(Float)
    strain = Column(Float)
    sleep_score = Column(Float)
    hrv = Column(Float)
    rhr = Column(Float)
    spo2 = Column(Float)
    skin_temp = Column(Float)
    resp_rate = Column(Float)


class PacketRecord(Base):
    """Raw packet log for debugging and replay."""

    __tablename__ = "packets"

    id = Column(Integer, primary_key=True)
    received_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    packet_type = Column(Integer, nullable=False)
    seq = Column(Integer)
    cmd = Column(Integer)
    raw_hex = Column(Text, nullable=False)
