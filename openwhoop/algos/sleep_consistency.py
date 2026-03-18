"""Sleep consistency scoring — CV-based analysis across multiple nights.

From openwhoop:
  CV = std / mean * 100
  Duration score: max(0, 100 - CV_duration)
  Timing score: mean(max(0, 100 - CV) for start, end, midpoint)
  Overall: mean of all 4 scores
"""

from __future__ import annotations

import numpy as np

from ..models import SleepCycle


def _cv(values: list[float]) -> float:
    """Coefficient of variation (%)."""
    if len(values) < 2:
        return 0.0
    mean = np.mean(values)
    if mean == 0:
        return 0.0
    return float(np.std(values, ddof=1) / abs(mean) * 100)


def sleep_consistency_score(cycles: list[SleepCycle]) -> dict[str, float]:
    """Compute sleep consistency from multiple sleep cycles.

    Args:
        cycles: List of SleepCycle objects (ideally 7+ nights).

    Returns:
        Dict with keys: duration_score, timing_score, overall.
    """
    if len(cycles) < 2:
        return {"duration_score": 0.0, "timing_score": 0.0, "overall": 0.0}

    durations = [c.duration_seconds / 3600.0 for c in cycles]  # hours

    # Time-of-day components (seconds since midnight, approximated from unix ts)
    starts = [c.start_ts % 86400 for c in cycles]
    ends = [c.end_ts % 86400 for c in cycles]
    midpoints = [(c.start_ts + c.duration_seconds // 2) % 86400 for c in cycles]

    # Handle wrap-around for overnight sleep (adjust values > 18h to be negative)
    def unwrap_times(times: list[int]) -> list[float]:
        return [float(t - 86400 if t > 64800 else t) for t in times]

    starts_f = unwrap_times(starts)
    ends_f = [float(e) for e in ends]
    midpoints_f = unwrap_times(midpoints)

    duration_score = max(0.0, 100.0 - _cv(durations))

    cv_start = _cv(starts_f)
    cv_end = _cv(ends_f)
    cv_mid = _cv(midpoints_f)
    timing_score = np.mean([
        max(0.0, 100.0 - cv_start),
        max(0.0, 100.0 - cv_end),
        max(0.0, 100.0 - cv_mid),
    ])

    overall = float(np.mean([duration_score, timing_score]))

    return {
        "duration_score": duration_score,
        "timing_score": float(timing_score),
        "overall": overall,
    }
