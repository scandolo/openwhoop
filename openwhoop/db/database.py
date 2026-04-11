"""Database handler — CRUD, batch upsert, query helpers."""

from __future__ import annotations

import json
from typing import Sequence

from sqlalchemy import create_engine, func, select
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

    # Sensor columns that may be NULL in generic packets but present in V12/V24.
    _SENSOR_COLS = (
        "ppg_green", "ppg_red_ir", "gravity_x", "gravity_y", "gravity_z",
        "skin_contact", "spo2_red", "spo2_ir", "skin_temp_raw",
        "ambient_light", "resp_rate_raw", "signal_quality", "skin_temp",
    )

    def upsert_readings(self, readings: Sequence[HistoryReading]) -> dict:
        """Batch upsert heart rate readings.

        Inserts new readings and upgrades existing rows when the incoming
        packet has richer sensor data (e.g. V12/V24 replacing a generic
        packet). Computed columns (activity, stress, spo2 score) are never
        overwritten.

        Returns:
            Dict with keys: inserted, updated, skipped, latest_ts.
        """
        inserted = 0
        updated = 0
        skipped = 0
        latest_ts: int | None = None

        if not readings:
            return {"inserted": 0, "updated": 0, "skipped": 0, "latest_ts": None}

        with self.session() as s:
            # Load existing records that overlap with incoming timestamps.
            existing_map: dict[tuple[int, int], HeartRateRecord] = {}
            for rec in s.scalars(
                select(HeartRateRecord).where(
                    HeartRateRecord.timestamp.in_(
                        [r.unix_ts for r in readings]
                    )
                )
            ):
                existing_map[(rec.timestamp, rec.subseconds)] = rec

            seen: set[tuple[int, int]] = set()
            for r in readings:
                key = (r.unix_ts, r.subseconds)

                # Track latest timestamp across all received readings.
                if latest_ts is None or r.unix_ts > latest_ts:
                    latest_ts = r.unix_ts

                # Skip duplicates within the same batch.
                if key in seen:
                    skipped += 1
                    continue
                seen.add(key)

                existing = existing_map.get(key)
                if existing is not None:
                    # Row exists. Upgrade sensor columns if the new reading
                    # has richer data (V12/V24) and the existing row doesn't.
                    if r.sensor and existing.gravity_x is None:
                        existing.ppg_green = r.sensor.ppg_green
                        existing.ppg_red_ir = r.sensor.ppg_red_ir
                        existing.gravity_x = r.sensor.gravity_x
                        existing.gravity_y = r.sensor.gravity_y
                        existing.gravity_z = r.sensor.gravity_z
                        existing.skin_contact = r.sensor.on_wrist
                        existing.spo2_red = r.sensor.spo2_red
                        existing.spo2_ir = r.sensor.spo2_ir
                        existing.skin_temp_raw = r.sensor.skin_temp_raw
                        existing.ambient_light = r.sensor.ambient_light
                        existing.resp_rate_raw = r.sensor.resp_rate_raw
                        existing.signal_quality = r.sensor.signal_quality
                        existing.skin_temp = r.sensor.skin_temp_celsius
                        updated += 1
                    else:
                        skipped += 1
                    continue

                # New reading — insert.
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

        return {
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "latest_ts": latest_ts,
        }

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

    def get_latest_timestamp(self) -> int | None:
        """Return the most recent timestamp in the database, or None if empty."""
        with self.session() as s:
            return s.scalar(select(func.max(HeartRateRecord.timestamp)))

    def get_reading_count(self) -> int:
        """Return the total number of heart rate records."""
        with self.session() as s:
            return s.scalar(select(func.count(HeartRateRecord.id))) or 0

    def get_stats(self) -> dict:
        """Return summary statistics about stored data."""
        with self.session() as s:
            total = s.scalar(select(func.count(HeartRateRecord.id))) or 0
            with_sensor = s.scalar(
                select(func.count(HeartRateRecord.id)).where(
                    HeartRateRecord.gravity_x.isnot(None)
                )
            ) or 0
            min_ts = s.scalar(select(func.min(HeartRateRecord.timestamp)))
            max_ts = s.scalar(select(func.max(HeartRateRecord.timestamp)))
            return {
                "total_readings": total,
                "with_sensor_data": with_sensor,
                "generic_only": total - with_sensor,
                "earliest_ts": min_ts,
                "latest_ts": max_ts,
            }

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
