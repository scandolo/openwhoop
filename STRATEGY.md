# OpenWhoop Strategy: Companion Mode & Algorithm Reverse Engineering

*April 2026*

---

## Core Philosophy

**OpenWhoop is not a Whoop Cloud replacement — it is a companion.**

The goal is to run OpenWhoop alongside the official Whoop app, collecting the same raw sensor data locally while letting Whoop Cloud continue to process it with their proprietary ML pipeline. By pairing our raw 1Hz sensor data with Whoop's processed daily scores, we can build a labeled training dataset to reverse-engineer Whoop's algorithms over time.

This is a data-collection-first, algorithm-second approach. We don't need to match Whoop's scoring accuracy today. We need to accumulate enough paired data (raw inputs + Whoop's outputs) to eventually train our own models that approximate or improve on their results.

---

## The Paired Data Strategy

### What We Collect Locally (OpenWhoop)

Every 1-second sensor reading from the strap:
- Heart rate (BPM)
- RR intervals (up to 4 per second, milliseconds)
- PPG green / red+IR photodiode values
- 3-axis gravity vector (accelerometer)
- SpO2 red / infrared raw ADC
- Skin temperature raw ADC
- Ambient light
- Respiratory rate (raw)
- Signal quality index
- Skin contact (on/off wrist)

This is the **feature set** — the inputs to any model we'd want to train.

### What Whoop Cloud Provides (via Developer API)

Per-day and per-cycle processed scores:
- Recovery score (0-100%)
- HRV (RMSSD, milliseconds)
- Resting heart rate (BPM)
- SpO2 percentage
- Skin temperature (Celsius, calibrated)
- Sleep stage durations (REM, deep, light, wake — in seconds)
- Sleep efficiency percentage
- Strain score (0-21)
- HR zone time-in-zone per workout (6 zones, seconds each)
- Workout avg/max HR

This is the **label set** — the ground truth outputs we want our models to learn.

### What We Can Reverse-Engineer

| Target | Feasibility | Why |
|--------|------------|-----|
| Recovery score | High | We have all the input features (HRV, RHR, sleep, SpO2, temp) + Whoop's score as label |
| Sleep staging | High | We have 1Hz HR + gravity + RR; Whoop gives us stage durations to validate against |
| Strain scoring | High | We have 1Hz HR; Whoop gives us the strain number |
| HR cleanup (motion artifact removal) | Medium | We have raw PPG + accelerometer; Whoop's API doesn't expose cleaned HR, but we can compare our raw HR against their workout avg/max |
| SpO2 calibration | Medium | We have raw red/IR; Whoop gives us the calibrated SpO2 % |
| Skin temp calibration | Medium | We have raw ADC; Whoop gives us calibrated Celsius |

---

## Companion Mode: Non-Destructive Download (Default)

### The Problem

The Whoop strap's BLE history protocol uses a **trim pointer acknowledgment** to manage its 3-day rolling buffer:

1. Strap sends a batch of historical data
2. Strap sends `HISTORY_END` with a trim pointer value
3. Client sends `history_ack(trim)` back to the strap
4. Strap marks that data as deletable, freeing buffer space

If OpenWhoop ACKs the trim pointer, the data is gone from the strap. When the official Whoop app connects next, that data won't be there — Whoop Cloud never receives it, and we lose the label data.

### Why We Skip the ACK (The Core Design Decision)

The entire companion mode strategy depends on **not sending the trim pointer acknowledgment**. This is the single most important design decision in the codebase. By skipping the ACK:

1. **The strap keeps its data** — it doesn't know we downloaded anything
2. **The official Whoop app can sync the same data to the cloud** — producing Whoop's ML-processed scores (recovery, sleep stages, strain)
3. **We get paired datasets** — raw 1Hz sensor data locally + Whoop's processed outputs via their Developer API
4. **We can train our own models** — using Whoop's scores as ground-truth labels against our raw sensor features

Without this, we'd have to choose: raw data (OpenWhoop) OR processed scores (Whoop Cloud). With it, we get both for the same time window.

This is the default behavior. The `--destructive` CLI flag opts into the old behavior (ACK the trim pointer, delete data from strap) for cases where you don't need the cloud data.

### The Solution

**Companion mode** (default): download and save all historical data locally, but **skip the trim pointer ACK**. The strap retains the data, and the official Whoop app can sync the same data to the cloud on its next connection.

```
Daily workflow:
  1. openwhoop download -d "WHOOP XXX"           # save raw data locally, don't ACK
  2. Open Whoop app on phone                     # syncs same data to cloud, ACKs trim
  3. openwhoop pull-cloud                        # pull Whoop's processed scores via API
  4. Both datasets now paired in local SQLite
```

### Buffer Management

The strap has a **3-day rolling buffer**. In peek mode, since we never ACK, the buffer isn't freed by us. The official Whoop app's ACK is what ultimately frees it. The constraint:

- **Must let the Whoop app sync within 3 days** of OpenWhoop's peek download
- If neither app ACKs for 3 days, oldest data gets overwritten
- In practice: peek daily, let Whoop app sync daily → no data loss on either side

### BLE Transfer Efficiency in Peek Mode

Since peek mode doesn't ACK, the strap will re-send previously downloaded data on the next peek session. The existing DB-level deduplication (unique constraint on `timestamp + subseconds`) ensures we don't store duplicates, but we still waste BLE transfer time re-receiving old packets.

Potential optimization (future): track the latest timestamp in the database and skip/discard packets with timestamps we already have during the BLE download phase. This doesn't reduce what the strap sends (we can't tell it "start from timestamp X"), but it reduces decode + DB overhead.

For now, the DB deduplication is sufficient:
- `upsert_readings()` loads existing `(timestamp, subseconds)` pairs for the incoming batch
- Skips any readings that already exist
- Only inserts genuinely new rows
- Reports: "X readings downloaded, Y new rows inserted" — the delta tells you how much was net-new

---

## Deduplication: Ensuring Net-New Data Only

### Current Implementation (DB Level)

The `heart_rate` table has a unique constraint on `(timestamp, subseconds)`:

```sql
UNIQUE (timestamp, subseconds)  -- uq_hr_timestamp
```

The `upsert_readings()` method in `database.py`:
1. Queries all existing `(timestamp, subseconds)` pairs that overlap with the incoming batch
2. Builds a set of already-stored keys
3. Skips any incoming reading whose key already exists
4. Only inserts readings with new timestamps

This means **re-downloading the same data is safe** — it won't create duplicates or overwrite existing rows. The only cost is BLE transfer time.

### What's NOT Handled Yet

1. **Partial overwrites**: if a reading was previously stored from a generic packet (NULL sensor columns) and is later re-downloaded as a V12/V24 packet (full sensor data), the current logic **skips it** because the timestamp already exists. The richer data is lost. A true upsert (UPDATE on conflict) would be better here.

2. **Computed column preservation**: if algorithms have already filled `activity`, `stress`, `spo2`, or `skin_temp` columns for a row, re-importing should not clear those computed values. The current skip-if-exists behavior accidentally protects this, but an UPDATE-on-conflict approach would need to be careful to preserve computed columns.

3. **Download progress tracking**: there's no persistent record of "last successful sync timestamp" to optimize future downloads. Adding a metadata table or config value for this would let us log and report efficiency.

---

## Whoop Cloud API Integration (Planned)

### OAuth 2.0 Flow

The Whoop Developer API uses OAuth 2.0 authorization code flow:
1. Register an app at developer.whoop.com → get `client_id` + `client_secret`
2. User authorizes via browser redirect
3. Exchange auth code for access token at `api.prod.whoop.com/oauth/oauth2/token`
4. Use bearer token for API requests
5. Refresh token when expired

### Endpoints to Pull

| Endpoint | Data | Storage Target |
|----------|------|---------------|
| Cycles (v2) | Recovery score, HRV, RHR, SpO2, skin temp | `daily_scores` table |
| Sleep | Stage durations, efficiency, respiratory rate | `sleep_cycles` table (extend schema) |
| Workouts | Strain, HR zones, avg/max HR, duration | `activities` table (extend schema) |

### New CLI Command: `pull-cloud`

```
openwhoop pull-cloud [--days 7] [--db URL]
```

- Authenticates via saved OAuth token (or runs auth flow on first use)
- Pulls last N days of recovery, sleep, and workout data
- Upserts into `daily_scores` and enriches `sleep_cycles` / `activities`
- Reports what was new vs already stored

---

## Implementation Roadmap

### Phase 1: Peek Mode + Deduplication (Now)

- [ ] Add `--peek` flag to `download` command (skip trim pointer ACK)
- [ ] Log download stats: total received, net-new inserted, duplicates skipped
- [ ] Add `latest_timestamp` query helper for reporting

### Phase 2: Cloud API Integration

- [ ] Register Whoop developer app, implement OAuth 2.0 flow
- [ ] Build `pull-cloud` CLI command
- [ ] Extend `daily_scores` table population from cloud data
- [ ] Extend `sleep_cycles` with Whoop's sleep stage durations
- [ ] Store cloud-sourced vs locally-computed scores side by side

### Phase 3: Paired Dataset Analysis

- [ ] Build export command: paired CSV/parquet of raw features + cloud labels
- [ ] Per-day alignment: match local 1Hz data windows to cloud daily scores
- [ ] Per-sleep alignment: match local sleep periods to cloud sleep cycles
- [ ] Visualization: plot local metrics vs cloud scores for correlation analysis

### Phase 4: Model Training

- [ ] Recovery score regression (features: HRV, RHR, sleep duration, SpO2, temp)
- [ ] Sleep stage classification (features: HR, RR intervals, gravity vector)
- [ ] Strain calibration (features: 1Hz HR, compare against Whoop's 0-21 score)
- [ ] Personalized baseline calculation (rolling 60-day windows)

---

## Data Volume Estimates

At 1Hz sampling, 24 hours = 86,400 readings/day.

| Duration | Readings | SQLite Size (est.) |
|----------|----------|--------------------|
| 1 day | 86,400 | ~15 MB |
| 1 week | 604,800 | ~100 MB |
| 1 month | 2,592,000 | ~430 MB |
| 6 months | 15,552,000 | ~2.5 GB |
| 1 year | 31,536,000 | ~5 GB |

SQLite handles this fine. At 6+ months, consider adding time-range indexes and/or partitioning into monthly databases if query performance degrades.

---

## Key Constraints

1. **One BLE connection at a time**: OpenWhoop and the Whoop app cannot connect simultaneously. Peek first, then let the app sync.
2. **3-day buffer limit**: the strap overwrites old data after 3 days. Must sync both OpenWhoop and Whoop app within this window.
3. **Whoop API rate limits**: the developer API has rate limiting and pagination. Daily pulls of the last few days should be well within limits.
4. **No raw HR from Whoop API**: the cloud API only exposes summaries, not the cleaned 1Hz HR time-series. We can't directly compare our raw HR to their cleaned HR — only to their aggregate metrics (avg HR, max HR, zone durations).
5. **Whoop ToS**: reverse engineering may conflict with Whoop's Terms of Service. This project is for personal research and interoperability purposes.

---

*This strategy will evolve as we collect data and understand the correlation between our raw sensor readings and Whoop's processed scores.*
