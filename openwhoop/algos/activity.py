"""Gravity-based sleep/activity detection.

Ported from openwhoop Rust implementation.

For each consecutive pair of gravity readings:
  delta = sqrt(dx^2 + dy^2 + dz^2)
  if delta < 0.01g → "still"

Rolling 15-minute window: if >= 70% still → "sleep"
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..models import HistoryReading

GRAVITY_THRESHOLD = 0.01  # g — movement below this = "still"
SLEEP_WINDOW_SECONDS = 15 * 60  # 15 minutes
SLEEP_STILL_RATIO = 0.70  # 70% still within window → sleep


@dataclass
class ClassifiedReading:
    """A reading with its activity classification."""

    reading: HistoryReading
    is_still: bool
    activity: str  # "sleep", "active", "rest"


def gravity_delta(r1: HistoryReading, r2: HistoryReading) -> float | None:
    """Compute gravity vector delta between two readings.

    Returns None if either reading lacks sensor data.
    """
    if not r1.sensor or not r2.sensor:
        return None

    dx = r2.sensor.gravity_x - r1.sensor.gravity_x
    dy = r2.sensor.gravity_y - r1.sensor.gravity_y
    dz = r2.sensor.gravity_z - r1.sensor.gravity_z
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def classify_stillness(readings: list[HistoryReading]) -> list[bool]:
    """Classify each reading as still (True) or moving (False).

    The first reading is classified same as the second.
    """
    if len(readings) < 2:
        return [True] * len(readings)

    still = []
    for i in range(1, len(readings)):
        delta = gravity_delta(readings[i - 1], readings[i])
        if delta is None:
            still.append(True)  # Default to still if no sensor data
        else:
            still.append(delta < GRAVITY_THRESHOLD)

    # First reading matches second
    still.insert(0, still[0] if still else True)
    return still


def classify_activity(
    readings: list[HistoryReading],
    window_seconds: int = SLEEP_WINDOW_SECONDS,
    still_ratio: float = SLEEP_STILL_RATIO,
) -> list[ClassifiedReading]:
    """Classify readings into sleep/active/rest using rolling window.

    Args:
        readings: Sorted HistoryReading list (by timestamp).
        window_seconds: Rolling window size in seconds.
        still_ratio: Fraction of "still" readings needed to classify as sleep.

    Returns:
        List of ClassifiedReading with activity labels.
    """
    if not readings:
        return []

    still_flags = classify_stillness(readings)
    results: list[ClassifiedReading] = []

    for i, reading in enumerate(readings):
        # Find window boundaries
        window_start_ts = reading.unix_ts - window_seconds
        window_stills = []
        for j in range(max(0, i - window_seconds), min(len(readings), i + 1)):
            if readings[j].unix_ts >= window_start_ts:
                window_stills.append(still_flags[j])

        if not window_stills:
            activity = "rest"
        else:
            ratio = sum(window_stills) / len(window_stills)
            if ratio >= still_ratio:
                activity = "sleep"
            elif still_flags[i]:
                activity = "rest"
            else:
                activity = "active"

        results.append(ClassifiedReading(
            reading=reading,
            is_still=still_flags[i],
            activity=activity,
        ))

    return results
