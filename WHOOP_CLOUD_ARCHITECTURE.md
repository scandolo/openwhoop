# Whoop Cloud Architecture: End-to-End Deep Dive

*Research compiled April 2026 from public sources: Whoop engineering blog, job listings, developer API docs, support articles, CTO interviews, and reverse engineering findings.*

---

## Table of Contents

1. [Stage 1: On-Strap (Sensor Layer)](#stage-1-on-strap-sensor-layer)
2. [Stage 2: Strap to Phone (BLE Transfer)](#stage-2-strap-to-phone-ble-transfer)
3. [Stage 3: Phone to Cloud (Upload)](#stage-3-phone-to-cloud-upload)
4. [Stage 4: Cloud Processing](#stage-4-cloud-processing)
5. [Stage 5: Cloud Storage](#stage-5-cloud-storage)
6. [Stage 6: Cloud to App (Display)](#stage-6-cloud-to-app-display)
7. [Stage-by-Stage Comparison: Whoop Cloud vs OpenWhoop](#stage-by-stage-comparison-whoop-cloud-vs-openwhoop)
8. [Storage Deep Dive: Raw vs Processed Data](#storage-deep-dive-raw-vs-processed-data)
9. [Sources](#sources)

---

## Stage 1: On-Strap (Sensor Layer)

The Whoop 4.0 runs firmware on two chips:

| Component | Chip | Role |
|-----------|------|------|
| BLE SoC | Nordic nRF52840 | BLE 5.0 radio, ARM Cortex-M4 @ 64MHz, 1MB Flash, 256KB RAM |
| App Processor | Maxim MAX32652 | Main processing, ARM Cortex-M4 @ 120MHz, 3MB Flash, 1MB SRAM |
| Optical AFE | Maxim MAX86171 | PPG front-end, 19.5-bit ADCs, up to 2900fps |
| Power Mgmt | Maxim MAX77818 | Dual-input charger, fuel gauge |
| Temperature | Maxim MAX6631MTT | 12-bit digital sensor, +/-1C accuracy |

### Sensors

- 5 LEDs: 3 green, 1 red, 1 infrared
- 4 photodiodes
- 3-axis accelerometer + 3-axis gyroscope (52Hz)
- Skin temperature thermistor
- Capacitive touch sensor

### On-Device Processing

The firmware performs **minimal processing** to conserve battery:

- Basic HR extraction from raw PPG (enough for live BLE HR broadcast)
- Motion artifact compensation is limited on-device
- Stores raw-ish 96-byte sensor records at 1-second intervals
- **Critical**: the on-device HR is a rough estimate for real-time display only. Whoop does NOT use it for scoring.

### On-Device Storage

The strap maintains a **rolling 3-day buffer** of historical data. If the strap cannot sync for 3 days, the oldest data is overwritten to make room for new recordings.

---

## Stage 2: Strap to Phone (BLE Transfer)

When the phone is in Bluetooth range with the Whoop app open (even backgrounded):

1. Strap and phone maintain a BLE 5.0 connection
2. Strap streams buffered historical data in batches:
   - `HISTORY_START` metadata
   - Many `HISTORICAL_DATA` packets (96-byte records)
   - `HISTORY_END` with trim pointer
   - Phone ACKs the trim pointer (tells strap it can free that memory)
   - Repeat until `HISTORY_COMPLETE`
3. Both Bluetooth AND internet (WiFi/cellular) are required

### Transfer Speed

- **Normal BLE**: syncing 24 hours of data takes approximately **45 minutes**
- **High-frequency mode** (cmd 96/97): changes BLE connection interval to minimum, achieving ~90x faster transfer (<1 minute for a full day)

### "Data Catching Up"

Whoop's term for when the strap has accumulated hours/days of unsynced data. A progress indicator shows in the app while the buffer drains.

---

## Stage 3: Phone to Cloud (Upload)

The phone relays raw sensor data to Whoop's backend over HTTPS (TLS encrypted).

**API endpoint**: `api.prod.whoop.com`

### Infrastructure Stack (from job listings and engineering blog)

| Component | Technology |
|-----------|-----------|
| Cloud | AWS (EC2, VPC, S3, RDS, ElastiCache, IAM, CloudTrail) |
| Orchestration | Kubernetes (multi-cluster, AWS, Ubuntu nodes migrating to Flatcar) |
| Streaming | Kafka (event streaming / data pipeline backbone) |
| Database | PostgreSQL (via AWS RDS) |
| Caching | ElastiCache (Redis) |
| IaC | Terraform |
| Monitoring | Datadog |
| OS | Ubuntu (migrating to Flatcar container OS) |

### Likely Data Flow

```
Phone -> API Gateway -> Kafka (raw sensor ingestion topic) -> Processing consumers -> PostgreSQL (RDS) + S3 (raw/archival)
```

### Scale

During product launches, Whoop has scaled to handle **10x mobile traffic** and **200x e-commerce traffic** while maintaining 100% availability (May 2025 launch).

---

## Stage 4: Cloud Processing

This is the core differentiator. Whoop performs **heavy post-processing in the cloud**, not on the device or phone.

### Heart Rate Cleanup (ML-Based)

The raw PPG signal from the strap is noisy, especially during exercise (motion artifacts). Whoop runs ML models in the cloud after a workout completes:

- Motion artifact removal using accelerometer data correlation
- ML models trained on data from **4,000+ individuals, 20,000+ datasets, 50 million heartbeats**
- Achieves **10% accuracy improvement** over Whoop 3.0 across all activities
- The cloud-cleaned HR is what ALL downstream metrics use, NOT the live BLE broadcast

This is why the Whoop app sometimes retroactively adjusts workout HR data after syncing — the cloud reprocessed it.

### Sleep Staging

ML models classify sleep into 4 stages:
- Wake
- Light sleep
- REM sleep
- Slow-wave (deep) sleep

Trained on **polysomnography (PSG) ground truth** — the gold standard where participants sleep in labs wired to EEG/EMG sensors. Input features: HR, HRV, respiration rate, and accelerometer data.

### Recovery Score

Computed server-side from cloud-cleaned data. Weighted combination of:
- **HRV (RMSSD)**: ~60-70% weight (heaviest)
- **Resting heart rate**: ~15-20%
- **Respiratory rate**
- **Sleep quality/duration**
- **SpO2**
- **Skin temperature**

All compared against a **personal rolling baseline** (approximately 60-day window).

### Strain Score

Calculated from cloud-cleaned HR using a cardiovascular load model, mapped to Whoop's 0-21 logarithmic scale.

### Algorithm Updates

Whoop pushes algorithm updates via firmware + cloud pipeline simultaneously. The February 2026 update involved "core algorithmic rework, model re-architecture and retraining":
- Better HR signal separation from motion noise during activities
- Fewer spurious HR spikes outside exertion periods
- Preserved peak HR accuracy during high-intensity efforts

Rollout process: Whoop Labs testing -> internal employee testing -> external beta (Whoop Insiders) -> phased public rollout.

---

## Stage 5: Cloud Storage

### Encryption

- **At rest**: AES-256 bit encryption
- **In transit**: TLS/HTTPS
- **BLE link**: Standard BLE security protocols (specs 4.2+)

### Storage

- **AWS RDS (PostgreSQL)**: structured/processed data (scores, metrics, user profiles)
- **AWS S3**: raw/archival data (sensor dumps, binary packets)
- **ElastiCache (Redis)**: hot data caching for app requests

### Location

All data stored in **United States servers only**. Non-US users' connections are routed through US servers. Users explicitly consent to US data transfer.

### Retention

**Indefinite** — Whoop keeps your entire history as long as you have an account. This powers multi-year baseline comparisons and longitudinal trend analysis.

### Compliance

- **NOT HIPAA-covered**: Whoop is a consumer device, not a healthcare provider. Federal health privacy rules don't apply.
- Follows **CCPA** (California) and **GDPR** (EU)
- ECG/blood pressure data from advanced features stored separately and encrypted under medical device regulations

---

## Stage 6: Cloud to App (Display)

When you open the Whoop app:

1. App authenticates via OAuth 2.0 to `api.prod.whoop.com`
2. Requests processed summaries — recovery score, strain, sleep stages, HRV trends
3. The app is primarily a **display layer** — all heavy computation happened server-side
4. Third-party developers get access via the same REST API (developer.whoop.com)

### Developer API Data Available

- Recovery scores
- Sleep data (stages, duration, consistency)
- Strain metrics
- Workout data
- Webhooks for real-time event notifications

### Developer API Data NOT Available

- No 1Hz heart rate
- No RR intervals
- No raw PPG data
- No accelerometer/gyroscope data
- No raw SpO2 photodiode values
- No raw skin temperature ADC values

**Summaries only. Raw sensor data is never exposed.**

---

## Stage-by-Stage Comparison: Whoop Cloud vs OpenWhoop

### Stage 1: Sensor Data Collection

| Aspect | Whoop Cloud | OpenWhoop |
|--------|------------|-----------|
| Data source | Same Whoop 4.0 strap | Same Whoop 4.0 strap |
| Sensor access | All sensors via proprietary firmware | All sensors via reverse-engineered BLE protocol |
| On-device processing | Minimal (basic HR for live broadcast) | None (raw packets decoded client-side) |
| Difference | Identical — same hardware, same raw data |

### Stage 2: Data Transfer (BLE)

| Aspect | Whoop Cloud | OpenWhoop |
|--------|------------|-----------|
| Protocol | BLE 5.0, proprietary GATT service | Same BLE 5.0, same GATT characteristics |
| Normal sync speed | ~45 minutes per 24h of data | Same (conservative BLE connection interval) |
| High-freq sync | Used by official app (undocumented) | Supported via cmd 96/97 (~90x faster) |
| Packet format | 96-byte V12/V24 historical packets | Same — fully decoded |
| Trim pointer | Phone ACKs, strap frees memory | Client ACKs, strap frees memory |
| Multi-device | Only one connection at a time | Only one connection at a time |
| Difference | **Functionally identical at the BLE layer** |

### Stage 3: Data Relay

| Aspect | Whoop Cloud | OpenWhoop |
|--------|------------|-----------|
| Intermediary | Phone app (thin relay) | None (direct BLE to local machine) |
| Upload destination | `api.prod.whoop.com` over HTTPS | Local SQLite file |
| Internet required | Yes (WiFi/cellular) | No |
| Latency | Phone -> cloud (variable, network-dependent) | Instant (local write) |
| Difference | **Whoop requires internet; OpenWhoop is fully offline** |

### Stage 4: Data Processing

| Aspect | Whoop Cloud | OpenWhoop |
|--------|------------|-----------|
| HR cleanup | ML models (4,000+ individuals' training data) | None — uses raw HR from strap as-is |
| Sleep detection | ML model trained on PSG ground truth, 4-stage | Gravity-based heuristic, binary (sleep/not sleep) |
| Sleep staging | Wake, Light, REM, Deep | Not implemented |
| Recovery score | Weighted multi-metric against personal 60-day baseline | Not implemented (schema exists, algorithm TBD) |
| Strain | Proprietary cardiovascular load model | Edwards TRIMP (published formula, 0-21 scale) |
| Stress | Not exposed as a metric | Baevsky Stress Index (histogram-based, published) |
| HRV | RMSSD + proprietary normalization | RMSSD, SDNN, frequency-domain (LF/HF), normalized (0-100) |
| SpO2 | Proprietary (likely calibrated per-device) | Beer-Lambert ratio-of-ratios (generic formula) |
| Skin temp | Calibrated conversion | Linear: raw x 0.04 (empirical) |
| Processing location | AWS cloud (Kubernetes + Kafka) | Local machine (Python, pure functions) |
| Training data | Millions of users | n=1 (your data only) |
| Difference | **Whoop has vastly superior ML models and training data. OpenWhoop uses transparent, published algorithms that are simpler but auditable.** |

### Stage 5: Storage

| Aspect | Whoop Cloud | OpenWhoop |
|--------|------------|-----------|
| Raw sensor data | AWS S3 (archival) + RDS (structured) | SQLite `heart_rate` table (every 1-second reading preserved) |
| Processed metrics | AWS RDS (PostgreSQL) | SQLite `sleep_cycles`, `activities`, `daily_scores` tables |
| Packet log | Unknown (likely exists internally) | SQLite `packets` table (raw hex for debugging/replay) |
| Encryption at rest | AES-256 | None (plain SQLite file) |
| Encryption in transit | TLS/HTTPS | N/A (local only) |
| Retention | Indefinite (as long as account exists) | Indefinite (as long as you keep the file) |
| Location | US-based AWS servers | Your local machine |
| Backup | AWS-managed (RDS snapshots, S3 durability) | Your responsibility |
| Data ownership | Whoop owns it (per ToS) | You own it completely |
| Difference | **Whoop has enterprise-grade storage but you don't own it. OpenWhoop is a single file you fully control but must manage yourself.** |

### Stage 6: Data Access / Display

| Aspect | Whoop Cloud | OpenWhoop |
|--------|------------|-----------|
| Interface | Polished iOS/Android app | CLI commands |
| Data granularity exposed | Summaries only (scores, stages, trends) | Full 1Hz raw sensor data + computed metrics |
| API | REST API (OAuth 2.0, summaries only) | Direct SQLite queries (full access to everything) |
| Third-party integrations | Webhooks, Strava, Apple Health, etc. | None (export via SQL/pandas) |
| Visualization | Built-in charts, trends, coach features | Not implemented (plotly/matplotlib in optional deps) |
| Difference | **Whoop has a polished UX but gates raw data. OpenWhoop gives full data access but no visualization layer yet.** |

---

## Storage Deep Dive: Raw vs Processed Data

### How OpenWhoop Stores Raw Data

All raw sensor data lives in the **`heart_rate`** table — one row per second of recording:

```
heart_rate table (raw sensor data):
+-----------+------------+-----+---------------+
| timestamp | subseconds | bpm | rr_intervals  |  <- always present
+-----------+------------+-----+---------------+
| ppg_green | ppg_red_ir | gravity_x/y/z    |  <- V12/V24 packets only
| skin_contact | spo2_red | spo2_ir          |  (NULL for generic packets)
| skin_temp_raw | ambient_light              |
| resp_rate_raw | signal_quality             |
+-----------+----------------------------------+
| activity  | stress | spo2 | skin_temp       |  <- computed later by algorithms
+-----------+----------------------------------+
| synced    |                                   |  <- sync tracking flag
+-----------+-----------------------------------+
```

Key design decisions:
- **Raw and computed data coexist in the same row**: the `activity`, `stress`, `spo2`, and `skin_temp` columns are NULL on initial insert and filled in later when you run `detect-events`, `calculate-stress`, etc.
- **Deduplication**: unique constraint on `(timestamp, subseconds)` prevents duplicate inserts
- **RR intervals stored as JSON**: `rr_intervals` column holds a JSON array of millisecond values (up to 4 per second). This is flexible but means you can't query individual RR values with SQL directly.
- **No data loss**: generic packets (older firmware, minimal decode) still get inserted with NULL sensor columns. V12/V24 packets fill all columns.

### How OpenWhoop Stores Processed Metrics

Processed data goes into separate tables:

```
sleep_cycles table:
+----------+--------+------------------+
| start_ts | end_ts | duration_seconds |
| min_bpm  | max_bpm | avg_bpm         |
| min_hrv  | max_hrv | avg_hrv         |
| score    |                            |
+----------+----------------------------+

activities table:
+----------+--------+------------------+
| start_ts | end_ts | duration_seconds |
| activity_type     | strain           |
+----------+--------+------------------+

daily_scores table:
+----------+----------+-------------+
| date     | recovery | strain      |
| sleep_score | hrv   | rhr         |
| spo2     | skin_temp | resp_rate  |
+----------+----------+-------------+

packets table (debug/replay):
+-------------+-------------+-----+-----+---------+
| received_at | packet_type | seq | cmd | raw_hex |
+-------------+-------------+-----+-----+---------+
```

### What's Stored vs What's Computed On-the-Fly

| Data | Stored in DB? | How it gets there |
|------|--------------|-------------------|
| 1Hz HR (bpm) | Yes, `heart_rate.bpm` | Directly from BLE packet decode |
| RR intervals | Yes, `heart_rate.rr_intervals` (JSON) | Directly from BLE packet decode |
| Gravity vector | Yes, `heart_rate.gravity_x/y/z` | From V12/V24 packets |
| PPG values | Yes, `heart_rate.ppg_green/ppg_red_ir` | From V12/V24 packets |
| SpO2 raw photodiode | Yes, `heart_rate.spo2_red/spo2_ir` | From V12/V24 packets |
| Skin temp raw ADC | Yes, `heart_rate.skin_temp_raw` | From V12/V24 packets |
| Raw packet hex | Yes, `packets.raw_hex` | Logged for debugging |
| Activity classification | Yes, `heart_rate.activity` | Written by `detect-events` command |
| Sleep cycles | Yes, `sleep_cycles` table | Written by `detect-events` command |
| Sleep score | Yes, `sleep_cycles.score` | Computed during `detect-events` |
| Strain score | Partially — `activities.strain` | Written by `detect-events` (TBD) |
| Stress index | **Not stored** | `calculate-stress` prints to stdout only |
| SpO2 percentage | **Not stored** | `calculate-spo2` prints to stdout only |
| Skin temp (Celsius) | Yes, `heart_rate.skin_temp` | Written during `upsert_readings` if V12/V24 |
| Daily scores | Yes, `daily_scores` table | Schema exists, not yet populated by any command |
| Recovery score | **Not implemented** | Schema exists in `daily_scores.recovery`, no algorithm yet |
| HRV metrics | **Not stored** | No CLI command writes HRV to DB |

### Storage Gaps (vs Whoop Cloud)

1. **Stress, SpO2, HRV are calculated but not persisted** — the CLI commands print them to stdout but don't write back to the database. You'd lose the result after the terminal session.

2. **Daily scores table is unused** — the schema exists (`daily_scores` with columns for recovery, strain, sleep_score, hrv, rhr, spo2, skin_temp, resp_rate) but no CLI command populates it. This was designed as the equivalent of Whoop's daily summary view.

3. **No recovery score algorithm** — the `daily_scores.recovery` column exists but there's no implementation. RESEARCH.md outlines a formula-based approach using weighted HRV/RHR/sleep/resp against a 60-day rolling baseline, but it's not coded yet.

4. **No time-windowed analysis** — Whoop processes data in daily windows and maintains rolling baselines. OpenWhoop's `calculate-*` commands operate on the entire dataset at once, giving you a single aggregate number rather than per-day or per-activity scores.

5. **No data versioning or reprocessing** — Whoop can retroactively reprocess historical data when they ship algorithm updates. OpenWhoop's computed columns are write-once.

---

## Architecture Diagram

```
Whoop Cloud:
                                                              
  Whoop 4.0 Strap                                             
  [Sensors -> 3-day buffer]                                    
         |                                                     
         | BLE 5.0 (~45 min/day normal)                        
         v                                                     
  Smartphone App (thin relay)                                  
         |                                                     
         | HTTPS (TLS)                                         
         v                                                     
  api.prod.whoop.com (AWS)                                     
         |                                                     
         v                                                     
  Kafka -> ML Processing Pipeline -> PostgreSQL (RDS) + S3     
  (HR cleanup, sleep staging, recovery, strain)                
         |                                                     
         v                                                     
  REST API (OAuth 2.0) -> App (summaries only)                 


OpenWhoop:

  Whoop 4.0 Strap
  [Sensors -> 3-day buffer]
         |
         | BLE 5.0 (high-freq: <1 min/day)
         v
  Your Computer (Python + bleak)
         |
         | Direct local write
         v
  SQLite Database (openwhoop.db)
  [heart_rate, sleep_cycles, activities, daily_scores, packets]
         |
         v
  CLI Commands (offline, pure-function algorithms)
  [detect-events, calculate-stress, calculate-spo2, etc.]
         |
         v
  Terminal output + DB updates
```

---

## Sources

- [WHOOP CTO on 4.0 Design & Accuracy](https://www.whoop.com/us/en/thelocker/chief-technology-officer-whoop-4-0-accuracy/)
- [WHOOP Heart Rate Algorithm Update (Feb 2026)](https://the5krunner.com/2026/02/28/whoop-heart-rate-accuracy-update/)
- [Cambridge Consultants — WHOOP Wearable Technology](https://www.cambridgeconsultants.com/project/revolutionary-sports-wearable-technology-for-whoop/)
- [WHOOP Developer Platform](https://developer.whoop.com/docs/introduction/)
- [WHOOP "Data Catching Up" Support](https://support.whoop.com/s/article/Why-is-my-WHOOP-Catching-Up)
- [WHOOP Engineering Blog — Infrastructure](https://engineering.prod.whoop.com/tags/infrastructure/)
- [WHOOP Privacy Practices Analysis](https://www.devproblems.com/whoops-privacy-practices/)
- [WHOOP Privacy Policy](https://www.whoop.com/us/en/full-privacy-policy/)
- [WHOOP AI-Powered AWS Transformation](https://www.zenml.io/llmops-database/ai-powered-transformation-of-aws-support-for-mission-critical-workloads)
- [WHOOP Firmware Release Notes](https://support.whoop.com/s/article/WHOOP-4-0-Firmware-Release-Notes)
- [WHOOP Data Storage Support](https://support.whoop.com/hc/en-us/articles/360020030954-How-much-data-is-stored-on-my-WHOOP-Strap-)
