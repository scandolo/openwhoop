"""Sleep cycle construction from activity-classified readings.

Post-processing rules (from openwhoop):
  - Minimum sleep duration: 60 minutes
  - Merge gaps < 20 minutes between sleep periods
  - Absorb short activity periods < 15 minutes within sleep
"""

from __future__ import annotations

from ..models import SleepCycle, HistoryReading
from .activity import classify_activity, ClassifiedReading
from .hrv import rmssd

MIN_SLEEP_DURATION = 60 * 60  # 60 minutes in seconds
MAX_GAP_TO_MERGE = 20 * 60  # 20 minutes in seconds
MAX_ACTIVITY_TO_ABSORB = 15 * 60  # 15 minutes in seconds


def detect_sleep_periods(readings: list[HistoryReading]) -> list[SleepCycle]:
    """Detect sleep periods from classified readings.

    Args:
        readings: Sorted HistoryReading list with sensor data.

    Returns:
        List of SleepCycle objects.
    """
    classified = classify_activity(readings)
    return _build_sleep_cycles(classified)


def _build_sleep_cycles(classified: list[ClassifiedReading]) -> list[SleepCycle]:
    """Build sleep cycles from classified readings with post-processing."""
    # Extract raw sleep periods
    raw_periods: list[SleepCycle] = []
    in_sleep = False
    start_ts = 0

    for cr in classified:
        if cr.activity == "sleep" and not in_sleep:
            in_sleep = True
            start_ts = cr.reading.unix_ts
        elif cr.activity != "sleep" and in_sleep:
            in_sleep = False
            raw_periods.append(SleepCycle(start_ts=start_ts, end_ts=cr.reading.unix_ts))

    # Close final period
    if in_sleep and classified:
        raw_periods.append(SleepCycle(start_ts=start_ts, end_ts=classified[-1].reading.unix_ts))

    # Merge gaps < 20 min
    merged = _merge_gaps(raw_periods, MAX_GAP_TO_MERGE)

    # Filter by minimum duration
    merged = [p for p in merged if p.duration_seconds >= MIN_SLEEP_DURATION]

    return merged


def _merge_gaps(periods: list[SleepCycle], max_gap: int) -> list[SleepCycle]:
    """Merge sleep periods separated by gaps shorter than max_gap."""
    if len(periods) <= 1:
        return periods

    merged = [periods[0]]
    for p in periods[1:]:
        gap = p.start_ts - merged[-1].end_ts
        if gap <= max_gap:
            merged[-1] = SleepCycle(start_ts=merged[-1].start_ts, end_ts=p.end_ts)
        else:
            merged.append(p)

    return merged


def sleep_hr_stats(
    readings: list[HistoryReading], cycle: SleepCycle
) -> dict[str, float | None]:
    """Compute HR stats for a sleep cycle.

    Returns dict with: min_bpm, max_bpm, avg_bpm, avg_hrv.
    """
    cycle_readings = [
        r for r in readings
        if cycle.start_ts <= r.unix_ts <= cycle.end_ts and r.heart_rate > 0
    ]

    if not cycle_readings:
        return {"min_bpm": None, "max_bpm": None, "avg_bpm": None, "avg_hrv": None}

    bpms = [r.heart_rate for r in cycle_readings]

    # Collect RR intervals for HRV
    all_rr: list[int] = []
    for r in cycle_readings:
        all_rr.extend(r.rr_intervals)

    avg_hrv = rmssd(all_rr) if len(all_rr) >= 2 else None

    return {
        "min_bpm": min(bpms),
        "max_bpm": max(bpms),
        "avg_bpm": sum(bpms) / len(bpms),
        "avg_hrv": avg_hrv,
    }


def sleep_score(cycle: SleepCycle, target_hours: float = 8.0) -> float:
    """Simple sleep score: fraction of target duration, 0-100.

    Note: This is the openwhoop formula — intentionally simplistic.
    """
    return min(cycle.duration_hours / target_hours, 1.0) * 100.0
