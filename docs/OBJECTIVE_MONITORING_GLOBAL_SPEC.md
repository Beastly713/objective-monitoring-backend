# Objective Physiological Monitoring — Global Specification

> **Purpose of this file**
>
> This is the stable project contract for the objective physiological monitoring branch.
> It intentionally contains only decisions that are fundamental to the system or already validated strongly enough that they should not change during normal implementation.
>
> Phase-specific implementation details belong in separate phase documents.
> Change this file only when a real blocker, hardware change, product-scope change, or strong implementation evidence requires it.

---

## 1. System Goal

Build a clinician-facing physiological monitoring adjunct for an Alcohol Use Disorder support system.

The objective branch is intended to:

- acquire multiple physiological signals from a single wearable/prototype device,
- preserve their relative timing,
- stream them to a backend in near real time,
- support synchronized live visualization,
- retain historical raw data for later review/replay,
- later support signal processing and derived physiological features.

It is **not** an autonomous diagnostic system and must not independently make clinical or emergency decisions from the physiological stream.

Target path:

```text
Physical sensors
    ↓
ESP32 acquisition
    ↓
common monotonic timebase
    ↓
per-sensor buffers
    ↓
~100 ms raw-data packets
    ↓
Wi-Fi / WebSocket
    ↓
backend ingestion
    ├── live fan-out → web/mobile clinician clients
    └── persistence → history/replay/processing
```

---

## 2. Locked Prototype Hardware

Current prototype hardware:

| Signal | Hardware |
|---|---|
| ECG / analog biopotential | AD8232 |
| EDA / GSR | ProtoCentral TinyGSR / TLA2022 |
| PPG | MAX30101 |
| IMU | MPU6050 |
| Skin/local temperature | TMP117 |
| MCU | ESP32 Dev Module |

Shared I²C:

```text
SDA = GPIO21
SCL = GPIO22
Clock = 100 kHz
```

Addresses:

```text
TMP117   0x48
TinyGSR  0x49
MAX30101 0x57
MPU6050  0x68
```

AD8232:

```text
ECG OUT = GPIO34
LO+     = GPIO25
LO-     = GPIO26
```

Interrupt pins are wired but are not part of the current acquisition design unless they later provide a concrete benefit.

Do not replace sensors or restructure the acquisition hardware without a demonstrated blocker.

---

## 3. Locked Prototype Acquisition Model

Current target acquisition rates:

```text
ECG      250 Hz
PPG      100 Hz
GSR      ~128 Hz
IMU      100 Hz
TEMP       2 Hz
```

All sample timestamps derive from:

```cpp
esp_timer_get_time()
```

The sensors do **not** need identical timestamps.

The invariant is:

> Every sample is timestamped in the same ESP32 monotonic clock domain.

This ESP32 monotonic time remains the canonical source for cross-sensor synchronization.

---

## 4. Acquisition / Networking Separation

The system must preserve this separation:

```text
ACQUISITION
    ↓
BUFFERING / PACKETIZATION
    ↓
NETWORKING
    ↓
BACKEND / STORAGE / CLIENT DELIVERY
```

Current validated ESP32 scheduling:

```text
Core 1
├── ECG task       priority 4
└── I²C task       priority 3
    ├── PPG
    ├── GSR
    ├── IMU
    └── TMP117

Core 0
└── network task   priority 1
```

Networking must never control sensor timing.

Slow or failed network/backend/client/storage work must not be allowed to block acquisition.

---

## 5. Raw Data Is the Source of Truth

Sensor ring buffers and transport packets preserve raw measurements.

Current raw sample representations:

```text
ECG:
[timestamp, adc, loPlus, loMinus]

PPG:
[timestamp, red, ir]

GSR:
[timestamp, raw]

IMU:
[timestamp, axRaw, ayRaw, azRaw, gxRaw, gyRaw, gzRaw]

TEMP:
[timestamp, raw]
```

Filtering, calibration, feature extraction, unit conversion, and physiological interpretation are downstream operations.

Derived values must not replace the stored raw source data.

---

## 6. Packetization Contract

The ESP32 builds approximately one packet every:

```text
100 ms
```

Typical packet contents:

```text
ECG   ~25 samples
PPG   ~10 samples
GSR   ~13 samples
IMU   ~10 samples
TEMP   0–1 sample
```

Transport remains JSON for the current prototype.

Schema V1:

```json
{
  "schema": 1,
  "session_id": "...",
  "seq": 123,
  "timebase": "esp_timer_us",
  "created_us": 123456,
  "t0_us": 123000,
  "t1_us": 123400,
  "truncated": 0,
  "n": [25, 10, 13, 10, 1],
  "ecg": [],
  "ppg": [],
  "gsr": [],
  "imu": [],
  "temp": []
}
```

Compact samples use `dt_us` relative to `t0_us`.

Canonical sample timestamp:

```text
sample_timestamp_us = t0_us + dt_us
```

Required packet timing invariant:

```text
t0_us <= t1_us <= created_us
```

Do not change the transport representation merely for elegance while it remains small, debuggable, and sufficient.

---

## 7. PPG Timestamp Rule

Do not reconstruct MAX30101 timestamps indefinitely using:

```text
previous_timestamp + 10000 us
```

The sensor oscillator and ESP32 timer are independent and this caused measurable drift.

The current approach anchors FIFO observations to the ESP32 clock, estimates earlier FIFO samples backwards using nominal sample spacing, enforces monotonicity, and avoids intentionally creating timestamps later than the ESP32 observation time.

This behavior is considered part of the validated acquisition baseline.

---

## 8. Live Transport Semantics

The current transport is a **live stream**, not a lossless store-and-forward recorder.

If the connection is unavailable, old sensor packets are not retained indefinitely on the ESP32 for later replay.

This means:

```text
network outage
→ possible historical gap
→ reconnect
→ continue with current live data
```

Do not claim outage-lossless recording unless local persistence/store-and-forward is explicitly added later.

---

## 9. Application ACK Semantics

The backend must continue returning:

```text
ACK:<seq>
```

for accepted sensor packets.

The ACK proves that a complete packet reached the application and was accepted by the ingestion boundary.

For the current architecture:

> ACK means authenticated/session-valid, parsed, validated, sequence-classified, and accepted into backend process memory.

ACK does **not** mean:

- database persistence completed,
- a browser/mobile client rendered the packet,
- every downstream consumer processed the packet.

This keeps ingestion responsive and prevents slow downstream work from destabilizing the ESP32 connection.

---

## 10. Identity Model

Keep four concepts distinct.

### `device_id`

Stable identity of the physical ESP32.

### `boot_id`

Changes when the ESP32 reboots.

Used to distinguish a real device reboot/sequence restart from an ordinary network reconnect.

### `session_id`

Backend-issued objective monitoring session identity.

Represents the clinician/patient monitoring session, not an ESP32 boot.

### `patient_id`

Backend-only application identity.

The ESP32 does not need patient identity or patient-identifying information.

Conceptually:

```text
patient
   ↓
monitoring session
   ↓
device
   ↓
one or more boot epochs
```

---

## 11. Backend Boundary

For the prototype, use one normal backend application rather than unnecessary distributed infrastructure.

Implemented Phase A boundary:

```text
Node.js + TypeScript backend
```

Established responsibilities:

```text
device connection/session association
packet validation
sequence/gap handling
time mapping
application ACK
accepted-packet handoff
```

Next-stage responsibilities attach downstream from the accepted-packet handoff:

```text
live fan-out
asynchronous persistence handoff
```

Web and mobile clients consume the **same backend contract**.

They never connect directly to the ESP32.

The backend may later be split only if real load, deployment, or reliability requirements justify it.

---

## 12. Time Model

Preserve two separate notions of time.

### Canonical signal time

```text
ESP32 monotonic microseconds
```

Used for synchronization and plotting relative relationships between sensor signals.

### Application/wall time

Backend receive time and a session/boot time anchor may be used to approximately associate data with real-world time.

Wall-clock mapping must not replace the ESP32 monotonic time used for signal synchronization.

If exact cross-device/wall-clock synchronization later becomes necessary, it can be added as a separate feature.

---

## 13. Gaps and Reboots Are First-Class Events

Sequence gaps are expected to be detectable.

For a forward gap:

```text
accept current packet
record gap
continue streaming
```

Do not fabricate missing samples.

A device reboot creates a new boot epoch.

Live and replay visualizations should be able to show discontinuities rather than drawing misleading continuous lines across:

- missing packets,
- disconnected periods,
- device reboots.

---

## 14. Persistence Is a Required Capability

The final objective branch is not live-view-only.

Accepted data must be storable so that previous monitoring sessions can later be:

- listed,
- reopened,
- replayed,
- processed,
- compared,
- used for future derived features.

Current storage direction:

```text
PostgreSQL
```

Store raw data primarily at the existing ~100 ms packet level rather than immediately creating a database row for every individual sensor sample.

Keep session metadata separate from raw packet data.

Derived/processed data should be stored separately from immutable raw source data.

The exact schema is phase-level implementation detail and is intentionally not globally locked yet.

---

## 15. Live Client Model

The backend should be able to fan out the same accepted stream to:

```text
web clinician dashboard
mobile clinician application
future authorized clients
```

A slow frontend must not slow device ingestion.

Live clients may discard stale display updates when necessary.

Historical completeness belongs to persistence/replay, not to an ever-growing live-client queue.

---

## 16. Visualization Direction

Visualization is an important product/demo output, but it must remain downstream from acquisition and ingestion.

Useful live views include:

```text
ECG waveform
PPG RED / IR
GSR trend
IMU / motion
skin/local temperature
stream health / sample-rate / gap status
```

Simple display/unit conversions are acceptable.

Do not label raw or lightly transformed physiological signals as clinical interpretations such as stress, intoxication, impairment, or diagnosis without a separately justified processing/decision layer.

---

## 17. Complexity Boundary

Do **not** introduce these merely because they are common in large production architectures:

```text
Kafka
Redis as a stream dependency
microservice decomposition
dedicated time-series database
binary transport
per-sample database rows
complex message brokers
ML inference
signal-feature pipelines
precision clock-sync systems
offline store-and-forward
```

Any of these may be added later if an actual requirement or blocker justifies them.

The default approach is:

> solve the current requirement with the smallest architecture that does not damage future live visualization, persistence, replay, or processing.

---

## 18. Trusted Current Baseline

Current physically validated firmware baseline:

```text
esp32_v5_3_backend_session.ino
```

Validated behavior includes:

- simultaneous five-sensor acquisition,
- independent acquisition rates,
- common ESP32 timebase,
- raw timestamped ring buffers,
- ~100 ms packetization,
- JSON serialization,
- non-blocking network queue,
- dedicated network task,
- PPG timestamp-drift correction,
- packet timestamp checks,
- WebSocket streaming,
- HELLO authentication and READY state,
- backend-issued monitoring-session control,
- connected idle operation with acquisition still draining,
- session-safe START/STOP behavior,
- application ACK watchdog,
- automatic reconnect and active-session resume across an ESP32 reboot.

The previous firmware remains the known-good acquisition/transport reference:

```text
esp32_v5_2_websocket.ino
```

The historical diagnostic receiver remains available as a transport/debug reference:

```text
objective_ws_receiver_v2.mjs
```

It demonstrates:

- WebSocket receive path,
- packet parsing/validation,
- sequence tracking,
- ACK behavior,
- controlled reconnect testing.

The Node/TypeScript backend under `src/` is now the real application ingestion endpoint. The diagnostic receiver is not a second implementation of the session protocol.

---

## 19. Phase A Completion Status

Phase A — backend ingestion — was completed and physically validated on 2026-08-16.

Validated path:

```text
physical sensors
    ↓
ESP32 V5.3
    ↓
HELLO / READY
    ↓
backend-issued START
    ↓
Schema V1 validation
    ↓
session + sequence + boot-epoch handling
    ↓
accepted-packet boundary
    ↓
ACK:<seq>
```

The completed boundary includes:

- provisioned device authentication and one active socket per device,
- backend-owned in-memory monitoring sessions,
- WAITING, LIVE, DISCONNECTED, and COMPLETED session states,
- START/STOP control and safe connected-idle operation,
- strict raw Schema V1 validation without sensor conversion,
- per-session/per-boot sequence tracking and time metadata,
- duplicate suppression and explicit forward-gap reporting,
- session resume across device/WebSocket reconnects while the backend remains alive,
- an accepted-packet handoff ready for live fan-out and persistence.

The physical validation sustained approximately 10 packets/second with healthy acquisition and ACK behavior. Durable evidence is recorded in:

```text
OBJECTIVE_MONITORING_PHASE_A_VALIDATION.md
```

Phase A deliberately keeps sessions and packets in process memory. A full backend-process restart therefore loses the active session; the device reauthenticates safely and remains idle until a new session is created. Durable recovery belongs to the persistence milestone.

---

## 20. Short Completion Path

The project should remain on a short path to a demonstrable end state.

### Milestone A — Real ingestion boundary — complete

```text
session-aware backend
device/session identity
validation
sequence/time handling
ACK
```

### Milestone B — Live + persistence — complete

```text
backend fan-out
clinician live dashboard
packet persistence
session history
```

Phase B was physically validated with the real five-sensor ESP32, PostgreSQL, and clinician browser path. See [OBJECTIVE_MONITORING_PHASE_B_VALIDATION.md](OBJECTIVE_MONITORING_PHASE_B_VALIDATION.md).

### Milestone C — Replay + minimal processing/presentation — next

```text
historical replay
useful unit conversions / signal-quality presentation
only justified processing/features
```

Do not create many artificial phases inside these milestones.

---

## 21. Change Policy

This file is intentionally conservative.

A detail should be promoted into this global specification only when it is:

1. fundamental to the architecture,
2. already validated,
3. necessary to preserve compatibility,
4. or very unlikely to change without a major blocker.

Everything else belongs in the current phase specification and may be improvised during implementation.
