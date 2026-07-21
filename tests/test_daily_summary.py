"""Tests for daily summary computation pipeline."""

import pytest

from openwhoop.db.database import DatabaseHandler
from openwhoop.db.schema import DailyScoreRecord
from openwhoop.models import HistoryReading, SensorData


@pytest.fixture
def db():
    return DatabaseHandler("sqlite:///:memory:")


def _make_readings(base_ts, count, bpm=72, rr=800,
                   spo2_red=1200, spo2_ir=1500, skin_temp_raw=850):
    """Generate count readings starting at base_ts, 1 per second."""
    readings = []
    for i in range(count):
        sensor = SensorData(
            gravity_x=0.01, gravity_y=0.02, gravity_z=0.98,
            skin_contact=1,
            spo2_red=spo2_red + (i % 10),
            spo2_ir=spo2_ir + (i % 10),
            skin_temp_raw=skin_temp_raw,
        )
        readings.append(HistoryReading(
            unix_ts=base_ts + i, subseconds=0,
            heart_rate=bpm + (i % 20),
            rr_intervals=[rr + (i % 50), rr + 10 + (i % 50)],
            sensor=sensor,
        ))
    return readings


class TestGetDayBoundaries:
    def test_empty_db(self, db):
        assert db.get_day_boundaries("UTC") == []

    def test_single_day(self, db):
        # 2024-01-15 12:00:00 UTC = 1705320000
        base_ts = 1705320000
        db.upsert_readings(_make_readings(base_ts, 100))
        days = db.get_day_boundaries("UTC")
        assert len(days) == 1
        assert days[0][0] == "2024-01-15"
        # start_ts should be midnight UTC on Jan 15
        assert days[0][1] == 1705276800

    def test_multi_day(self, db):
        base_ts = 1705276800  # 2024-01-15 00:00:00 UTC
        # Readings on day 1
        db.upsert_readings(_make_readings(base_ts, 100))
        # Readings on day 2
        db.upsert_readings(_make_readings(base_ts + 86400, 100))
        days = db.get_day_boundaries("UTC")
        assert len(days) == 2
        assert days[0][0] == "2024-01-15"
        assert days[1][0] == "2024-01-16"

    def test_gap_produces_intermediate_days(self, db):
        """Days between first and last reading are enumerated even without data."""
        base_ts = 1705276800  # 2024-01-15 00:00:00 UTC
        db.upsert_readings(_make_readings(base_ts, 10))
        db.upsert_readings(_make_readings(base_ts + 86400 * 3, 10))  # 3 days later
        days = db.get_day_boundaries("UTC")
        # Should enumerate Jan 15, 16, 17, 18
        assert len(days) == 4
        assert [d[0] for d in days] == [
            "2024-01-15", "2024-01-16", "2024-01-17", "2024-01-18"
        ]

    def test_timezone_shifts_day(self, db):
        # 2024-01-15 23:30:00 UTC = 2024-01-16 00:30:00 in Europe/Paris (CET, UTC+1)
        base_ts = 1705361400
        db.upsert_readings(_make_readings(base_ts, 10))

        days_utc = db.get_day_boundaries("UTC")
        days_paris = db.get_day_boundaries("Europe/Paris")

        assert days_utc[0][0] == "2024-01-15"
        assert days_paris[0][0] == "2024-01-16"


class TestGetDailyScores:
    def test_empty(self, db):
        assert db.get_daily_scores() == []

    def test_insert_and_retrieve(self, db):
        db.upsert_daily_score(DailyScoreRecord(date="2024-01-15", strain=5.0))
        scores = db.get_daily_scores()
        assert len(scores) == 1
        assert scores[0].strain == 5.0

    def test_date_filter(self, db):
        db.upsert_daily_score(DailyScoreRecord(date="2024-01-15", strain=5.0))
        db.upsert_daily_score(DailyScoreRecord(date="2024-01-16", strain=8.0))
        db.upsert_daily_score(DailyScoreRecord(date="2024-01-17", strain=3.0))

        result = db.get_daily_scores(start_date="2024-01-16")
        assert len(result) == 2

        result = db.get_daily_scores(start_date="2024-01-16", end_date="2024-01-16")
        assert len(result) == 1
        assert result[0].strain == 8.0

    def test_stress_column(self, db):
        """Verify the new stress column works in upsert."""
        db.upsert_daily_score(DailyScoreRecord(date="2024-01-15", stress=3.5))
        scores = db.get_daily_scores()
        assert scores[0].stress == pytest.approx(3.5)

        # Partial update should preserve stress and add strain
        db.upsert_daily_score(DailyScoreRecord(date="2024-01-15", strain=10.0))
        scores = db.get_daily_scores()
        assert scores[0].stress == pytest.approx(3.5)
        assert scores[0].strain == pytest.approx(10.0)


class TestComputeDailyScoresIntegration:
    """Integration test: insert readings → compute daily scores → verify DB."""

    def test_full_pipeline(self, db):
        from openwhoop.cli import _compute_daily_scores

        base_ts = 1705276800  # 2024-01-15 00:00:00 UTC
        # 1000 readings = enough for stress (needs 120 RR) and strain (needs 600 HR)
        db.upsert_readings(_make_readings(base_ts, 1000))

        days = db.get_day_boundaries("UTC")
        computed = _compute_daily_scores(db, days, resting_hr=60, max_hr=200)
        assert computed == 1

        scores = db.get_daily_scores()
        assert len(scores) == 1
        s = scores[0]
        assert s.date == "2024-01-15"
        assert s.strain is not None
        assert s.hrv is not None
        assert s.rhr is not None
        assert s.spo2 is not None
        assert s.skin_temp is not None
        assert s.stress is not None

    def test_insufficient_data_day(self, db):
        from openwhoop.cli import _compute_daily_scores

        base_ts = 1705276800
        # Only 50 readings: not enough for stress (120 RR) or strain (600 HR)
        db.upsert_readings(_make_readings(base_ts, 50))

        days = db.get_day_boundaries("UTC")
        computed = _compute_daily_scores(db, days, resting_hr=60, max_hr=200)
        assert computed == 1

        scores = db.get_daily_scores()
        s = scores[0]
        assert s.strain is None  # needs 600+
        assert s.stress is None  # needs 120+ RR (50 readings * 2 RR = 100 < 120)
        # SpO2 and skin_temp should still work with 50 readings
        assert s.spo2 is not None
        assert s.skin_temp is not None

    def test_multi_day_pipeline(self, db):
        from openwhoop.cli import _compute_daily_scores

        base_ts = 1705276800  # 2024-01-15 00:00:00 UTC
        # Day 1: 1000 readings
        db.upsert_readings(_make_readings(base_ts, 1000))
        # Day 2: 1000 readings
        db.upsert_readings(_make_readings(base_ts + 86400, 1000))

        days = db.get_day_boundaries("UTC")
        computed = _compute_daily_scores(db, days, resting_hr=60, max_hr=200)
        assert computed == 2

        scores = db.get_daily_scores()
        assert len(scores) == 2
        assert scores[0].date == "2024-01-15"
        assert scores[1].date == "2024-01-16"

    def test_empty_gap_day_skipped(self, db):
        """Days with no readings should not produce a daily score row."""
        from openwhoop.cli import _compute_daily_scores

        base_ts = 1705276800  # 2024-01-15
        db.upsert_readings(_make_readings(base_ts, 100))
        # Skip Jan 16, put readings on Jan 17
        db.upsert_readings(_make_readings(base_ts + 86400 * 2, 100))

        days = db.get_day_boundaries("UTC")
        assert len(days) == 3  # Jan 15, 16, 17 enumerated

        computed = _compute_daily_scores(db, days, resting_hr=60, max_hr=200)
        assert computed == 2  # Jan 16 skipped (no data)

        scores = db.get_daily_scores()
        assert len(scores) == 2
        assert scores[0].date == "2024-01-15"
        assert scores[1].date == "2024-01-17"
