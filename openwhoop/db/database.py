"""Database handler — CRUD, batch upsert, query helpers."""

from __future__ import annotations

import json
from typing import Sequence

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from ..config import DATABASE_URL
from ..models import HistoryReading
from .schema import (
    Base,
    HeartRateRecord,
    SleepCycleRecord,
    ActivityRecord,
    DailyScoreRecord,
    PacketRecord,
)


class DatabaseHandler:
    def __init__(self, url: str | None = None):
        self.engine = create_engine(url or DATABASE_URL)
        Base.metadata.create_all(self.engine)

    def session(self) -> Session:
        return Session(self.engine)

    # ── Heart rate ───────────────────────────────────────────────────

    def upsert_readings(self, readings: Sequence[HistoryReading]) -> int:
        """Batch upsert heart rate readings. Returns count of new rows."""
        inserted = 0
        with self.session() as s:
            existing = set(
                (row.timestamp, row.subseconds)
                for row in s.execute(
                    select(HeartRateRecord.timestamp, HeartRateRecord.subseconds).where(
                        HeartRateRecord.timestamp.in_(
                            [r.unix_ts for r in readings]
                        )
                    )
                )
            )

            seen = set()
            for r in readings:
                key = (r.unix_ts, r.subseconds)
                if key in existing or key in seen:
                    continue
                seen.add(key)
                rec = HeartRateRecord(
                    timestamp=r.unix_ts,
                    subseconds=r.subseconds,
                    bpm=r.heart_rate,
                    rr_intervals=json.dumps(r.rr_intervals),
                )
                if r.sensor:
                    rec.ppg_green = r.sensor.ppg_green
                    rec.ppg_red_ir = r.sensor.ppg_red_ir
                    rec.gravity_x = r.sensor.gravity_x
                    rec.gravity_y = r.sensor.gravity_y
                    rec.gravity_z = r.sensor.gravity_z
                    rec.skin_contact = r.sensor.on_wrist
                    rec.spo2_red = r.sensor.spo2_red
                    rec.spo2_ir = r.sensor.spo2_ir
                    rec.skin_temp_raw = r.sensor.skin_temp_raw
                    rec.ambient_light = r.sensor.ambient_light
                    rec.resp_rate_raw = r.sensor.resp_rate_raw
                    rec.signal_quality = r.sensor.signal_quality
                    rec.skin_temp = r.sensor.skin_temp_celsius
                s.add(rec)
                inserted += 1
            s.commit()
        return inserted

    def get_hr_range(
        self, start_ts: int, end_ts: int
    ) -> list[HeartRateRecord]:
        """Get heart rate records in a time range."""
        with self.session() as s:
            return list(
                s.scalars(
                    select(HeartRateRecord)
                    .where(HeartRateRecord.timestamp.between(start_ts, end_ts))
                    .order_by(HeartRateRecord.timestamp)
                )
            )

    def get_all_hr(self) -> list[HeartRateRecord]:
        """Get all heart rate records, ordered by time."""
        with self.session() as s:
            return list(
                s.scalars(
                    select(HeartRateRecord).order_by(HeartRateRecord.timestamp)
                )
            )

    # ── Sleep cycles ─────────────────────────────────────────────────

    def save_sleep_cycle(self, cycle: SleepCycleRecord) -> None:
        with self.session() as s:
            s.add(cycle)
            s.commit()

    def get_sleep_cycles(
        self, start_ts: int | None = None, end_ts: int | None = None
    ) -> list[SleepCycleRecord]:
        with self.session() as s:
            q = select(SleepCycleRecord).order_by(SleepCycleRecord.start_ts)
            if start_ts is not None:
                q = q.where(SleepCycleRecord.start_ts >= start_ts)
            if end_ts is not None:
                q = q.where(SleepCycleRecord.end_ts <= end_ts)
            return list(s.scalars(q))

    # ── Activities ───────────────────────────────────────────────────

    def save_activity(self, activity: ActivityRecord) -> None:
        with self.session() as s:
            s.add(activity)
            s.commit()

    # ── Daily scores ─────────────────────────────────────────────────

    def upsert_daily_score(self, score: DailyScoreRecord) -> None:
        with self.session() as s:
            existing = s.scalar(
                select(DailyScoreRecord).where(
                    DailyScoreRecord.date == score.date
                )
            )
            if existing:
                for col in ["recovery", "strain", "sleep_score", "hrv", "rhr", "spo2", "skin_temp", "resp_rate"]:
                    val = getattr(score, col)
                    if val is not None:
                        setattr(existing, col, val)
            else:
                s.add(score)
            s.commit()

    # ── Packet log ───────────────────────────────────────────────────

    def log_packet(self, pkt_type: int, seq: int, cmd: int, raw_hex: str) -> None:
        with self.session() as s:
            s.add(PacketRecord(packet_type=pkt_type, seq=seq, cmd=cmd, raw_hex=raw_hex))
            s.commit()
