# OpenWhoop Research: Cloning Whoop 4.0 End-to-End

*Research conducted March 2026*

---

## 1. Existing Projects Landscape

### 1.1 BLE Reverse Engineering Projects

| Project | Stars | Lang | Status | What it does |
|---------|-------|------|--------|-------------|
| [bWanShiTong/openwhoop](https://github.com/bWanShiTong/openwhoop) | 114 | Rust | Active (Mar 2026) | Full CLI, most mature. Sleep/exercise detection, SpO2, skin temp, stress, strain, SQLite/PG |
| [jogolden/whoomp](https://github.com/jogolden/whoomp) | 76 | JS+Python | Stable | Web Bluetooth app + Python BLE client. Full protocol RE, basic HRV |
| [bWanShiTong/reverse-engineering-whoop-post](https://github.com/bWanShiTong/reverse-engineering-whoop-post) | 167 | Docs | Complete | Detailed RE write-up. Hit Hacker News front page |
| [bWanShiTong/reverse-engineering-whoop](https://github.com/bWanShiTong/reverse-engineering-whoop) | 50 | Python | Archived | Packet capture tools, partial decoding |

### 1.2 API/Data Projects

| Project | Lang | What it does |
|---------|------|-------------|
| [jjur/whoop-sleep-HR-data-api](https://github.com/jjur/whoop-sleep-HR-data-api) | Python | Unofficial API, HR at 6-second intervals |
| [jacc/whoop-re](https://github.com/jacc/whoop-re) | - | Production REST API reverse engineering |
| Official API (developer.whoop.com) | REST | OAuth 2.0, summaries only, no raw data |

### 1.3 Decision: Fork whoomp, Port from openwhoop

**whoomp** is our fork base because:
- Python + JavaScript (our preferred stack)
- Working Web Bluetooth app (our UI target)
- Full BLE protocol in both Python (bleak) and JS
- HRV analysis scripts already exist

**openwhoop** is our knowledge source because:
- Decoded the FULL 96-byte historical packet (whoomp couldn't)
- Has sleep/exercise detection, SpO2, skin temp, stress, strain algorithms
- Has proper database storage (SQLite/PostgreSQL)
- More robust BLE handling (high-freq sync, multi-packet assembly, auto-reconnect)

---

## 2. Whoop 4.0 Hardware

### Chipset
| Component | Chip | Function |
|-----------|------|----------|
| BLE SoC | Nordic nRF52840 | BLE 5.0, ARM Cortex-M4 @ 64MHz, 1MB Flash, 256KB RAM |
| App Processor | Maxim MAX32652 | ARM Cortex-M4 with FPU @ 120MHz, 3MB Flash, 1MB SRAM |
| Optical AFE | Maxim MAX86171 | PPG front-end, 19.5-bit ADCs, 1-2900fps, 4 PD inputs, 9 LED outputs |
| Power Mgmt | Maxim MAX77818 | Dual-input charger, 95.6% peak efficiency, fuel gauge |
| Temperature | Maxim MAX6631MTT | Digital sensor, 12-bit resolution, ±1°C accuracy |
| Battery | Sila Nanotechnologies | Silicon anode, 17% higher density than Whoop 3.0 |

### Sensors
- 5 LEDs: 3 green, 1 red, 1 infrared
- 4 photodiodes
- 3-axis accelerometer + 3-axis gyroscope (52Hz)
- Skin temperature thermistor
- Capacitive touch sensor

### vs Whoop 3.0
- 33% smaller form factor
- Added SpO2 (red/IR LEDs), temperature, haptic motor
- BLE 5.0 (was 4.0+)
- USB-C battery pack (was wireless clip)
- New Gen4 packet framing protocol

---

## 3. BLE Protocol (Complete Reference)

### GATT Service
Custom service: `61080001-8d6d-82b8-614a-1c8cb0f8dcc6`

| UUID | Name | Properties |
|------|------|------------|
| 0x61080002 | CMD_TO_STRAP | Write |
| 0x61080003 | CMD_FROM_STRAP | Notify |
| 0x61080004 | EVENTS_FROM_STRAP | Notify |
| 0x61080005 | DATA_FROM_STRAP | Notify |
| 0x61080007 | MEMFAULT | Notify |

Standard BLE HR Service (0x180D) also available but must be enabled via command 14.

### Packet Frame Format
```
[SOF: 0xAA] [Length: u16 LE] [CRC-8] [Payload: type(1) + seq(1) + cmd(1) + data(N)] [CRC-32: u32 LE]
```

- **Length** = payload length + 4 (includes CRC-32 size)
- **CRC-8**: Polynomial 0x07, init 0x00, computed over 2 length bytes only
- **CRC-32**: Standard (poly 0xEDB88320, init 0xFFFFFFFF, final XOR 0xFFFFFFFF) = Python's `zlib.crc32()`
- **Sequence number**: NOT validated by device (any value accepted)
- **CRC-32**: IS validated (bad checksums rejected)
- **No application-layer encryption** — only standard BLE link encryption

### Packet Types
| Type | ID | Description |
|------|-----|------------|
| COMMAND | 35 (0x23) | Commands TO strap |
| COMMAND_RESPONSE | 36 (0x24) | Responses FROM strap |
| REALTIME_DATA | 40 (0x28) | Live HR/RR data (1Hz) |
| REALTIME_RAW_DATA | 43 (0x2B) | Raw optical/sensor data |
| HISTORICAL_DATA | 47 (0x2F) | Stored 1-second records |
| EVENT | 48 (0x30) | Async events |
| METADATA | 49 (0x31) | History download control |
| CONSOLE_LOGS | 50 (0x32) | Firmware debug output |
| REALTIME_IMU | 51 (0x33) | Live accel+gyro stream |
| HISTORICAL_IMU | 52 (0x34) | Stored IMU data |

### Key Commands (68 total)
| Command | ID | Implemented in whoomp? | openwhoop? |
|---------|-----|----------------------|------------|
| TOGGLE_REALTIME_HR | 3 | Yes | Yes |
| REPORT_VERSION_INFO | 7 | Yes | Yes |
| SET_CLOCK | 10 | No | Yes |
| GET_CLOCK | 11 | Yes | Yes |
| TOGGLE_GENERIC_HR_PROFILE | 14 | Yes (Python) | Yes |
| SEND_HISTORICAL_DATA | 22 | Yes | Yes |
| HISTORICAL_DATA_RESULT | 23 | Yes | Yes |
| GET_BATTERY_LEVEL | 26 | Yes | Yes |
| REBOOT_STRAP | 29 | Yes | Yes |
| GET_HELLO_HARVARD | 35 | Yes | Yes |
| SET_ALARM_TIME | 66 | No | Yes |
| RUN_ALARM | 68 | Yes | Yes |
| RUN_HAPTICS_PATTERN | 79 | Yes | Yes |
| START_RAW_DATA | 81 | Yes (no parser) | Yes |
| STOP_RAW_DATA | 82 | Yes | Yes |
| ENTER_HIGH_FREQ_SYNC | 96 | No | Yes (90x faster) |
| EXIT_HIGH_FREQ_SYNC | 97 | No | Yes |
| TOGGLE_IMU_MODE | 106 | No | Yes |
| ENABLE_OPTICAL_DATA | 107 | No | Yes |

### Historical Data Protocol
1. Send `SEND_HISTORICAL_DATA` (cmd 22, data `[0x00]`)
2. Receive batches: `HISTORY_START` → many `HISTORICAL_DATA` packets → `HISTORY_END`
3. Extract trim pointer from `HISTORY_END` (u32 LE at offset 10)
4. Acknowledge: `HISTORICAL_DATA_RESULT` (cmd 23, data `[0x01, trim_le_bytes, 0,0,0,0]`)
5. Repeat until `HISTORY_COMPLETE`

---

## 4. The Critical 96-Byte Historical Packet Decode

### What whoomp decodes (generic parser)
```
Offset  Type     Field
[4:8]   u32 LE   unix timestamp
[8:10]  u16 LE   subseconds
[10:14] u32 LE   unknown (flags/counters)
[14]    u8       heart rate (BPM)
[15]    u8       RR interval count (0-4)
[16:24] u16 LE×4 RR intervals (milliseconds)
```
**Bytes 24-92: UNKNOWN in whoomp**

### What openwhoop decodes (V12/V24 parser) — THE BREAKTHROUGH
For packets with seq=12 or seq=24 and length >= 77:
```
Offset  Type       Field
[0:4]   u32 LE     sequence
[4:8]   u32 LE     unix timestamp (seconds)
[8:10]  u16 LE     subseconds
[10:12] u16 LE     flags
[12]    u8         sensor_m
[13]    u8         sensor_n
[14]    u8         heart rate (BPM)
[15]    u8         RR count
[16:24] u16 LE×4   RR intervals (ms)
[24:26] u16 LE     ppg_flags
[26:28] u16 LE     ppg_green       ← PPG green LED photodiode
[28:30] u16 LE     ppg_red_ir      ← PPG red/IR LED photodiode
[33:45] f32 LE×3   accel_gravity   ← Gravity vector [x,y,z]
[48]    u8         skin_contact    ← 0=off wrist
[61:63] u16 LE     spo2_red        ← SpO2 red LED raw ADC
[63:65] u16 LE     spo2_ir         ← SpO2 infrared raw ADC
[65:67] u16 LE     skin_temp_raw   ← Thermistor raw ADC
[67:69] u16 LE     ambient_light   ← Ambient light photodiode
[69:71] u16 LE     led_drive_1     ← LED drive current 1
[71:73] u16 LE     led_drive_2     ← LED drive current 2
[73:75] u16 LE     resp_rate_raw   ← Respiratory rate
[75:77] u16 LE     signal_quality  ← Signal quality index
```

### IMU Packets (length >= 1188 bytes, 100 samples per packet)
```
Offset  Type        Field
[85]    i16 BE×100  accel_x (divide by 1875.0 for g)
[285]   i16 BE×100  accel_y
[485]   i16 BE×100  accel_z
[688]   i16 BE×100  gyro_x (divide by 15.0 for dps)
[888]   i16 BE×100  gyro_y
[1088]  i16 BE×100  gyro_z
```

---

## 5. Repo-to-Repo Comparison: whoomp vs openwhoop

### Features Matrix

| Feature | whoomp (JS+Python) | openwhoop (Rust) | Notes |
|---------|-------------------|------------------|-------|
| **BLE Connection** | Web Bluetooth + bleak | btleplug | Both work on macOS |
| **Web App** | Yes (Chart.js) | No (CLI only) | whoomp advantage |
| **Real-time HR Display** | Yes (live chart) | Yes (terminal) | |
| **Historical Download** | Yes (binary dump) | Yes (parsed → DB) | openwhoop is smarter |
| **High-Freq Sync** | No | Yes (90x faster) | Critical to port |
| **Multi-packet Assembly** | No | Yes | Reliability improvement |
| **Auto-reconnect** | No | Yes (5 retries) | Nice to have |
| **Basic Packet Parsing** | Yes (HR + RR only) | Yes (full decode) | Port V12/V24 parser |
| **V12/V24 Sensor Data** | No | Yes | **THE key difference** |
| **IMU Data Parsing** | No | Yes (100 samples/pkt) | |
| **Sleep Detection** | No | Yes (gravity-based) | Port this |
| **Exercise Detection** | No | Yes (gravity-based) | Port this |
| **HRV (RMSSD)** | Yes (basic) | Yes (rolling 300-sample) | openwhoop is better |
| **HRV (SDNN)** | Yes | No | whoomp has this |
| **HRV (Frequency Domain)** | Yes (LF/HF) | No | whoomp has this |
| **Stress (Baevsky SI)** | No | Yes | Port this |
| **Strain (Edwards TRIMP)** | No | Yes (0-21 scale) | Port this |
| **SpO2** | No | Yes (Beer-Lambert) | Port this |
| **Skin Temperature** | No | Yes (raw × 0.04) | Port this |
| **Sleep Consistency** | No | Yes (CV-based) | Port this |
| **Recovery Score** | No | No | Neither has it |
| **Sleep Stage Classification** | No | No | Neither has it |
| **Respiratory Rate** | No | Field decoded, not used | Easy win |
| **Database Storage** | No (binary dumps) | Yes (SQLite/PG) | Port schema |
| **Data Export** | No | SQL queries + pandas | |
| **Console Logs** | Yes | Yes | |
| **Haptics/Vibration** | Yes (web UI) | No | whoomp advantage |
| **Set Alarm** | No | Yes | |
| **Set Clock** | No | Yes | |
| **Erase Device** | No | Yes | |
| **Firmware Download** | No | Yes (WHOOP API) | |

### Key Insight
**whoomp is the better foundation** (Python, web app, simpler to extend), but **openwhoop has the knowledge** (full packet decode, algorithms, database). Our strategy: fork whoomp, port openwhoop's brains into it.

---

## 6. Algorithms: What openwhoop Implements

### 6.1 Sleep Detection (Gravity-Based)
```
For each consecutive pair of gravity readings:
  delta = sqrt(dx² + dy² + dz²)
  if delta < 0.01g → "still"

Rolling 15-minute window:
  if >= 70% "still" → classify as "sleep"

Post-processing:
  - Minimum sleep duration: 60 minutes
  - Merge gaps < 20 minutes
  - Absorb short activity periods < 15 minutes
```

### 6.2 HRV (RMSSD)
```
Rolling window of 300 RR intervals
RMSSD = sqrt(mean(diff(RR)²))
```
whoomp also has: `ln(RMSSD) / 6.5 * 100` → normalized 0-100 score (EliteHRV method)

### 6.3 Stress (Baevsky Stress Index)
```
Build histogram of RR intervals (50ms bins)
Find mode = most frequent bin center
mode_freq = count in that bin

SI = AMo / (2 × VR × Mo)
  AMo = mode_freq / total_count × 100
  VR = (max_RR - min_RR) / 1000
  Mo = mode / 1000

Normal range: 80-150
Mild stress: 1.5-2x increase
Severe stress: 5-10x increase
Score capped at 10.0
```

### 6.4 Strain (Edwards TRIMP)
```
For each HR sample:
  %HRR = (bpm - resting_hr) / (max_hr - resting_hr) × 100
  Zone 1: 50-60% HRR → weight 1
  Zone 2: 60-70% HRR → weight 2
  Zone 3: 70-80% HRR → weight 3
  Zone 4: 80-90% HRR → weight 4
  Zone 5: 90%+ HRR  → weight 5

TRIMP = Σ(sample_duration_minutes × zone_weight)
Strain = 21 × ln(TRIMP + 1) / ln(7201)   [capped at 21.0]

Calibration: 24h at max HR = TRIMP 7200 = strain 21.0
Minimum: 600 readings (10 min at 1Hz)
```

### 6.5 SpO2 (Blood Oxygen)
```
Window: 30 readings with valid spo2_red and spo2_ir

AC_red = std(spo2_red),  DC_red = mean(spo2_red)
AC_ir  = std(spo2_ir),   DC_ir  = mean(spo2_ir)

R = (AC_red / DC_red) / (AC_ir / DC_ir)
SpO2 = 110.0 - 25.0 × R    [clamped 70-100%]

Standard Beer-Lambert ratio-of-ratios method
```

### 6.6 Skin Temperature
```
temp_celsius = skin_temp_raw × 0.04
Min raw: 100 (below = off-wrist)
Maps raw 582-1125 → 23-45°C (physiologically reasonable)
```

### 6.7 Sleep Consistency
```
Over N nights, compute for each metric:
  CV = std / mean × 100

Duration score: max(0, 100 - CV_duration)
Timing score: mean(max(0, 100-CV) for start, end, midpoint)
Overall: mean of all 4 scores
```

### 6.8 Sleep Score (openwhoop — simplistic)
```
score = min(duration_seconds / (8 × 3600), 1.0) × 100
```
NOTE: Uses integer division — any sleep < 8h scores 0. Known bug.

---

## 7. ML/Analysis: What's NOT Done Anywhere

### 7.1 Feature Feasibility Matrix

| Feature | Difficulty | Timeframe | Approach | Expected Accuracy |
|---------|-----------|-----------|----------|-------------------|
| Recovery Score (formula) | Medium | 1-2 weeks | Weighted HRV/RHR/sleep/resp baseline comparison | ~0.6-0.8 correlation with Whoop |
| Recovery Score (ML) | Hard | 1-3 months | Gradient boosted trees on personal baseline data | Better, but needs data collection |
| Sleep Stage Classification | Hard | 2-4 months | LSTM/CNN on HR+accel (SleepPPG-Net2 architecture) | 75-83% (4-class), kappa 0.65-0.75 |
| Activity Type Recognition | Hard | 2-3 months | CNN-LSTM on 52Hz IMU data | 70-85% for specific types |
| Respiratory Rate | Easy-Medium | Days-1 week | resp_rate_raw field may be directly usable | MAE 1-2 breaths/min |
| Calorie Estimation | Medium | 1-2 weeks | Keytel/Charlot HR-based equations + BMR | 20-40% MAPE (state of art) |
| VO2 Max | Very Hard | 3-6 months | Submaximal HR-workload; no GPS available | Research-level problem |

### 7.2 Recovery Score Approach
Whoop's recovery combines: HRV (~60-70% weight), RHR (~15-20%), respiratory rate, sleep quality, SpO2, skin temperature.

**Formula-based approach:**
```python
# Normalize each metric against personal 60-day rolling baseline
norm_hrv = (hrv - baseline_hrv) / std_hrv  # z-score
norm_rhr = -(rhr - baseline_rhr) / std_rhr  # inverted (lower is better)
norm_sleep = sleep_score / 100
norm_resp = -(resp - baseline_resp) / std_resp  # lower is better

recovery = sigmoid(0.5*norm_hrv + 0.2*norm_rhr + 0.15*norm_sleep + 0.1*norm_resp + 0.05*norm_spo2)
```

### 7.3 Sleep Staging State-of-Art
Best open-source models for PPG+accelerometer:
- [SleepPPG-Net2](https://arxiv.org/html/2404.06869v1) — 80.8% accuracy, kappa 0.70
- [sleep-staging-models](https://github.com/DavyWJW/sleep-staging-models) (UbiComp 2025) — 83.3% accuracy, kappa 0.745
- Public training data: MESA (~2000 subjects, PSG + accel + PPG)

### 7.4 Python Libraries Recommended

| Capability | Library | Why |
|-----------|---------|-----|
| BLE | bleak | Already in whoomp, cross-platform, async |
| Signal processing | scipy.signal, neurokit2 | Filtering, peak detection, PPG |
| HRV (comprehensive) | neurokit2 | 124 metrics, published paper |
| HRV (PPG-specific) | heartpy | Handles wrist PPG noise well |
| ML (classical) | scikit-learn | Recovery regression, activity detection |
| ML (deep learning) | pytorch | Sleep staging CNN/LSTM |
| Database | SQLite via sqlalchemy | Compatible with openwhoop schema |
| Web backend | FastAPI | API for web dashboard |
| Web frontend | React / Streamlit | Streamlit for prototype, React for production |
| Visualization | plotly | Interactive, works in web + notebooks |
| Data manipulation | pandas | Time-series standard |

---

## 8. Constraints and Limitations

### BLE
- **One connection at a time**: Our app OR official Whoop app, not both
- **Range**: ~10m typical BLE range
- **macOS**: No MAC address exposed; must use device name
- **Battery**: Continuous streaming increases Whoop battery drain
- **Connection stability**: Drops happen; need auto-reconnect + historical bulk download fallback

### Data Quality
- **PPG noise**: Motion artifacts during exercise degrade HR/HRV accuracy
- **RR intervals unreliable during exercise**: Some dropped/erroneous
- **Gravity vector vs full IMU**: Historical data has low-freq gravity only; 52Hz IMU needs separate real-time collection
- **Sensor calibration**: openwhoop's conversion factors (temp × 0.04) are empirical, may vary per device

### ML Training
- **No PSG ground truth** for sleep staging from our device
- **Domain gap** from public datasets (different sensors, ADC characteristics)
- **n=1 user**: Whoop trained on millions; we have one user's data
- **No labeled recovery data**: Need self-reported or performance-based labels
- **Individual variation**: HRV norms vary hugely between people

### What Whoop Has That We Can't Replicate
- Millions of users' training data
- Professional PSG-labeled sleep data
- Per-device factory calibration
- Server-side DSP pipeline refined over years
- Published clinical validation studies
- Longitudinal population-level models

### Legal/Ethical
- RE is generally legal for interoperability (DMCA 1201(f))
- Whoop ToS may prohibit it
- SpO2/HR claims could attract FDA scrutiny
- Should carry accuracy disclaimers

---

## 9. Architecture Plan

```
┌─ Web UI (React + Web Bluetooth) ─────────────────────┐
│  Real-time HR/HRV, sleep hypnogram, recovery dash,   │
│  strain gauge, SpO2/temp trends, haptics control      │
├─ Python Backend (FastAPI) ────────────────────────────┤
│  BLE client (bleak + high-freq sync)                  │
│  Full packet decoder (ported from openwhoop)          │
│  ML pipeline (neurokit2, scikit-learn, pytorch)       │
│  Recovery/Strain/Sleep/Stress scoring                 │
├─ Database (SQLite → PostgreSQL) ──────────────────────┤
│  heart_rate, sensor_data, sleep_cycles, activities,   │
│  daily_scores, rr_intervals                           │
├─ Data Sources ────────────────────────────────────────┤
│  Whoop 4.0 (BLE)          Official API (summaries)    │
│  Real-time + historical    Supplementary data          │
└───────────────────────────────────────────────────────┘
```

### Implementation Priority
1. Port 96-byte packet decoder (V12/V24) from Rust → Python
2. Set up SQLite database schema
3. Add high-freq sync to BLE client
4. Port sleep detection algorithm
5. Port health metrics (stress, strain, SpO2, skin temp)
6. Build recovery score (formula-based)
7. Web dashboard with real-time + historical views
8. Sleep stage classification (ML)
9. Activity type recognition (ML)
10. Personalized baselines and adaptive scoring

---

## 10. Device Control Capabilities

### Confirmed Working
- Trigger vibration: `RUN_HAPTICS_PATTERN` (cmd 79) or `RUN_ALARM` (cmd 68)
- Stop vibration: `STOP_HAPTICS` (cmd 122)
- Reboot device: `REBOOT_STRAP` (cmd 29)
- Read battery: `GET_BATTERY_LEVEL` (cmd 26)
- Start/stop HR streaming: `TOGGLE_REALTIME_HR` (cmd 3)
- Enable BLE HR broadcast: `TOGGLE_GENERIC_HR_PROFILE` (cmd 14)
- Download history: `SEND_HISTORICAL_DATA` (cmd 22)
- Read device info: `GET_HELLO_HARVARD` (cmd 35), `REPORT_VERSION_INFO` (cmd 7)

### Available But Untested in Python
- Set alarm time: `SET_ALARM_TIME` (cmd 66)
- Set device clock: `SET_CLOCK` (cmd 10)
- Enable IMU streaming: `TOGGLE_IMU_MODE` (cmd 106)
- Enable optical data: `ENABLE_OPTICAL_DATA` (cmd 107)
- Configure LED/optical hardware: cmds 39-44
- Erase history: `FORCE_TRIM` (cmd 25)
- Change BLE name: `SET_ADVERTISING_NAME` (cmd 140)
- Select wrist: `SELECT_WRIST` (cmd 123)

---

*This document will be updated as implementation progresses.*
