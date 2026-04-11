"""Tests for database operations."""

import pytest

from openwhoop.db.database import DatabaseHandler
from openwhoop.db.schema import HeartRateRecord, SleepCycleRecord, DailyScoreRecord
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
        result = db.upsert_readings(readings)
        assert result["inserted"] == 2
        assert result["updated"] == 0
        assert result["skipped"] == 0
        assert result["latest_ts"] == 1001

    def test_dedup(self, db):
        readings = [HistoryReading(unix_ts=1000, subseconds=0, heart_rate=72)]
        db.upsert_readings(readings)
        result = db.upsert_readings(readings)
        assert result["inserted"] == 0
        assert result["skipped"] == 1

    def test_dedup_within_batch(self, db):
        """Duplicate timestamps within the same batch are skipped."""
        readings = [
            HistoryReading(unix_ts=1000, subseconds=0, heart_rate=72),
            HistoryReading(unix_ts=1000, subseconds=0, heart_rate=75),
        ]
        result = db.upsert_readings(readings)
        assert result["inserted"] == 1
        assert result["skipped"] == 1
        # First value wins
        records = db.get_all_hr()
        assert records[0].bpm == 72

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

    def test_empty_readings(self, db):
        result = db.upsert_readings([])
        assert result["inserted"] == 0
        assert result["updated"] == 0
        assert result["skipped"] == 0
        assert result["latest_ts"] is None

    def test_upgrade_generic_to_v12(self, db):
        """When a generic packet (no sensor data) is already stored and a
        V12/V24 packet arrives for the same timestamp, the existing row
        should be upgraded with the richer sensor columns."""
        # Insert generic reading (no sensor data).
        generic = [HistoryReading(unix_ts=3000, subseconds=0, heart_rate=68)]
        db.upsert_readings(generic)

        # Verify sensor columns are NULL.
        records = db.get_all_hr()
        assert records[0].gravity_x is None
        assert records[0].spo2_red is None

        # Re-download with V12/V24 sensor data.
        v12 = [
            HistoryReading(
                unix_ts=3000, subseconds=0, heart_rate=68,
                sensor=SensorData(
                    gravity_x=0.05, gravity_y=0.03, gravity_z=0.97,
                    skin_contact=1, spo2_red=1100, spo2_ir=1400,
                    skin_temp_raw=800, ambient_light=120,
                    resp_rate_raw=15, signal_quality=90,
                    ppg_green=4500, ppg_red_ir=2800,
                ),
            )
        ]
        result = db.upsert_readings(v12)
        assert result["inserted"] == 0
        assert result["updated"] == 1
        assert result["skipped"] == 0

        # Verify sensor columns are now filled.
        records = db.get_all_hr()
        assert len(records) == 1
        assert records[0].gravity_x == pytest.approx(0.05)
        assert records[0].spo2_red == 1100
        assert records[0].spo2_ir == 1400
        assert records[0].skin_temp_raw == 800
        assert records[0].ppg_green == 4500
        assert records[0].skin_temp == pytest.approx(32.0)

    def test_upgrade_preserves_computed_columns(self, db):
        """Upgrading sensor data must not overwrite algorithm-computed columns."""
        # Insert generic, then manually set computed columns.
        generic = [HistoryReading(unix_ts=4000, subseconds=0, heart_rate=70)]
        db.upsert_readings(generic)

        with db.session() as s:
            rec = s.scalars(
                __import__("sqlalchemy").select(HeartRateRecord).where(
                    HeartRateRecord.timestamp == 4000
                )
            ).one()
            rec.activity = "sleep"
            rec.stress = 1.5
            s.commit()

        # Upgrade with V12 sensor data.
        v12 = [
            HistoryReading(
                unix_ts=4000, subseconds=0, heart_rate=70,
                sensor=SensorData(
                    gravity_x=0.01, gravity_y=0.02, gravity_z=0.99,
                    skin_contact=1, spo2_red=1300, spo2_ir=1600,
                    skin_temp_raw=860,
                ),
            )
        ]
        db.upsert_readings(v12)

        records = db.get_all_hr()
        assert records[0].activity == "sleep"
        assert records[0].stress == pytest.approx(1.5)
        assert records[0].gravity_x == pytest.approx(0.01)

    def test_no_downgrade_v12_to_generic(self, db):
        """If a V12 record exists and a generic packet arrives, don't downgrade."""
        v12 = [
            HistoryReading(
                unix_ts=5000, subseconds=0, heart_rate=75,
                sensor=SensorData(
                    gravity_x=0.1, gravity_y=0.2, gravity_z=0.9,
                    skin_contact=1, spo2_red=1200, spo2_ir=1500,
                    skin_temp_raw=850,
                ),
            )
        ]
        db.upsert_readings(v12)

        # Re-download as generic (no sensor).
        generic = [HistoryReading(unix_ts=5000, subseconds=0, heart_rate=75)]
        result = db.upsert_readings(generic)
        assert result["skipped"] == 1
        assert result["updated"] == 0

        # Sensor columns preserved.
        records = db.get_all_hr()
        assert records[0].gravity_x == pytest.approx(0.1)
        assert records[0].spo2_red == 1200

    def test_no_downgrade_v12_to_v12(self, db):
        """If a V12 record exists and another V12 arrives, skip (don't double-update)."""
        sensor = SensorData(
            gravity_x=0.1, gravity_y=0.2, gravity_z=0.9,
            skin_contact=1, spo2_red=1200, spo2_ir=1500,
            skin_temp_raw=850,
        )
        v12 = [HistoryReading(unix_ts=6000, subseconds=0, heart_rate=80, sensor=sensor)]
        db.upsert_readings(v12)

        result = db.upsert_readings(v12)
        assert result["skipped"] == 1
        assert result["updated"] == 0

    def test_latest_ts_across_batch(self, db):
        """latest_ts reflects the most recent timestamp in the batch,
        regardless of insert/skip status."""
        readings = [
            HistoryReading(unix_ts=100, subseconds=0, heart_rate=60),
            HistoryReading(unix_ts=200, subseconds=0, heart_rate=62),
            HistoryReading(unix_ts=150, subseconds=0, heart_rate=61),
        ]
        result = db.upsert_readings(readings)
        assert result["latest_ts"] == 200

    def test_mixed_insert_update_skip(self, db):
        """A batch can contain a mix of new, upgradeable, and duplicate readings."""
        # Seed: one generic, one V12.
        db.upsert_readings([
            HistoryReading(unix_ts=7000, subseconds=0, heart_rate=60),
            HistoryReading(
                unix_ts=7001, subseconds=0, heart_rate=61,
                sensor=SensorData(
                    gravity_x=0.1, gravity_y=0.2, gravity_z=0.9,
                    skin_contact=1, spo2_red=1200, spo2_ir=1500,
                    skin_temp_raw=850,
                ),
            ),
        ])

        # New batch: upgrade 7000, skip 7001, insert 7002.
        result = db.upsert_readings([
            HistoryReading(
                unix_ts=7000, subseconds=0, heart_rate=60,
                sensor=SensorData(
                    gravity_x=0.05, gravity_y=0.03, gravity_z=0.97,
                    skin_contact=1, spo2_red=1100, spo2_ir=1400,
                    skin_temp_raw=800,
                ),
            ),
            HistoryReading(
                unix_ts=7001, subseconds=0, heart_rate=61,
                sensor=SensorData(
                    gravity_x=0.1, gravity_y=0.2, gravity_z=0.9,
                    skin_contact=1, spo2_red=1200, spo2_ir=1500,
                    skin_temp_raw=850,
                ),
            ),
            HistoryReading(unix_ts=7002, subseconds=0, heart_rate=62),
        ])
        assert result["inserted"] == 1
        assert result["updated"] == 1
        assert result["skipped"] == 1


class TestHRRange:
    def test_range_query(self, db):
        readings = [HistoryReading(unix_ts=i, subseconds=0, heart_rate=60 + i) for i in range(10)]
        db.upsert_readings(readings)

        results = db.get_hr_range(3, 7)
        assert len(results) == 5
        assert results[0].bpm == 63


class TestQueryHelpers:
    def test_latest_timestamp_empty(self, db):
        assert db.get_latest_timestamp() is None

    def test_latest_timestamp(self, db):
        db.upsert_readings([
            HistoryReading(unix_ts=100, subseconds=0, heart_rate=60),
            HistoryReading(unix_ts=500, subseconds=0, heart_rate=65),
            HistoryReading(unix_ts=300, subseconds=0, heart_rate=62),
        ])
        assert db.get_latest_timestamp() == 500

    def test_reading_count_empty(self, db):
        assert db.get_reading_count() == 0

    def test_reading_count(self, db):
        db.upsert_readings([
            HistoryReading(unix_ts=i, subseconds=0, heart_rate=60)
            for i in range(25)
        ])
        assert db.get_reading_count() == 25

    def test_stats(self, db):
        # Insert mix of generic and V12 readings.
        db.upsert_readings([
            HistoryReading(unix_ts=1000, subseconds=0, heart_rate=60),
            HistoryReading(unix_ts=1001, subseconds=0, heart_rate=61),
            HistoryReading(
                unix_ts=1002, subseconds=0, heart_rate=62,
                sensor=SensorData(
                    gravity_x=0.1, gravity_y=0.2, gravity_z=0.9,
                    skin_contact=1, spo2_red=1200, spo2_ir=1500,
                    skin_temp_raw=850,
                ),
            ),
        ])
        stats = db.get_stats()
        assert stats["total_readings"] == 3
        assert stats["with_sensor_data"] == 1
        assert stats["generic_only"] == 2
        assert stats["earliest_ts"] == 1000
        assert stats["latest_ts"] == 1002


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
