"""Skin temperature conversion from raw ADC values.

Ported from openwhoop: temp_celsius = raw * 0.04
Min raw: 100 (below = off-wrist / invalid)
Physiological range: raw 582-1125 → 23-45 C
"""

from __future__ import annotations

MIN_RAW = 100  # Below this = off-wrist


def skin_temp_celsius(raw: int) -> float | None:
    """Convert raw thermistor ADC to Celsius.

    Returns None if the raw value indicates off-wrist.
    """
    if raw < MIN_RAW:
        return None
    return raw * 0.04


def avg_skin_temp(raw_values: list[int]) -> float | None:
    """Average skin temperature from a list of raw readings, filtering invalid ones."""
    valid = [skin_temp_celsius(r) for r in raw_values if r >= MIN_RAW]
    valid = [t for t in valid if t is not None]
    if not valid:
        return None
    return sum(valid) / len(valid)
