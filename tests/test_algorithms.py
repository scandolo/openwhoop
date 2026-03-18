"""Tests for health algorithms: HRV, stress, strain, SpO2, temperature, sleep."""

import math

import pytest

from openwhoop.algos.hrv import rmssd, sdnn, normalized_hrv, frequency_domain, rolling_rmssd
from openwhoop.algos.stress import baevsky_stress_index
from openwhoop.algos.strain import edwards_trimp, strain_score, _zone_weight
from openwhoop.algos.spo2 import calculate_spo2
from openwhoop.algos.temperature import skin_temp_celsius, avg_skin_temp
from openwhoop.algos.activity import gravity_delta, classify_stillness, classify_activity
from openwhoop.algos.sleep import detect_sleep_periods, sleep_score
from openwhoop.algos.sleep_consistency import sleep_consistency_score
from openwhoop.models import HistoryReading, SensorData, SleepCycle


class TestHRV:
    def test_rmssd_basic(self):
        rr = [800, 810, 790, 815, 805]
        result = rmssd(rr)
        assert result > 0
        # Manual: diffs = [10, -20, 25, -10], sq = [100, 400, 625, 100], mean=306.25, sqrt≈17.5
        assert abs(result - 17.5) < 1.0

    def test_rmssd_constant(self):
        rr = [800] * 10
        assert rmssd(rr) == 0.0

    def test_rmssd_insufficient(self):
        assert rmssd([800]) == 0.0
        assert rmssd([]) == 0.0

    def test_sdnn_basic(self):
        rr = [800, 810, 790, 815, 805]
        result = sdnn(rr)
        assert result > 0

    def test_normalized_hrv(self):
        rr = [800, 810, 790, 815, 805] * 20
        score = normalized_hrv(rr)
        assert 0 <= score <= 100

    def test_frequency_domain(self):
        rr = [800 + (i % 50) for i in range(100)]
        result = frequency_domain(rr)
        assert "lf" in result
        assert "hf" in result
        assert "lf_hf_ratio" in result

    def test_rolling_rmssd(self):
        rr = [800 + (i % 30) for i in range(400)]
        results = rolling_rmssd(rr, window=300)
        assert len(results) == 101
        assert all(r >= 0 for r in results)


class TestStress:
    def test_insufficient_data(self):
        assert baevsky_stress_index([800] * 50) is None

    def test_basic_stress(self):
        # Simulate moderate variability
        rr = [800 + (i % 100) for i in range(200)]
        si = baevsky_stress_index(rr)
        assert si is not None
        assert 0 < si <= 10.0

    def test_low_variability_high_stress(self):
        # Very consistent RR → high AMo/low VR → high stress
        rr = [800, 800, 800, 801, 800, 799, 800] * 30
        si = baevsky_stress_index(rr)
        assert si is not None
        # Should be capped at 10
        assert si == 10.0


class TestStrain:
    def test_zone_weights(self):
        assert _zone_weight(45) == 0   # Below zone 1
        assert _zone_weight(55) == 1   # Zone 1
        assert _zone_weight(65) == 2   # Zone 2
        assert _zone_weight(75) == 3   # Zone 3
        assert _zone_weight(85) == 4   # Zone 4
        assert _zone_weight(95) == 5   # Zone 5

    def test_edwards_trimp(self):
        # All samples at 75% HRR (zone 3, weight 3)
        # 100 samples at 1sec = 100/60 min * 3 = 5.0
        hr = [int(60 + 0.75 * (200 - 60))] * 100
        trimp = edwards_trimp(hr, resting_hr=60, max_hr=200)
        assert abs(trimp - 5.0) < 0.1

    def test_strain_score_insufficient(self):
        assert strain_score([80] * 100) is None

    def test_strain_score_basic(self):
        hr = [150] * 1000  # moderate effort
        score = strain_score(hr, resting_hr=60, max_hr=200)
        assert score is not None
        assert 0 < score <= 21.0

    def test_strain_capped(self):
        hr = [200] * 86400  # max HR for 24 hours
        score = strain_score(hr, resting_hr=60, max_hr=200)
        assert abs(score - 21.0) < 0.001


class TestSpO2:
    def test_insufficient_data(self):
        assert calculate_spo2([100] * 10, [100] * 10) is None

    def test_basic_spo2(self):
        # R ≈ 1.0 → SpO2 ≈ 85%
        reds = [1000 + i for i in range(50)]
        irs = [1000 + i for i in range(50)]
        spo2 = calculate_spo2(reds, irs)
        assert spo2 is not None
        assert 70 <= spo2 <= 100

    def test_clamped(self):
        # Constant values have 0 AC (std=0), so we need some variation
        reds = [100 + i for i in range(50)]    # small variation, small DC
        irs = [10000 + i * 10 for i in range(50)]  # small variation, large DC
        spo2 = calculate_spo2(reds, irs)
        assert spo2 is not None
        assert 70 <= spo2 <= 100


class TestTemperature:
    def test_basic_conversion(self):
        assert abs(skin_temp_celsius(850) - 34.0) < 0.01

    def test_off_wrist(self):
        assert skin_temp_celsius(50) is None

    def test_avg(self):
        result = avg_skin_temp([850, 900, 50, 800])
        assert result is not None
        assert 30 < result < 40


class TestActivity:
    def test_gravity_delta_still(self):
        r1 = HistoryReading(0, 0, 60, sensor=SensorData(gravity_x=0.01, gravity_y=0.02, gravity_z=0.98))
        r2 = HistoryReading(1, 0, 60, sensor=SensorData(gravity_x=0.01, gravity_y=0.02, gravity_z=0.98))
        delta = gravity_delta(r1, r2)
        assert delta is not None
        assert delta < 0.01

    def test_gravity_delta_moving(self):
        r1 = HistoryReading(0, 0, 60, sensor=SensorData(gravity_x=0.0, gravity_y=0.0, gravity_z=1.0))
        r2 = HistoryReading(1, 0, 60, sensor=SensorData(gravity_x=0.5, gravity_y=0.3, gravity_z=0.8))
        delta = gravity_delta(r1, r2)
        assert delta is not None
        assert delta > 0.01

    def test_classify_stillness(self):
        readings = []
        for i in range(10):
            readings.append(HistoryReading(
                i, 0, 60,
                sensor=SensorData(gravity_x=0.01, gravity_y=0.02, gravity_z=0.98),
            ))
        flags = classify_stillness(readings)
        assert all(flags)


class TestSleep:
    def test_sleep_score(self):
        cycle = SleepCycle(start_ts=0, end_ts=8 * 3600)
        assert sleep_score(cycle) == 100.0

    def test_sleep_score_short(self):
        cycle = SleepCycle(start_ts=0, end_ts=4 * 3600)
        assert abs(sleep_score(cycle) - 50.0) < 0.1

    def test_detect_sleep_returns_list(self, sample_readings):
        cycles = detect_sleep_periods(sample_readings)
        assert isinstance(cycles, list)


class TestSleepConsistency:
    def test_consistent_sleep(self):
        # Same time every night
        cycles = [
            SleepCycle(start_ts=i * 86400 + 82800, end_ts=i * 86400 + 82800 + 28800)
            for i in range(7)
        ]
        score = sleep_consistency_score(cycles)
        assert score["overall"] > 80

    def test_insufficient_data(self):
        score = sleep_consistency_score([SleepCycle(start_ts=0, end_ts=28800)])
        assert score["overall"] == 0.0
