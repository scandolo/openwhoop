# OpenWhoop

Open-source Whoop 4.0 client. Connects to your strap over BLE, downloads all historical data, and runs the health algorithms locally — no cloud, no subscription.

Ported from [openwhoop](https://github.com/openwhoop/openwhoop) (Rust) and [whoomp](https://github.com/jogolden/whoomp) (JS).

## FOR HUMANS — WHAT IS OPENWHOOP

### What it does

- **BLE sync**: Connects to your Whoop 4.0 over Bluetooth, downloads full sensor history (HR, RR intervals, PPG, accelerometer, SpO2, skin temperature)
- **High-frequency sync**: Uses command 96/97 for ~90x faster downloads than the normal BLE rate
- **Offline analysis**: Sleep detection, stress (Baevsky SI), strain (Edwards TRIMP), SpO2 (Beer-Lambert), skin temperature, HRV (RMSSD/SDNN/frequency-domain)
- **Local storage**: Everything goes into a SQLite database you own

### Quick start

```bash
# Install
pip install -e ".[dev]"

# Copy and edit the config
cp .env.example .env

# Scan for your device
openwhoop scan

# Download history (uses high-freq sync by default)
openwhoop download -d "WHOOP XXXXXXXXX"

# Run analysis
openwhoop detect-events          # Sleep detection
openwhoop calculate-stress       # Baevsky Stress Index
openwhoop calculate-spo2         # Blood oxygen
openwhoop calculate-skin-temp    # Skin temperature
openwhoop calculate-strain       # Edwards TRIMP strain score
```

You can also import raw binary dumps from whoomp:

```bash
openwhoop import dump.bin
```

### Requirements

- Python 3.10+
- A Whoop 4.0 strap
- Bluetooth (on macOS, uses device name instead of MAC address)

### CLI commands

| Command | What it does |
|---|---|
| `scan` | Find nearby Whoop devices |
| `download -d NAME` | Sync history from strap to SQLite |
| `info -d NAME` | Show battery, firmware version |
| `import FILE` | Import raw binary dump |
| `detect-events` | Detect sleep periods from stored data |
| `calculate-stress` | Baevsky Stress Index from RR intervals |
| `calculate-spo2` | SpO2 from red/IR sensor data |
| `calculate-skin-temp` | Average skin temperature |
| `calculate-strain` | Edwards TRIMP strain score |

---

## FOR LLMs — HOW TO WORK IN THIS CODEBASE

### Project structure

```
openwhoop/
├── protocol/          # BLE packet layer — framing, CRC, constants
│   ├── constants.py   #   GATT UUIDs, PacketType/CommandNumber/EventNumber enums
│   ├── crc.py         #   CRC-8 (poly=0x07) and CRC-32 (zlib)
│   ├── packet.py      #   WhoopPacket: parse/create/frame, factory methods for all commands
│   ├── assembler.py   #   Multi-notification packet reassembly
│   └── decoder.py     #   Decode V12/V24 (96-byte full sensor) and generic (HR+RR) packets
├── ble/               # Async BLE communication (bleak)
│   ├── scanner.py     #   Device discovery (scan_for_whoop, find_device_by_name)
│   ├── client.py      #   WhoopClient: connect, send commands, sync_history loop
│   └── handlers.py    #   NotificationRouter: routes BLE notifications to typed queues
├── algos/             # Health algorithms (all pure functions, no I/O)
│   ├── activity.py    #   Gravity-based sleep/active/rest classification (rolling 15min window)
│   ├── sleep.py       #   Sleep cycle detection + merging + scoring
│   ├── sleep_consistency.py
│   ├── hrv.py         #   RMSSD, SDNN, frequency-domain LF/HF
│   ├── stress.py      #   Baevsky Stress Index (histogram-based)
│   ├── strain.py      #   Edwards TRIMP (5-zone time-in-zone)
│   ├── spo2.py        #   Beer-Lambert SpO2 from red/IR ratio
│   └── temperature.py #   Skin temp conversion (raw × 0.04)
├── db/                # SQLite persistence (SQLAlchemy ORM)
│   ├── schema.py      #   Tables: heart_rate, sleep_cycles, activities, daily_scores, packets
│   └── database.py    #   DatabaseHandler: upsert_readings, queries
├── models.py          # Core dataclasses: HistoryReading, SensorData, SleepCycle, ImuPacket
├── config.py          # Loads .env (WHOOP_DEVICE_NAME, DATABASE_URL)
└── cli.py             # Click CLI entry point — all commands defined here
tests/
├── test_packet.py     # Packet framing, parse/serialize roundtrip
├── test_crc.py        # CRC-8 and CRC-32 validation
├── test_decoder.py    # V12/V24 and generic packet decoding
├── test_algorithms.py # Sleep detection, HRV, stress, strain, SpO2
└── test_db.py         # Database insert/query
```

### Key architectural decisions

- **Packet flow**: Raw BLE bytes → `assembler.py` reassembles multi-notification packets → `packet.py` validates CRC and parses → `decoder.py` extracts sensor data → `models.py` dataclasses
- **V12/V24 packets** are the important ones: `seq=12` or `seq=24`, payload >= 77 bytes. These carry full sensor data (PPG, gravity, SpO2, skin temp, etc.) at documented byte offsets in `decoder.py`
- **Generic packets** only have HR + RR intervals (from older firmware or non-sensor commands)
- **Algorithms are pure functions** in `algos/` — they take lists of readings and return results. No database or BLE dependencies. Easy to test and extend.
- **History sync** works in batches: strap sends HISTORY_START → data packets → HISTORY_END (with trim pointer) → client ACKs → repeat until HISTORY_COMPLETE

### Protocol details (you will need these)

- Packet frame: `SOF(0xAA) + u16LE length + CRC-8(length bytes) + payload + CRC-32(payload)`
- CRC-8: polynomial 0x07, init 0x00, over the 2 length bytes only
- CRC-32: standard zlib `crc32()` over the payload
- All multi-byte values are little-endian except IMU samples (big-endian i16)
- 68 commands and 49 events are defined in `constants.py`
- High-freq sync (cmd 96/97) changes the BLE connection interval for ~90x faster data transfer

### How to run tests

```bash
pip install -e ".[dev]"
pytest
```

### Common tasks and where to edit

| Task | Files to touch |
|---|---|
| Add a new BLE command | `protocol/packet.py` (factory method) + `protocol/constants.py` (if new cmd ID) + `ble/client.py` (high-level method) |
| Add a new algorithm | `algos/new_algo.py` + `cli.py` (new Click command) + `tests/test_algorithms.py` |
| Change DB schema | `db/schema.py` (ORM model) + `db/database.py` (queries) |
| Decode a new packet type | `protocol/decoder.py` + `protocol/constants.py` (PacketType) |
| Add a new sensor field | `models.py` (SensorData) + `protocol/decoder.py` (byte offset) + `db/schema.py` (column) |

### Dependencies

- `bleak` — async BLE communication
- `numpy` / `scipy` — signal processing in algorithms
- `sqlalchemy` — SQLite ORM
- `click` — CLI framework
- `python-dotenv` — .env config loading
