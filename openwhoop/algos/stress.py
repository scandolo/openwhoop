"""Baevsky Stress Index (SI) — histogram-based autonomic stress measure.

Ported from openwhoop Rust implementation.

SI = AMo / (2 × VR × Mo)
  AMo = mode_freq / total_count × 100
  VR  = (max_RR - min_RR) / 1000
  Mo  = mode / 1000

50ms histogram bins. Minimum 120 readings. Score capped at 10.0.
"""

from __future__ import annotations

from collections import Counter


def baevsky_stress_index(rr_intervals: list[int | float], bin_width: int = 50) -> float | None:
    """Compute the Baevsky Stress Index from RR intervals (ms).

    Args:
        rr_intervals: RR intervals in milliseconds.
        bin_width: Histogram bin width in ms (default 50).

    Returns:
        Stress index (0-10 scale), or None if insufficient data.
    """
    if len(rr_intervals) < 120:
        return None

    count = len(rr_intervals)
    min_rr = min(rr_intervals)
    max_rr = max(rr_intervals)

    if max_rr == min_rr:
        return None

    # Build histogram with bin_width bins
    bins: Counter[int] = Counter()
    for rr in rr_intervals:
        bin_center = round(rr / bin_width) * bin_width
        bins[bin_center] += 1

    # Mode = most frequent bin center
    mode, mode_freq = bins.most_common(1)[0]

    # Baevsky formula
    vr = (max_rr - min_rr) / 1000.0  # variation range in seconds
    a_mode = mode_freq / count * 100.0  # amplitude of mode (%)
    mo = mode / 1000.0  # mode in seconds

    if vr == 0 or mo == 0:
        return None

    si = a_mode / (2.0 * vr * mo)

    return min(si, 10.0)
