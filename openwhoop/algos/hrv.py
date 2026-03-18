"""HRV analysis — RMSSD, SDNN, frequency domain, normalized score.

Merges whoomp/scripts/hrv.py with openwhoop's rolling-window approach.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import welch
from scipy.integrate import trapezoid


def rmssd(rr_intervals: list[int | float]) -> float:
    """Root Mean Square of Successive Differences (ms)."""
    if len(rr_intervals) < 2:
        return 0.0
    diffs = np.diff(rr_intervals)
    return float(np.sqrt(np.mean(diffs**2)))


def sdnn(rr_intervals: list[int | float]) -> float:
    """Standard Deviation of NN intervals (ms)."""
    if len(rr_intervals) < 2:
        return 0.0
    return float(np.std(rr_intervals, ddof=1))


def normalized_hrv(rr_intervals: list[int | float]) -> float:
    """Normalized HRV score (0-100) using EliteHRV method: ln(RMSSD) / 6.5 * 100."""
    r = rmssd(rr_intervals)
    if r <= 0:
        return 0.0
    return min(100.0, math.log(r) / 6.5 * 100.0)


def frequency_domain(
    rr_intervals: list[int | float], fs: float = 4.0
) -> dict[str, float]:
    """Compute LF, HF power and LF/HF ratio using Welch's method.

    Args:
        rr_intervals: RR intervals in milliseconds.
        fs: Sampling frequency for Welch (Hz).

    Returns:
        Dict with keys: lf, hf, lf_hf_ratio, vlf.
    """
    if len(rr_intervals) < 8:
        return {"lf": 0.0, "hf": 0.0, "lf_hf_ratio": float("nan"), "vlf": 0.0}

    rr_sec = np.array(rr_intervals) / 1000.0
    nperseg = min(len(rr_sec), 256)
    f, pxx = welch(rr_sec, fs=fs, nperseg=nperseg)

    def band_power(low: float, high: float) -> float:
        mask = (f >= low) & (f < high)
        if not mask.any():
            return 0.0
        return float(trapezoid(pxx[mask], f[mask]))

    vlf = band_power(0.003, 0.04)
    lf = band_power(0.04, 0.15)
    hf = band_power(0.15, 0.4)
    ratio = lf / hf if hf > 0 else float("nan")

    return {"lf": lf, "hf": hf, "lf_hf_ratio": ratio, "vlf": vlf}


def rolling_rmssd(
    rr_intervals: list[int | float], window: int = 300
) -> list[float]:
    """Compute rolling RMSSD over a sliding window of RR intervals.

    Args:
        rr_intervals: All RR intervals (ms).
        window: Window size in number of intervals (default 300 ~ 5 min).

    Returns:
        List of RMSSD values, one per window position.
    """
    results = []
    for i in range(len(rr_intervals) - window + 1):
        chunk = rr_intervals[i : i + window]
        results.append(rmssd(chunk))
    return results
