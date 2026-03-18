"""Edwards TRIMP → Whoop-style 0-21 strain scale.

Ported from openwhoop Rust implementation.

%HRR = (bpm - resting) / (max - resting) * 100
Zones: 50-60%→w1, 60-70%→w2, 70-80%→w3, 80-90%→w4, 90%+→w5
TRIMP = sum(duration_min * zone_weight)
Strain = 21 * ln(TRIMP + 1) / ln(7201)   [capped 21.0]

Minimum: 600 readings (10 min at 1Hz).
Calibration: 24h at max HR → TRIMP 7200 → strain 21.0.
"""

from __future__ import annotations

import math

# Zone boundaries (% HRR) and weights
ZONES = [
    (50, 60, 1),
    (60, 70, 2),
    (70, 80, 3),
    (80, 90, 4),
    (90, float("inf"), 5),
]


def _zone_weight(pct_hrr: float) -> int:
    """Get the TRIMP zone weight for a given %HRR."""
    for low, high, weight in ZONES:
        if low <= pct_hrr < high:
            return weight
    return 0  # Below 50% HRR — no contribution


def edwards_trimp(
    hr_samples: list[int | float],
    resting_hr: int = 60,
    max_hr: int = 200,
    sample_interval_sec: float = 1.0,
) -> float:
    """Compute Edwards TRIMP from heart rate samples.

    Args:
        hr_samples: Heart rate values (BPM), one per sample interval.
        resting_hr: Resting heart rate.
        max_hr: Maximum heart rate.
        sample_interval_sec: Time between samples in seconds.

    Returns:
        Raw TRIMP value.
    """
    if max_hr <= resting_hr:
        return 0.0

    sample_min = sample_interval_sec / 60.0
    trimp = 0.0
    for bpm in hr_samples:
        pct_hrr = (bpm - resting_hr) / (max_hr - resting_hr) * 100
        w = _zone_weight(pct_hrr)
        trimp += sample_min * w

    return trimp


def strain_score(
    hr_samples: list[int | float],
    resting_hr: int = 60,
    max_hr: int = 200,
    sample_interval_sec: float = 1.0,
) -> float | None:
    """Compute Whoop-style strain (0-21) from heart rate samples.

    Returns None if fewer than 600 samples (~10 min).
    """
    if len(hr_samples) < 600:
        return None

    trimp = edwards_trimp(hr_samples, resting_hr, max_hr, sample_interval_sec)
    if trimp <= 0:
        return 0.0

    strain = 21.0 * math.log(trimp + 1) / math.log(7201)
    return min(strain, 21.0)
