"""SpO2 estimation via Beer-Lambert ratio-of-ratios method.

Ported from openwhoop Rust implementation.

R = (AC_red / DC_red) / (AC_ir / DC_ir)
SpO2 = 110.0 - 25.0 * R   [clamped 70-100%]

Requires 30+ readings with valid spo2_red and spo2_ir values.
"""

from __future__ import annotations

import numpy as np


def calculate_spo2(
    spo2_red: list[int | float],
    spo2_ir: list[int | float],
    min_readings: int = 30,
) -> float | None:
    """Compute SpO2 from raw red and IR photodiode values.

    Args:
        spo2_red: Raw red LED ADC values.
        spo2_ir: Raw infrared LED ADC values.
        min_readings: Minimum number of valid readings required.

    Returns:
        SpO2 percentage (70-100), or None if insufficient data.
    """
    if len(spo2_red) < min_readings or len(spo2_ir) < min_readings:
        return None

    reds = np.array(spo2_red, dtype=float)
    irs = np.array(spo2_ir, dtype=float)

    # Filter out zero/invalid readings
    valid = (reds > 0) & (irs > 0)
    reds = reds[valid]
    irs = irs[valid]

    if len(reds) < min_readings:
        return None

    ac_red = np.std(reds)
    dc_red = np.mean(reds)
    ac_ir = np.std(irs)
    dc_ir = np.mean(irs)

    if dc_red == 0 or dc_ir == 0 or ac_ir == 0:
        return None

    r = (ac_red / dc_red) / (ac_ir / dc_ir)
    spo2 = 110.0 - 25.0 * r

    return float(max(70.0, min(100.0, spo2)))
