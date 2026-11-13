# WHOOP BLE protocol

Research notes behind `src/protocol/`, compiled 2026-11-13 from upstream reverse-engineering projects (sources in §0). Where sources disagree the text says so. Section 9 lists the bugs this rebuild fixed in the original Python client.


**Offsets.** `d[]` = bytes after `[type][seq][cmd]`. inner = `d` + 3; gen4 frame offset = `d` + 7.
**Tags.** ✓ = captured bytes or hardware-verified in the source. `~` = one source only. `?` = my inference.

## 0. Sources

`bWanShiTong/openwhoop` and `jogolden/whoomp` now return **404** (repos removed). Both are cited through mirrors pinned at their last upstream commit.

| Key | Source |
|---|---|
| RS | Rust upstream, mirror https://github.com/mumer92/openwhoop/tree/55c5c1e2e02d3822c33e258838a57bb7d9e2ca53 (2026-05-18): `src/openwhoop-codec/src/*.rs`, `src/openwhoop/src/{device,openwhoop}.rs`, `sync/gen5.rs` |
| WM | whoomp copy https://github.com/k0n5n/whoomp/tree/8b1d607e8b909c07174396f63c55e66236ef443d: `whoomp.js`, `packet.js`, `scripts/*.py` |
| RE | https://github.com/bWanShiTong/reverse-engineering-whoop-post/blob/305e35d9c4a57b0241ab1ccb2894a8ed3304d5aa/README.md (official-app captures) |
| OS | https://github.com/OpenStrap/protocol/tree/fbadb5bd055965d9400e266d6cf42748992ba950 (2026-11-13; 4.0/5/MG; 2,934-case real-capture corpus): `lib/src/{framing,commands,control,constants,records}.dart` |
| NP | https://github.com/ParthJadhav/noop/tree/63f3ed06cc2ff1c3d1e2d0e6828bcfe7387ae521: `docs/BLE_REVERSE_ENGINEERING.md`, `docs/PROTOCOL.md`, `tools/linux-capture/whoop_frame.py` |
| WR | `tanarchytan/whoop-rs` @ `69eebfc`: `crates/whoop-protocol/src/haptic.rs` |
| VO | `Vatsa10/OpenWhoop` @ `6608da4`: `web/js/ble/client.js` (Web Bluetooth) |

## 1. Framing (gen4)

| Byte | Field |
|---|---|
| 0 | SOF `0xAA` |
| 1–2 | `L` u16 LE = padded inner + 4; total frame = `L + 4` |
| 3 | CRC-8 of bytes 1–2: poly 0x07, init 0, no reflection, xorout 0 (old table verified identical) |
| 4… | inner `[type][seq][cmd][d…]`, **zero-padded to a multiple of 4** [OS `buildFrame`, NP `_pad4`] |
| end | CRC-32 LE of the padded inner, standard zlib ✓ |

- All 30 frames I verified, in both directions, have an inner length that is a multiple of 4.
- The odd CRC parameters in RE come from running the CRC over the header bytes too.
- `seq` rolls on the host side, and the strap echoes it in `d[0]` of the response. On type 47, `seq` is the record version.
- **Reassembly:** keep one buffer per characteristic and split by length. Check CRC-8 before trusting `L`, cap `L` at 4096, and on a CRC-32 failure resync to the next `0xAA` after index 0. Payloads can contain `0xAA` [OS `FrameReassembler`].
- **COMMAND_RESPONSE (36):** `d[0]` echoed seq, `d[1]` status (0 fail, 1 ok, 2 pending — the real reply follows, 3 unsupported), body from `d[2]`. `body[0]` is usually a revision byte [RS, OS].

**Constants vs `constants.py`.** UUIDs, packet types, metadata 1/2/3 and every command number all match.

New:
- Packet types 37/38 PUFFIN_COMMAND/RESPONSE, 53–56 puffin events, battery-pack logs and metadata [RS `constants.rs`].
- Commands [OS]:
  - 15 FORGET_BONDS (dangerous)
  - 48 SEND_EVENT_PACKETS
  - 61/62 SET/GET_AFE_PARAMS
  - 103 DISABLE_BLE_UART
  - 138 SET_SIGNAL_CONFIG
  - 148 WEAR_DETECT_OVERRIDE
  - 149 SET_LED_ACCESSIBILITY
  - 150/152 GYRO_ENABLE/STATUS
  - 151 GET_BATTERY_PACK_INFO
  - 153/154 persistent optical/IMU save (dangerous)
- 115–118, 121 and 128 are read-only config/flag-key reads.
- Disputed: 146/147 as the gen5 clock commands (NP says yes, OS says no).
- Destructive: 25 FORCE_TRIM (`fe×8 00` = erase all ✓ RE), 29, 32, 33, 36–38, 45, 99, 142–144.

## 2. Web Bluetooth

- **requestDevice:**
  - WM uses `{filters:[{services:[WHOOP_SERVICE]}], optionalServices:[WHOOP_SERVICE]}`. Commit `8b1d607` switched it from `namePrefix:"WHOOP"`, so the 4.0 advertises the service UUID.
  - VO also adds case-sensitive `namePrefix` entries (`WHOOP`/`Whoop`/`whoop`) and falls back to `acceptAllDevices` (Bluefy/iOS).
  - Add `heart_rate` and `battery_service` to `optionalServices`, or calling `getPrimaryService` on them throws SecurityError.
- **Characteristics:** `…0002` write. `…0003` notify (responses). `…0004` notify (events). `…0005` notify (realtime, history, metadata, logs). `…0007` memfault (ignore).
- **Writes:**
  - WM and VO call the deprecated `writeValue()`, which lets the browser choose the write type. RS writes WithoutResponse.
  - NP: the notify channels stay silent until the link is bonded, and **one with-response write (`26 [00]`) triggers just-works bonding**.
  - NP and OS send history acks as confirmed writes.
  - Recommendation (`?`): use `writeValueWithResponse` for every write.
- **Notifications:** WM does **not** reassemble fragments. Copy each value using `byteOffset`/`byteLength` (WM reads `value.buffer` directly).
- **MTU:** Web Bluetooth has no API for it.
  - A 104-byte V24 frame takes 6 notifications at MTU 23 and 1 at MTU 247. IMU frames (1928 B) always fragment.
  - The offload is firmware-paced at about 10 records/s whatever the MTU or connection interval [NP].
- **One central at a time:** turn the phone's Bluetooth off.
- **Standard services:**
  - 0x2A37 HR+RR at 1 Hz works unbonded, but only while the generic HR profile (cmd 14) is on [NP, VO].
  - 0x2A19 returns battery % as a u8 [RS `device.rs`].

## 3. History sync

1. Subscribe to 0003/0004/0005.
2. Write `26 [00]` with response.
3. Send `35 [00]`.
4. **SET_CLOCK 10**: `[u32 unix][u16 subsec in 1/32768 s][00 00 00]` (9 B). NP: fw 41.17.6.0 latches only at this length. Confirm with `GET_CLOCK 11`.
   - With the RTC lost, the strap withholds type-47 data or stamps records 1971 [OS, NP].
5. Optional: `EXIT_HIGH_FREQ_SYNC 97 []` [NP].
6. `SEND_HISTORICAL_DATA 22 [00]` ✓.
7. Handle START → records → END: persist the records, then **ack `23 [01] + END d[10:18]` verbatim**. Repeat until COMPLETE; never ack COMPLETE.

| Meta | `d` layout |
|---|---|
| START 1 | [0:4] unix, [4:6] subsec, [6:18] 3×u32, [18:34] 4×u32 (`?` firmware version, 41.16.x.0), [34:37] `08 02 00` |
| END 2 | [0:4] strap unix, [4:6] subsec, [6:10] u32 (OS: expected packet count), **[10:14] trim page, [14:18] wrap count**, [18:21] 0 |
| COMPLETE 3 | [0:4] unix, [4:6] subsec, then 3 zero bytes (9 B total) [WM]. RS's 18-byte parse drops it |

- **Ack payload:** WM, the old Python and the RE template send trim + `00000000`; RS, OS and NP echo all 8 bytes. The captured END markers have wrap = 4, 10 and 16, so **echo the bytes as received**.
- Failure ack: `[00]` (gen4) or `[00 00]` (gen5). ABORT_HISTORICAL_TRANSMITS: `20 []`.
- **Without an ack**, the strap re-sends the same batch forever and the trim cursor freezes, but the data stays on flash [NP hardware-verified (gen5), OS].
  - Ack only after the records are stored durably.
  - Never ack a batch in which any frame failed CRC.
- **High-frequency sync:**
  - ENTER 96 = `[02][u16 interval s][u16 duration s]`, e.g. `02 b4 00 20 1c`. Gen5 rejects interval ≤ 60 or duration ≥ 28,800 [OS].
  - EXIT 97 has an empty body.
  - `?` This sets a periodic background-sync window; it does not speed up the download.
- **GET_DATA_RANGE `34 [00]`** response:
  - `d[2]` = revision 1.
  - u32s at `d[3, 7, …, 31]`: RawOld, Read, Write, Trim pages, WrapCount, TotalPages, Used, Free.
  - (sec, subsec) pairs: oldest [35/39], trim [43/47], read [51/55], newest [59/63] [OS].

## 4. Historical records (type 47)

**Version map:**
- Gen4: v5/7/9 HR only; v12 and v24 the same DSP layout; v10 IMU (`d` ≥ 1188); v25 a 24 Hz PPG burst with no HR.
- Gen5: v18 1 Hz; v16/17 MG ECG; v20/21/22/26 deep buffers.

**V12/V24 layout:**

| `d` | Type | Field |
|---|---|---|
| 0 | u32 | counter ✓ |
| 4 | u32 | unix ✓ |
| 8 | u16 | subsec |
| 10–13 | | "flags" / "sensor_m,n" (unknown) |
| 14 | u8 | HR (0 = off wrist) ✓ |
| 15 | u8 | RR count 0–4 ✓ (reject > 4) |
| 16 | 4×u16 | RR ms ✓ (keep 200–2500) |
| 26 | u16 | PPG green |
| 28 | u16 | ✗ not a field; it straddles the f32 at 29 [OS] |
| 33 | 3×f32 | gravity (g) ✓, \|g\| averages 1.046 |
| 45 | f32 | unknown, integer-valued. **`d[48]` ("skin_contact") is this float's exponent byte.** My vectors: 0/51/17665 ↔ 0/66/70 |
| 49 | 3×f32 | duplicate of gravity |
| 61/63 | u16 | "spo2 red/IR": they move in lockstep, so no ratio-based SpO2 [OS] |
| 65 | u16 | "skin_temp_raw", **disputed**. OS: not a temperature (moves 5–10 counts/s). NP provisional: °C = 33 + (raw−826)×0.05 |
| 67 | u16 | ambient light |
| 69/71 | u16 | "led_drive"; `d[69]` is a slow temperature candidate [OS] |
| 73/75 | u16 | "resp_rate"/"quality" = **3073/3074 (`01 0c 02 0c`) in every capture** ✗ |

- Minimum `d` length is 86; some firmware sends 85 [OS].
- HR offset in other versions: v7 `d[24]`; v9 `d[14]`; gen5 v18 `d[11]`; v25 has no HR [OS].
- Gen5 v18 [RS]: [22] RR control (low nibble = count), [23:25] RR, [30:42] gravity, **[48] SpO2 % (u8)**.
- **IMU** (type 47, `d` ≥ 1188) [RS]: [14] HR, [15] RR count. 100 samples per axis, **i16 big-endian**:
  - acc X/Y/Z at 85/285/485, ÷1875 → g
  - gyro X/Y/Z at 688/888/1088, ÷15 → °/s
- **Conversions:** none are validated for 4.0 skin temp, SpO2 or respiration. On 5/MG, skin temp = raw/100 °C [NP].

## 5. Realtime, events, battery, clock, hello

**REALTIME_DATA (40)** ✓:
- `cmd` holds unix byte 0, and `d[0:3]` unix bytes 1–3.
- [3:5] subsec, [5] HR, [6] RR count, [7:15] 4×u16 RR, [15] wearing (1 = on).
- Toggle with `3 [01]/[00]` ✓. The standard HR profile is `14 [01]/[00]` ✓; it persists, and events 24/25 confirm it.

**Event envelope** [OS, ✓ by my vectors]:
- **id = u16 `cmd | d[0]<<8`**.
- [1:5] unix, [5:7] subsec, [7:9] body length, body = `d[9:]`.

| Id | Event |
|---|---|
| 3 | BATTERY_LEVEL: [0] rev 2, [1:5] SoC×10, [5:9] mV, charging flag at [9] (OS) or [10] (NP) |
| 7/8 | charging |
| 9/10 | wrist on/off |
| 13 | RTC_LOST |
| 14 | DOUBLE_TAP (no body) |
| 16 | SET_RTC |
| 21/22 | battery pack |
| 24/25 | HR profile |
| 33/34 | realtime HR on/off ✓ |
| 56–60 | alarm set / fired / app-fired / disabled / haptics fired |
| 100 | haptics ended: [1] 0 expired, 1 error, 2 double-tap |
| 109 | battery pack info |

- ~ OS gives TEMPERATURE_LEVEL = **111** (constants.py: 17) and BLE_BONDED = **31** (constants.py: 23).
- Ids 40–42 and 46–47 are never emitted.
- Alarm events often arrive in the next history sync rather than live.

**Commands:**
- Battery: `26 [00]` → `d[2:4]` ÷ 10 % [WM]. Gen5 returns a u8 % at `d[2]`.
- Clock: `11 [00]` → `d[2:6]` unix, `d[6:10]` subsec.
- Hello `35 [00]`: `d[2]` = 4; [3:7] battery×10; [8:12] strap unix; [16..] NUL-terminated serial, then a 64-char hex firmware commit.
  - WM reads charging at `d[7]` and on-wrist at `d[116]`. This depends on firmware (always 0 in OS's captures), so prefer the events.
- Version `7 [00]`: harvard = 4×u32 at `d[3:19]`, boylston = 4×u32 at `d[19:35]` ✓.

## 6. Haptics and alarms (gen4)

| Cmd | Payload | Notes |
|---|---|---|
| 79 RUN_HAPTICS_PATTERN | `[id][numLoops][0][0][0]` | Presets 0–6 (command 80 enumerates them; reply format unknown). The official app fires **id 2**, the graduated alarm buzz [NP, WR]. OS sends `[2,0,0,0,0]`; WM sends `[00]` |
| 122 STOP_HAPTICS | `[00]` | |
| 68 RUN_ALARM | `[01]` (OS, NP) | WM/RS send `[00]`. Triggers event 58 |
| 66 SET_ALARM_TIME | `[01][u32 unix][u16 subsec][u16 mode=0]` ✓ official app | Fires on fw 41.17.4 (events 60, 57, 59). The rich form `[04][slot][u32][u16][8×effect][u16 loop][u8 overallLoop][u8 dur s]` latches but did **not** fire on 41.17.4 |
| 67 GET_ALARM_TIME | `[01]` | Reply `d[2]` = rev. Rev 4: [3] active, [4:8] unix (RS and OS agree). Rev 1: [3:7] unix (OS) |
| 69 DISABLE_ALARM | `[01]` ✓ official app | Clears all alarms. Rev 2: `[02][FF\|slot]` |

The SET/RUN reply carries a status at `d[3]`: 1 valid, 2 bad waveform, 3 bad loop, 4 bad duration, 5 played [OS].

**Short vs long buzz:**
- On 4.0, set `numLoops` (0 or 1 = one cycle) and cut the buzz short with 122. Nobody has documented which preset is the shortest, so probe 0–6.
- On 5/MG, use opcode 19 `[01][47,152,0×6][00 00][overallLoop]`: 0 gives one short pulse, up to 7 adds repeats [WR].

## 7. WHOOP 5.0 / MG

Supported by:
- RS since `e53284c` (2026-03-08, PR #23)
- OS (including MG ECG)
- NP
- both whoop-rs projects

It uses the same opcodes and inner layout as 4.0. Differences:
- **GATT:** service `fd4b0001-cce1-4033-93ce-002d5875f58a`; characteristics `fd4b0002/3/4/5/7`.
- **Header (8 B):** `[AA][01][u16 L][00 01 out | 01 00 in][CRC-16/MODBUS (0xA001, init FFFF) over bytes 0–5, LE]`. Padding to 4 is **mandatory**.
- **Bonding:** the link must be **encrypted and bonded** before subscribing. Write CLIENT_HELLO with response: `aa0108000001e67123019101363e5c8d`.
- **Commands:**
  - 22 and 34 take empty bodies.
  - Haptics use opcode 19; 79 returns status 3.
  - Alarms use the rev-4 21-byte body (trailing `00`), slots 1–6.
- **Data:** battery is a direct %; records come as v18 and later.

## 8. Test vectors (all CRC-verified by my own decoder)

1. `aa0800a823461600699b4cfb`
   → SEND_HISTORICAL_DATA (official app), seq 0x46, `d=00`.
2. `aa100057236d4201d036656600000000f62deb81`
   → SET_ALARM_TIME (official app): `01`, unix 1717909200, subsec 0, mode 0.
3. `aa1800ff2802ad896566f0654201670600000000000001013ba00d4d`
   → REALTIME: unix 1717930413, subsec 26096, HR 66, RR [1639], wearing 1.
4. `aa100057307e0900c2e96e67685d0000a2a61c12`
   → WRIST_ON (9), unix 1735322050, body length 0.
5. `aa2400fa30b003002e316966901f140002e9000000e90e000001010f0301002f01000000699d4a60`
   → BATTERY_LEVEL: unix 1718169902, 23.3 %, 3817 mV, charging.
6. `aa1c00ab311002a9fc8367205337000000257e00000a0000000000007ac020f8`
   → HISTORY_END: unix 1736703145, trim 32293, wrap 10. Ack (seq 0): `aa10005723001701257e00000a00000095660fa4`.
7. `aa50000c2477070a01012900000011000000020000000000000011000000020000000200000000000000030000000400000000000000000000000300000006000000000000000000000008050100000074b95569`
   → VERSION reply: echoed seq 10, ok, harvard 41.17.2.0, boylston 17.2.2.0.
8. `aa8c004a2419230a0104ba02000000eedf6e67a0680000344331383635323239006233636265376430373232323366393138666261623236666536643061393962666236643932656634393436663231653930623031340600000002000000100000002900000010000000060000000000000008020100000000000011000000020000000200000000000000c3425a4e`
   → HELLO reply: battery 69.8 %, unix 1735319534, serial `4C1865229`.
9. `aa6400a12f1805cb6cc100f7715c67300b805454015700000000000000000000005161cda013a03dcdcc1cbbd723133ee146873f00028a46cdcc1cbbd723133ee146873f28026d029c03700257019004010c020c3000000000000001b9120000000000000a9c4cac`
   → V24: unix 1734111735, HR 87, RR [], green 24913, gravity [−0.0024, 0.1437, 1.0569], red 552, IR 621, u16@65 = 924, ambient 624, `d[48]` = 70.
10. `aa5c00f02f0c053f940900da106966280080545401360195040000000000000000a34cff0050bf3b144efb3da4a4463f299c0dbf00004c42144efb3da4a4463f299c0dbff40155023b03530255016004010c020c2000000000000002e8c17c8d`
    → V12: unix 1718161626, HR 54, RR [1173], gravity [0.1227, 0.7759, −0.5532], red 500, IR 597, u16@65 = 827.

For IMU, use RS `whoop_data.rs` test `parse_historical_packet` (a 1928 B frame): HR 62, RR [837], sample 0 acc (−2.184, 0.4155, 0.5099) g, gyro (35.73, −14.87, 0.533) °/s.

## 9. Bugs and discrepancies in the old Python (`90270e0`)

1. No 4-byte padding. `set_clock` sends a 4-byte body (inner 7), which upstream reports is ACKed but **not latched**.
2. `history_ack` sends trim + zeros instead of echoing `d[10:18]`, and doesn't request a confirmed write.
3. The sync never sets or verifies the clock.
4. `is_imu_packet` requires type 52, but IMU arrives as **type 47 v10**, so the samples are lost.
5. V12/V24 field labels are wrong:
   - `skin_contact` is a float's exponent byte.
   - `ppg_red_ir` is noise.
   - resp/quality are constant.
   - skin temp is disputed.
   - The minimum of 77 is too low (real minimum is 85).
6. `decode_generic` reads HR at `d[14]` for every version, so v7, v18 and v25 give garbage, and the RR count is never checked.
7. Events:
   - The event id is read as u8 when it's u16.
   - Event bodies aren't parsed.
   - Ids 17 and 23 are disputed.
8. Assembler:
   - It doesn't check CRC-8 before waiting for `L+4` bytes, so a spurious `0xAA` can stall it for up to 64 KB.
   - There's no length cap.
   - It recurses.
9. Sync loop:
   - `_send_recv` takes any reply without matching cmd/seq.
   - `MetadataType()` raises on unknown values.
   - There's no abort or failure-ack on error.
   - EXIT_HIGH_FREQ_SYNC is skipped when an exception occurs.
10. `enter_high_freq_sync` sends `[00]`, and the "~90× faster" claim has no source (offload is ~10 records/s).
11. Every command uses a fixed `seq = 10`.
12. The scanner filters by name, which can be renamed; filter by the service UUID instead.
