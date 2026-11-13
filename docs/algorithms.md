# How OpenWhoop scores you

Every score is computed locally from the strap's per-second data. For each
one, this page lists what WHOOP has said publicly, what OpenWhoop does, and how
closely it matches real WHOOP numbers. The fit statistics come from
`npm run calibrate`, run on real WHOOP exports (see [Data](#data) and
[calibration.md](calibration.md)).

These are independent estimates, not WHOOP's proprietary algorithms. WHOOP
publishes inputs, bands and thresholds but no weights. Where this page says
**fitted**, the number was learned from data. **Published** means WHOOP stated
it. **Design** means a judgment call made here.

| Score | Match with WHOOP, on people the model never saw |
|---|---|
| Recovery | 8.1 pts mean error; day-to-day correlation 0.93 within a person |
| Strain (activity) | 1.6 mean error on the 0–21 scale |
| Sleep performance (2025 formula) | 3.9 pts |
| Sleep consistency | 8.0 pts |
| Sleep debt | 15.6 min |
| Sleep need | 5.5 min (fitted on all data, not cross-validated) |

**Second check, on one person's full history:** the maintainer's WHOOP
history, 397 nights, none of them used for fitting.
- Recovery: 8.0 pts mean error, r = 0.88. Average 66 against WHOOP's 67.
- Sleep debt: 7.6 min mean error.
- The strain term of sleep need: within 1.9 min of the component WHOOP
  reports.

Connect the WHOOP integration ([integrations.md](integrations.md)) and
OpenWhoop also learns your **personal** recovery offset from your own paired
nights. That removes most of the remaining recovery error, which is mostly a
constant per-person shift.

---

## Pipeline

```
strap records (1 Hz: HR, RR intervals, gravity vector, raw optical/thermal)
  → per-second series → 30 s epochs (HR, HR instability, movement, rolling RMSSD)
  → sleep detection → sleep staging (HMM) → nightly vitals
  → cycles (sleep onset to next sleep onset)
  → recovery, sleep need/debt/performance, strain, stress, insights
```

Code: `src/algorithms/`. Everything there is pure functions; the server
(`src/server/pipeline.ts`) only feeds data in and stores results.

## Physiological cycle

WHOOP's "day" runs from one sleep onset to the next, and the recovery belongs to
the cycle that starts with that sleep (**published**; the real exports confirm it:
cycle start = sleep onset). OpenWhoop does the same. A cycle's date is the local
date you woke up.

## Sleep

**Detection** (`sleep.ts`, **design**). An epoch is a sleep candidate when, in
a centered 15-minute window:
- at least 70% of epochs are still (movement below an adaptive threshold, 4× the 10th percentile of the day's activity)
- heart rate is below the day's median
- the strap is on the wrist

Runs are merged across wake gaps shorter than 50 minutes, which matches
WHOOP's **published** rule. Sleeps of 60 minutes or more are main sleeps;
shorter ones of 20+ minutes are naps.

**Staging** (**design**). A 4-state hidden Markov model (wake, light, deep,
REM) decoded with Viterbi.
- **Emissions** are Gaussian in night-normalized features: heart rate, ln RMSSD
  and HR instability, plus movement.
  - Deep sleep: low, steady HR and high HRV.
  - REM: higher, irregular HR, lower HRV, no movement.
  - Wake: movement and high HR.
- **Priors** shift deep sleep to the first third of the night and REM to the
  last.
- **Transitions** encode normal architecture: stages are sticky, and wake never
  jumps straight to deep.

WHOOP uses an ML model trained on polysomnography (**published**). Without
labeled data, this is a physiology-based approximation. On simulated nights it
reaches about 90% epoch agreement. That figure is optimistic, because the
simulator shares the model's assumptions. Published wrist-PPG stagers reach
kappa 0.65–0.75 against polysomnography.

**HRV and resting HR** follow the method WHOOP's data-science team described
(**published**):
1. Take RMSSD over overlapping 5-minute windows stepped every 30 s across the
   whole sleep.
2. Drop windows that contain wake.
3. Average the rest, weighting deep sleep ×3 and later in the night more. The
   average is geometric, so one wild window can't dominate.

Resting HR uses the same windows and weights. RR intervals are cleaned first:
a range gate of 300–2000 ms, then a ±20% local-median rule.

**Respiratory rate** comes from respiratory sinus arrhythmia: the dominant
0.1–0.5 Hz peak in the resampled RR series, using the median of 5-minute
non-REM windows. WHOOP says it derives respiratory rate from heart rate the same
way (**published**). The strap's own "resp rate" field turned out to be a
constant ([protocol.md](protocol.md)).

**SpO₂** is not shown on WHOOP 4.0 for now. The raw red and IR channels in the
history records move in lockstep, so the ratio-of-ratios method gives nonsense.
**Skin temperature** is shown only as a deviation from your baseline, and is
labeled experimental: what that raw field actually measures is disputed
upstream.

## Sleep need, debt, performance, consistency

**Need** (structure **published**; WHOOP's per-night breakdown matches it
exactly):

```
need = baseline + 0.946·debt + 3.44·(e^(0.159·strain) − 1) − 0.84·naps
```

- `strain` is the previous cycle's day strain.
- The strain curve is **fitted** on WHOOP's own "need from strain" component.
  The WHOOP web app reports it per night; across one member's 311 nights the
  curve is within 1.9 min. It adds about 5 min after a strain-6 day, 24 min
  after strain 13 and 48 min after strain 17.
- Debt and nap coefficients are **fitted** on the public exports, given that
  curve. Exports only contain the total need, so they can't separate the
  baseline from the strain term on their own.
- The baseline defaults to 7 h 51 m. Connect the WHOOP integration to adopt
  yours, or set it in Settings.

**Debt** (**fitted**). The unmet need of the last 5 nights, decayed:

```
debt = max(0, 0.296 × Σ 0.375^(k−1) × (need_k − asleep_k − naps_k))
```

WHOOP describes it as carrying over unmet need "with a small decay factor"
(**published**).

**Performance.** Until May 2025, WHOOP's sleep performance was exactly
`min(100, asleep / need)`: zero error on 3,031 nights. In 2025 WHOOP added
efficiency, consistency and sleep stress (**published**). The fitted
replacement is:

```
performance = 100 − 0.456·(100 − sufficiency)
                  − 0.584·(100 − efficiency)
                  − 0.271·(100 − consistency)
```

It falls back to the classic formula until 4 nights of history exist.

**Consistency** uses WHOOP's own definition (**published**): how likely your
sleep/wake state is the same at a given clock time across four consecutive
days. It is computed on 5-minute slots of the local 24-hour clock, then mapped
onto WHOOP's scale as `6.3 + 0.81 × agreement` (**fitted**).

## Strain

- **Zones** (**published**): % of heart-rate reserve, `(HR − RHR) / (maxHR − RHR)`.
  Zone *k* starts at (40 + 10k)%, so zone 1 begins at 50% and zone 5 at 90%.
- **Max HR** (**published**): Gellish, `192 − 0.007·age²`. It is raised when you
  record a higher heart rate, or replaced by WHOOP's measured value when the
  integration is connected.
- **Resting HR**: the median of the last 14 nights.
- **Load** (**fitted**): minutes in each zone × weight.

  | Zone | 0 | 1 | 2 | 3 | 4 | 5 |
  |---|---|---|---|---|---|---|
  | Weight | 0.32 | 1 | 1 | 1.69 | 4.92 | 10.83 |

  Below 50% HRR the weight ramps from 0 at 20% HRR up to 0.32 at 40%, so
  walking counts and sitting doesn't (**design**).

- **Strain** (**fitted**): `4.279 · ln(1 + load / 6.959)`, with a soft cap that
  compresses everything above 17 toward 21. It matches WHOOP's published
  anchors:
  - 1 h of running ≈ 12 (OpenWhoop 11.8)
  - one marathon 20.4, two marathons 20.6 (OpenWhoop: two marathons 20.8)

  Day strain is the same function applied to the whole cycle's load, so
  workouts combine on the load scale, never by adding strain numbers. That is
  WHOOP's documented behavior.

- **Calories**: BMR from Mifflin–St Jeor at rest; above 30% HRR, the larger of
  BMR and the Keytel (2005) heart-rate equation. Like WHOOP, the thermic effect
  of food is not counted.
- **Strain target** (**design**): the range centers on `6.5 + 0.11 × recovery`,
  ±1.5. That gives light days in the red and high days in the green, in line
  with WHOOP's Strain Coach guidance.

Auto-detected workouts: at least 12 minutes of sustained HR at 45% HRR or more
(WHOOP drops activities shorter than 12 minutes, **published**).

## Recovery

```
recovery = 100 · σ(−1.5 + 3.19·Δln HRV − 0.031·ΔRHR − 0.077·Δresp
                   + 2.49·sleep performance + personal offset)
```

The Δ terms are differences from a personal baseline: an exponentially
weighted average with a 7-night half-life (**fitted**). Leave-one-person-out
comparison chose it over 14/30/45/60-day windows, z-scores and raw values.
WHOOP says HRV and RHR are the two biggest contributors and respiratory rate
matters when it's elevated (**published**). Scores appear after 3 nights;
WHOOP's calibration is also 3 recoveries (**published**).

Without the WHOOP integration the personal offset is 0. With it, after 14
nights scored by both, the offset is the median logit difference between
WHOOP's score and OpenWhoop's raw score, over the last 90 paired nights.

**Health flags** (**design**) appear when several vitals are off baseline
together:
- RHR ≥ +5 bpm
- HRV ≤ −25%
- respiratory rate ≥ +1 rpm
- skin temperature ±0.6 °C

## Stress monitor

WHOOP: heart rate and HRV against a 14-day personal baseline, with motion taken
into account, on a 0–3 scale (**published**). OpenWhoop:
- The baseline is the median and IQR of HR and ln RMSSD over the last 14 days
  of still, awake, non-workout minutes.
- Per minute, `stress = clamp(1 + 0.8·(0.55·z_HR + 0.45·z_−HRV), 0, 3)`, then a
  5-minute smoothing. Your typical calm reads 1.0 (**design**).
- Sleep minutes use a 0.4 base.
- Moving and workout minutes are not scored.
- High-stress episodes: ≥ 2.0 for at least 10 minutes. These trigger the
  optional stress nudge.

## Journal insights

**Published:** an insight unlocks at 5 "yes" and 5 "no" answers, like WHOOP's
Monthly Performance Assessment.

**Design:** the effect is the difference in next-morning recovery from least
squares, adjusted for the previous day's strain. It's shown with a 95% interval,
and the UI grays out effects whose interval crosses zero.

## Smart alarm

WHOOP has three modes: exact time, sleep goal (100/85/70% of need) and in the
green. Smart modes wake you inside a window that ends at the latest wake time,
and the alarm falls back to that time (**published**).

OpenWhoop:
- Programs the strap's own alarm for the latest wake time, so it fires even if
  nothing is connected.
- In Night mode, the browser syncs every 3 minutes inside the window and asks
  `/api/alarm/decision`.
- It wakes you only in light sleep, REM or wake, never in deep sleep, once the
  mode's condition is met.

---

## Data

Calibration used real WHOOP app exports from 7 people:
- [tanarchytan/whoop-dataset](https://github.com/tanarchytan/whoop-dataset) (CC BY 4.0)
- [Personal WHOOP Health Data](https://www.kaggle.com/datasets/surajkumarnanda/personal-whoop-health-data) by Suraj Kumar Nanda (CC BY 4.0)
- four personal exports published on GitHub without a license

Those last four were used only to fit aggregate constants. They are not
redistributed. Datasets self-described as synthetic were excluded. No raw data
is committed to this repository. Re-run with your own export:

```bash
npm run calibrate -- path/to/folder-with-exports --write
```

## Sources

- WHOOP Recovery, Sleep and Strain help articles: support.whoop.com (WHOOP-Recovery, WHOOP-Sleep, WHOOP-Strain, Calibration-Timeline, The-Haptic-Alarm-Dashboard, Get-to-Know-the-Stress-Monitor)
- WHOOP developer API: https://developer.whoop.com/api
- HRV method: WHOOP data-science post, https://www.community.whoop.com/t/hrv-extreme-spikes/6472/31
- Strain anchors: https://www.whoop.com/us/en/thelocker/strain-coach/ and https://www.whoop.com/us/en/thelocker/how-does-whoop-strain-work-101/
- Heart-rate reserve zones: https://www.whoop.com/us/en/thelocker/why-whoop-uses-heart-rate-reserve-not-max-heart-rate/
- Sleep consistency: https://www.whoop.com/us/en/thelocker/sleep-consistency-more-to-sleep-than-sleep-need/
- Respiratory rate: https://www.whoop.com/us/en/thelocker/what-is-respiratory-rate-normal/
- Validation of WHOOP 4.0 HRV/RHR: https://bpspubs.onlinelibrary.wiley.com/doi/10.14814/phy2.70527
- Gellish et al. 2007, max heart rate; Keytel et al. 2005, heart-rate energy expenditure; Mifflin–St Jeor 1990, BMR
