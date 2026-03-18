"""Tests for database operations."""

import pytest

from openwhoop.db.database import DatabaseHandler
from openwhoop.db.schema import SleepCycleRecord, DailyScoreRecord
from openwhoop.models import HistoryReading, SensorData


@pytest.fixture
def db():
    return DatabaseHandler("sqlite:///:memory:")


class TestUpsertReadings:
    def test_insert(self, db):
        readings = [
            HistoryReading(unix_ts=1000, subseconds=0, heart_rate=72, rr_intervals=[800]),
            HistoryReading(unix_ts=1001, subseconds=0, heart_rate=73, rr_intervals=[810, 820]),
        ]
        inserted = db.upsert_readings(readings)
        assert inserted == 2

    def test_dedup(self, db):
        readings = [HistoryReading(unix_ts=1000, subseconds=0, heart_rate=72)]
        db.upsert_readings(readings)
        inserted = db.upsert_readings(readings)
        assert inserted == 0

    def test_with_sensor_data(self, db):
        readings = [
            HistoryReading(
                unix_ts=2000, subseconds=0, heart_rate=72,
                sensor=SensorData(
                    gravity_x=0.1, gravity_y=0.2, gravity_z=0.9,
                    skin_contact=1, spo2_red=1200, spo2_ir=1500,
                    skin_temp_raw=850,
                ),
            )
        ]
        db.upsert_readings(readings)
        records = db.get_all_hr()
        assert len(records) == 1
        assert records[0].gravity_x == pytest.approx(0.1)
        assert records[0].skin_temp == pytest.approx(34.0)


class TestHRRange:
    def test_range_query(self, db):
        readings = [HistoryReading(unix_ts=i, subseconds=0, heart_rate=60 + i) for i in range(10)]
        db.upsert_readings(readings)

        results = db.get_hr_range(3, 7)
        assert len(results) == 5
        assert results[0].bpm == 63


class TestSleepCycles:
    def test_save_and_retrieve(self, db):
        cycle = SleepCycleRecord(
            start_ts=1000, end_ts=5000, duration_seconds=4000,
            min_bpm=55, max_bpm=70, avg_bpm=62.5, score=85.0,
        )
        db.save_sleep_cycle(cycle)
        cycles = db.get_sleep_cycles()
        assert len(cycles) == 1
        assert cycles[0].score == 85.0


class TestDailyScores:
    def test_upsert_new(self, db):
        score = DailyScoreRecord(date="2024-01-15", recovery=75.0, strain=12.5)
        db.upsert_daily_score(score)

    def test_upsert_update(self, db):
        score1 = DailyScoreRecord(date="2024-01-15", recovery=75.0)
        db.upsert_daily_score(score1)
        score2 = DailyScoreRecord(date="2024-01-15", strain=12.5)
        db.upsert_daily_score(score2)
