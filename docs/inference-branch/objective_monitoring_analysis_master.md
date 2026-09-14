# Objective Monitoring Backend — Master Physiological Analysis Implementation Specification

**Target repository:** `Beastly713/objective-monitoring-backend`  
**Target branch:** `main`  
**Master specification date:** 2026-09-14

## Document authority and merge policy

This document consolidates the two attached specifications:

- `objective_monitoring_analysis_implementation_research.md` — baseline architecture, repository analysis, sensor/conversion rationale, feature definitions, transport/storage design, UI language, validation considerations, performance analysis, uncertainties, and implementation planning.
- `objective_monitoring_analysis_implementation_completion_spec.md` — final V1 resolutions for every ambiguity left by the baseline report.

Where the two documents overlap, the completion specification is authoritative for the final V1 behavior. Earlier “recommended” or “suggested” wording is retained only where it contains implementation rationale or information not replaced by a later exact decision. Duplicated summaries are intentionally omitted.

## Scope and safety boundary

This is an experimental engineering specification for a prototype physiological monitoring backend. It is not a clinically validated medical device and does not specify diagnosis, treatment, medication advice, withdrawal management, impairment classification, relapse classification, or autonomous clinical decision-making.

The analysis subsystem produces observable measurements, derived features, deterministic rule observations, and explicit data-quality/evidence states. No physiological pattern is treated as proof of craving, relapse, withdrawal, intoxication, stress, anxiety, impairment, or another clinical condition.

Prototype thresholds are engineering guardrails, not clinical cutoffs. Numeric confidence/probability is intentionally not part of V1.

## Master pipeline

```text
ESP32 raw sensor packet
        ↓
existing validation / session / sequence / time mapping
        ↓
AcceptedPacketBus
        ↓
serialized bounded analysis queue
        ↓
raw sample expansion using canonical ESP timestamps
        ↓
per-(session_id, epoch_id) rolling state
        ↓
10 s feature windows emitted every 1 s
        ↓
modality quality
        ↓
physiological feature extraction
        ↓
60 s within-epoch baseline
        ↓
per-modality deterministic rules
        ↓
multimodal deterministic precedence/rules
        ↓
typed AnalysisResult
        ├── live fan-out on existing objective WebSocket
        └── asynchronous PostgreSQL persistence
                     ↓
          bounded historical analysis retrieval
                     ↓
             existing LIVE / REVIEW UI
```

# 1. System scope, architecture, and repository boundary


The correct implementation is a **deterministic, downstream analysis subsystem attached to the existing `AcceptedPacketBus`**:

```text
ESP32 raw sensor packet
        ↓
existing validation / session / sequence / time mapping
        ↓
AcceptedPacketBus
        ↓
non-blocking analysis handoff
        ↓
raw sample expansion using existing ESP timestamps
        ↓
per-session/per-epoch rolling sample buffers
        ↓
10 s analysis windows, emitted every 1 s
        ↓
minimum signal-quality evaluation
        ↓
physiological feature extraction
        ↓
60 s within-epoch session baseline
        ↓
per-modality deterministic observations/rules
        ↓
multimodal deterministic pattern rules
        ↓
AnalysisResult
        ├── analysis-result live fan-out
        └── asynchronous PostgreSQL persistence
        ↓
existing clinician live WebSocket
        +
new bounded historical analysis endpoint
        ↓
existing LIVE / REVIEW dashboard
```

The existing repository is already structured for this approach. `AcceptedPacketBus` publishes accepted packets to independent synchronous subscribers and catches subscriber exceptions, while packet persistence and live fan-out are already downstream of that boundary. The device gateway publishes an accepted packet and then sends `ACK:<seq>`. Therefore, analysis must be **scheduled asynchronously from the bus subscriber** so that feature extraction never becomes part of the ACK-critical synchronous work. [1][2][3][4]

The analysis subsystem should **not**:

- change the device packet schema;
- change packet validation;
- change sequence semantics;
- change the ESP32 timestamp model;
- modify raw packet persistence;
- introduce ML;
- introduce a scenario generator;
- create a synthetic-data engine;
- introduce Kafka, Redis, workers, microservices, a feature store, or a time-series database;
- replace the rule engine with a model;
- turn IMU motion into a clinical conclusion;
- expose SpO2 from RED/IR counts;
- expose absolute ECG millivolts without additional hardware/ADC calibration information;
- expose absolute legacy-TinyGSR conductance in µS without board-specific calibration.

The first implementation should deliberately treat the following as the **source of truth**:

```text
Raw ECG ADC code + LO+/LO-
Raw MAX30101 RED/IR FIFO counts
Raw TinyGSR/TLA2022 ADC code
Raw MPU6050 axis codes
Raw TMP117 temperature register code
ESP32 monotonic sample timestamps
```

Derived values remain secondary and traceable to these values. The repository already explicitly preserves raw packets as the durable source for replay/processing. [5]

### Recommended first-version analysis decisions

| Decision | Recommendation |
|---|---|
| Analysis window | 10 s trailing window |
| Analysis step | 1 s |
| Baseline | first 60 s of valid data, per continuous `epoch_id` |
| Baseline representation | feature median + MAD for robust relative change |
| Cross-epoch baseline | reset; do not silently carry a baseline across `epoch_id` |
| ECG | deterministic derivative-energy beat detector; no clinical ECG stack |
| PPG | IR local-peak pulse detector; motion context from IMU |
| GSR | raw/proxy feature analysis; no absolute µS conversion on legacy board |
| IMU | exact hardware scaling; gravity-aware movement index |
| temperature | exact TMP117 °C conversion; slow trend only |
| Quality | categorical `good / usable / limited / unavailable` |
| Modality output | observable physiological change statements |
| Multimodal output | deterministic pattern observations + evidence tier |
| Numeric confidence | **do not use** |
| Persistence | one derived analysis row per emitted window |
| Live transport | existing `/ws/objective/live/:sessionId`, new `type: analysis_update` messages |
| Historical transport | bounded HTTP analysis-window endpoint |
| ML | none |

---


## 1.1 Existing backend architecture and exact analysis insertion point

## 2.1 Current repository boundary

The current backend is a Node.js + TypeScript process using `pg`, `ws`, and uPlot. The package requires Node >=20 and already contains a single-process HTTP/WebSocket server, PostgreSQL persistence, live fan-out, historical replay, and the clinician dashboard. [6]

The existing startup wiring in `src/index.ts` creates:

```text
ObjectiveSessionRepository
ObjectiveHistoryRepository
AcceptedPacketBus
ObjectivePacketStore
LiveGateway
DeviceGateway
HTTP server
Objective WebSocket router
```

and passes the same `AcceptedPacketBus` to packet persistence, live fan-out, and device ingestion. [3][7]

The correct extension is therefore:

```text
AcceptedPacketBus
    ├── ObjectivePacketStore
    ├── LiveGateway
    └── ObjectiveAnalysisPipeline
            ↓
       AnalysisResultBus
         ├── AnalysisResultStore
         └── LiveGateway
```

`AnalysisResultBus` is justified because analysis results have two independent downstream consumers and must have the same isolation property that the existing accepted-packet bus already provides.

## 2.2 Exact insertion point

The exact insertion point is the existing `AcceptedPacketBus.publish(...)` handoff in `deviceGateway.ts`. The device gateway currently does this in order:

```text
validate packet
→ require live session
→ classify sequence
→ map time
→ publish AcceptedObjectivePacket
→ increment accepted counter
→ ACK:<seq>
```

The analysis pipeline should subscribe to the bus, but the subscriber should only enqueue work into the one serialized analysis queue:

```ts
acceptedPacketBus.subscribe((packet) => {
  if (!analysisQueue.enqueue(packet)) {
    analysisMetrics.queueDrops += 1;
    markAnalysisDegraded();
  }
});
```

The queue's single worker is scheduled asynchronously with `setImmediate()`; the subscriber does not create one callback per packet. The worker calls `analysisPipeline.process()` and catches its own exceptions, converting failures into internal analysis-health state/logging. It must never throw into the event loop.

This preserves the existing property that downstream processing cannot reject the packet or break the ACK path. [2][3]

## 2.3 Why not put analysis in `deviceGateway.ts`

Do not add:

```text
feature extraction
windowing
rules
baseline state
analysis persistence
```

to `deviceGateway.ts`.

That file is currently a protocol/ingestion component. Keeping it unchanged makes the new analysis layer a downstream consumer instead of a transport concern.

## 2.4 Why not put analysis in `packetStore.ts`

`packetStore.ts` is intentionally a bounded asynchronous **write-side raw packet store**. It queues accepted packets, retries PostgreSQL failures, marks storage degradation, and writes immutable raw packet JSONB rows. It should remain focused on that responsibility. [5]

Derived analysis must have its own storage path because:

- analysis has a different update frequency (1 Hz rather than 10 packets/s);
- analysis is versioned;
- analysis failures must not affect raw packet persistence;
- analysis results are derived and replaceable by version, while raw packets are immutable.

## 2.5 Why not create a new live WebSocket endpoint

The existing WebSocket router already owns `/ws/objective/live/:sessionId`, and the current live gateway broadcasts accepted packets to session-scoped browser clients. [8]

The simplest first implementation is to extend that same live channel with a second message type:

```text
packet
analysis_update
```

This avoids a second browser socket, a second reconnect lifecycle, and another session subscription mechanism.

The frontend already maintains one session-scoped live socket and already handles event messages; analysis should be another event type on that same channel. [9]

## 2.6 Existing historical replay should be extended, not replaced

The repository already has:

```text
ObjectiveHistoryRepository
GET /api/objective/sessions/:sessionId/replay
GET /api/objective/sessions/:sessionId/replay/packets
```

The historical repository already reconstructs replay time from the existing `backend_anchor_ms + plot_t0_ms` values, detects transport/ingestion gaps, detects stored-history gaps, distinguishes physical device reboot from same-boot time epochs, and returns bounded raw packet windows. [10]

Therefore, analysis persistence must **sit beside that existing raw replay model**.

Do not build a second replay engine.

The historical analysis path should be:

```text
stored raw packets       stored analysis results
        ↓                         ↓
existing replay repository   analysis repository
        ↓                         ↓
         existing REVIEW timeline
```

The browser remains the single consumer of both.

---


## 1.2 Repository facts that constrain implementation

## 3.1 Packet schema

The current Schema V1 sample shapes are:

```ts
export type EcgSample = [dtUs: number, adc: number, loPlus: 0 | 1, loMinus: 0 | 1];
export type PpgSample = [dtUs: number, red: number, ir: number];
export type GsrSample = [dtUs: number, raw: number];
export type ImuSample = [
  dtUs: number,
  ax: number,
  ay: number,
  az: number,
  gx: number,
  gy: number,
  gz: number,
];
export type TempSample = [dtUs: number, raw: number];
```

The packet uses:

```text
timebase = esp_timer_us
t0_us <= t1_us <= created_us
packet span <= 150 ms
```

with firmware packet maxima:

```text
ECG   64
PPG   32
GSR   32
IMU   32
TEMP   4
```

These are enforced by the existing validator and must remain unchanged. [1]

## 3.2 Existing firmware rates

The current firmware `esp32_v5_3_backend_session.ino` defines:

```text
ECG      250 Hz     (4,000 us/sample)
PPG      100 Hz     (10,000 us/sample)
GSR      ~128 Hz    (7,813 us/sample)
IMU      100 Hz     (10,000 us/sample)
TEMP       2 Hz     (500,000 us/sample)
```

Packets are built approximately every 100 ms. [11]

The total nominal sensor sample throughput is therefore approximately:

```text
250 + 100 + 128 + 100 + 2 = 580 samples/s
```

The sensor channels do not need a common sampling interval. They only need a common timestamp domain, which they already have via `esp_timer_get_time()`. [11]

## 3.3 Current PPG timestamp policy

The firmware intentionally does not assign PPG timestamps as an unlimited `previous + 10,000 us` counter. The FIFO is timestamped relative to ESP32 observation time and corrected for monotonicity/future timestamps. This is an existing acquisition invariant and must be preserved in the backend analysis layer. [11]

Backend code therefore uses:

```text
sample_esp_us = packet.raw_packet.t0_us + sample.dt_us
```

and then uses the existing packet-level `plot_t0_ms` relationship for within-epoch analysis timing.

## 3.4 Epochs

`ObjectiveTimeMapper` creates an `epochId` per `(sessionId, bootId)` mapper anchor. `plot_t0_ms` is the ESP-relative offset from the epoch anchor. [12]

Because the mapper state is in backend process memory, a backend restart can cause a new `epoch_id` without a physical ESP32 reboot. Therefore:

```text
boot_id change   → physical device reboot
epoch_id change  → new time-mapping epoch
```

not:

```text
any epoch change → device reboot
```

The analysis state should therefore be keyed by:

```text
(session_id, epoch_id)
```

and should be reset at every `epoch_id` change. This avoids attempting to stitch independent time domains together.

---


# 2. Sensor conversion and analysis-ready data model


## 4.1 ECG — AD8232 + ESP32 ADC

### What the hardware does

The AD8232 is a single-lead biopotential/ECG front end with an instrumentation amplifier gain of 100, configurable filtering/gain, an integrated reference buffer, and lead-off detection. The AD8232 itself does not define the gain/filter response of a third-party breakout board unless that board's external components are known. [13]

### Exact current firmware

The firmware uses:

```cpp
pinMode(ECG_PIN, INPUT);
analogReadResolution(12);

sample.adc = (uint16_t)analogRead(ECG_PIN);
```

at 250 Hz on GPIO34. It does not configure an explicit ADC attenuation in the shown firmware. [11]

Arduino-ESP32 documents `analogRead()` as an **uncalibrated raw ADC reading** and `analogReadResolution(12)` as a 0–4095 raw range. The calibrated millivolt function is `analogReadMilliVolts()`. [14]

### Recommended backend interpretation

```text
raw `adc`
    ↓
12-bit ESP32 ADC code
    ↓
engineering representation: ADC counts
```

Do **not** currently convert to volts or millivolts in the backend.

A formula such as:

```text
voltage = adc * 3.3 / 4095
```

is not defensible for this firmware because ADC attenuation and calibration are not encoded in the packet. The correct physical conversion also depends on the ADC calibration path and the analog source.

Likewise, the AD8232's internal gain of 100 is not sufficient to infer the complete breakout-board gain because a breakout can contain external low-pass/high-pass/gain components. [13]

### Output measurement

```text
field: ecg_adc
unit: ADC counts
kind: directly observed engineering quantity
```

### Lead-off

The two digital fields remain authoritative:

```text
loPlus === 1 → LO+ asserted
loMinus === 1 → LO- asserted
```

Analog Devices documents that the AD8232 exposes corresponding lead-off indications, including separate LO+/LO- behavior in DC lead-off mode. [15]

### ECG conversion table

| Raw field | Meaning | Output | Unit | Formula | Validity |
|---|---|---|---|---|---|
| `ecg.adc` | ESP32 ADC output code from AD8232 output | `ecg_adc` | counts | identity | valid as raw ADC code |
| `ecg.loPlus` | AD8232 lead-off flag | `lead_off_plus` | boolean | `value === 1` | direct digital flag |
| `ecg.loMinus` | AD8232 lead-off flag | `lead_off_minus` | boolean | `value === 1` | direct digital flag |
| `ecg.adc` | ADC waveform spread | `ecg_range_adc` | counts | `P95(adc)-P5(adc)` | derived, not mV |

### Important unresolved ECG calibration

Before exposing any physical voltage/amplitude unit, measure and document:

1. exact AD8232 breakout schematic;
2. external gain network;
3. high-pass/low-pass components;
4. supply/reference voltage;
5. ESP32 ADC attenuation configuration actually present at runtime;
6. ADC calibration method;
7. whether GPIO34 is read through the expected ADC1 channel configuration.

Until those are established, **ADC counts are the correct canonical representation**.

---

## 4.2 PPG — MAX30101

### Exact firmware configuration

The current firmware configures the MAX30101 using the SparkFun-compatible `MAX30105` API with:

```text
LED brightness     = 0x1F
sample average     = 1
LED mode           = 2  → RED + IR
sample rate        = 100 Hz
pulse width        = 411 us
ADC range          = 4096 nA full scale
```

and then reads:

```cpp
sample.red = ppgSensor.getFIFORed();
sample.ir  = ppgSensor.getFIFOIR();
```

[11]

The MAX30101 is a pulse-oximetry/heart-rate optical module with programmable sample rate and LED current and an internal ADC/FIFO path. [16]

The SparkFun library examples expose the same settings and treat `getFIFORed()` / `getFIFOIR()` as the device's raw FIFO data. [17]

### Raw output

The backend should preserve:

```text
ppg_red_count
ppg_ir_count
```

as the canonical measurement.

The MAX30101 ADC configuration also gives a defined ideal current-equivalent scale at each ADC full-scale setting; with the 4096 nA full-scale setting the datasheet scale is approximately 15.625 pA/LSB. [18]

However, the backend should still use **raw counts as the primary feature input** because converting counts to photodiode current does not by itself produce optical power, tissue perfusion, heart rate, or SpO2.

### SpO2

Do **not** expose SpO2 in the first analysis implementation. RED/IR data alone are not a complete validated SpO2 solution. The repository does not include a validated calibration/algorithm stack, and the user's scope explicitly excludes inventing one.

### PPG categories

| Feature / value | Classification |
|---|---|
| RED FIFO count | directly measured digital ADC count |
| IR FIFO count | directly measured digital ADC count |
| ideal photodiode-current-equivalent scale | derived engineering quantity |
| pulse interval | derived physiological timing feature |
| pulse rate | derived physiological feature |
| pulse amplitude in counts | derived device-domain feature |
| optical power in W | not defensible from current data path alone |
| SpO2 | not appropriate for this first implementation |

### PPG motion issue

PPG literature consistently identifies motion as a major source of waveform distortion and notes the use of accelerometry/gyroscopy as a useful reference for motion context. Pulse rate can be calculated from detected inter-pulse intervals. [19][20]

Therefore, the analysis engine should not pretend PPG amplitude/pulse-rate estimates have the same reliability during high movement as during low movement.

---

## 4.3 GSR / EDA — legacy ProtoCentral TinyGSR + TLA2022

### Exact current firmware

The firmware uses:

```cpp
tla2022.begin();
tla2022.setMode(TLA20XX::OP_CONTINUOUS);
tla2022.setDR(TLA20XX::DR_128SPS);
tla2022.setFSR(TLA20XX::FSR_0_512V);

sample.raw = tla2022.read_adc();
```

and stores the result as an `int16_t`. [11]

The TLA2022 is a 12-bit delta-sigma ADC; at `±0.512 V` its datasheet LSB size is `0.25 mV`. [21]

Thus, **assuming the installed `protocentral_TLA20xx` library's `read_adc()` returns the signed 12-bit conversion code corresponding directly to the selected FSR**, the ADC-domain engineering conversion is:

```text
v_diff_mV = raw * 0.25
```

This should be treated as an ADC input-voltage quantity, not as skin conductance.

### The important board-specific limitation

The repository's hardware is the **legacy TinyGSR implementation**, not the newer TinyGSR v3.

ProtoCentral's current documentation explicitly states that the original board used a hand-adjusted/trimpot-set front end, so identical ADC readings could correspond to different resistances/conductances on different boards. The newer v3 was redesigned specifically to make absolute conductance deterministic. [22]

Therefore:

```text
legacy TinyGSR raw ADC
    ↓
TLA2022 ADC-domain value
    ↓
relative/proxy EDA features
```

is defensible.

But:

```text
legacy TinyGSR raw ADC
    ↓
absolute skin conductance µS
```

is **not** defensible without board-specific gain/trim information and calibration against known resistances.

### Recommended naming

Use:

```text
gsr_raw_mean
gsr_raw_std
gsr_raw_delta
gsr_raw_slope_raw_per_s
gsr_raw_range
```

or, if you prefer an explicit engineering-voltage path after confirming the library implementation:

```text
gsr_adc_mV_mean
```

Do not call this:

```text
skin conductance µS
```

unless calibration is actually established.

### EDA terminology

Biomedical EDA literature distinguishes tonic skin conductance level (SCL) from phasic responses and normally expresses conductance in microsiemens. That terminology is appropriate only when the measurement is genuinely a calibrated conductance signal. [23]

For this legacy board, use:

```text
"electrodermal change indicator"
"GSR raw change"
"electrodermal activity proxy"
```

rather than:

```text
SCR = 0.17 µS
```

until absolute conductance calibration exists.

---

## 4.4 IMU — MPU6050

### Exact firmware configuration

The firmware writes:

```text
CONFIG      = 0x03
SMPLRT_DIV  = 9
GYRO_CONFIG = 0x00 → ±250 °/s
ACC_CONFIG  = 0x00 → ±2 g
```

and reads the six signed 16-bit data registers in a 14-byte burst. [11]

The InvenSense specification gives the corresponding sensitivity factors:

```text
±2 g       → 16,384 LSB/g
±250 °/s   → 131 LSB/(°/s)
```

[24]

### Exact conversions

```text
ax_g = axRaw / 16384
ay_g = ayRaw / 16384
az_g = azRaw / 16384

gx_dps = gxRaw / 131
gy_dps = gyRaw / 131
gz_dps = gzRaw / 131
```

### Derived measures

```text
acceleration_magnitude_g
    = sqrt(ax_g² + ay_g² + az_g²)

angular_velocity_magnitude_dps
    = sqrt(gx_dps² + gy_dps² + gz_dps²)

motion_index_g
    = median(|acceleration_magnitude_g - 1|)
```

The subtraction of 1 g is important because a stationary accelerometer already measures gravitational acceleration. The resulting `motion_index_g` is an engineering motion-context feature, not a clinical measurement.

### Intended use

IMU data should be used for:

1. movement characterization;
2. contextualizing ECG/PPG changes;
3. preventing over-interpretation of physiological changes during strong motion.

It should not directly imply any clinical state.

---

## 4.5 Temperature — TMP117

### Exact firmware

The firmware reads register `0x00` as a signed 16-bit value:

```cpp
sample.raw = ((int16_t)data[0] << 8) | data[1];
```

at a nominal 2 Hz acquisition rate. [11]

TI specifies a 16-bit result with a resolution of `0.0078125 °C/LSB`, operating over `-55 °C` to `150 °C` for the device family; accuracy depends on temperature range. [25]

### Exact conversion

```text
temperature_c = raw * 0.0078125
```

### Recommended features

```text
temperature_mean_c
temperature_min_c
temperature_max_c
temperature_delta_c
temperature_slope_c_per_min
```

Because the sensor is only sampled at 2 Hz and local skin temperature changes relatively slowly, temperature should be treated as a contextual trend, not a high-frequency modality.

---


## 2.6 Normalized analysis-ready sample representation


The conversion layer should produce one normalized in-memory representation without mutating the raw packet.

```ts
export interface AnalysisSampleBase {
  sessionId: string;
  bootId: string;
  epochId: string;
  packetSeq: number;
  sampleTimeUs: number;
  sampleTimeMs: number;
}

export interface AnalysisEcgSample extends AnalysisSampleBase {
  modality: "ecg";
  adc: number;
  loPlus: 0 | 1;
  loMinus: 0 | 1;
}

export interface AnalysisPpgSample extends AnalysisSampleBase {
  modality: "ppg";
  red: number;
  ir: number;
}

export interface AnalysisGsrSample extends AnalysisSampleBase {
  modality: "gsr";
  raw: number;
}

export interface AnalysisImuSample extends AnalysisSampleBase {
  modality: "imu";
  axG: number;
  ayG: number;
  azG: number;
  gxDps: number;
  gyDps: number;
  gzDps: number;
}

export interface AnalysisTempSample extends AnalysisSampleBase {
  modality: "temperature";
  temperatureC: number;
}
```

### Timestamp conversion

For every sample:

```text
sampleTimeUs = packet.raw_packet.t0_us + sample.dt_us
```

For current live within-epoch analysis:

```text
sampleTimeMs = packet.plot_t0_ms + sample.dt_us / 1000
```

Do not re-create sample times from packet arrival time.

Do not interpolate missing samples.

---


# 3. Final resolved analysis algorithms

## B.1 Common numeric rules used by all analysis code

These utility definitions are final and must be implemented once in `analysis/statistics.ts` or directly in `features.ts`/detector modules if the implementation remains small.

### Median

For a finite numeric array sorted ascending:

- odd `N`: middle element;
- even `N`: arithmetic mean of the two middle elements;
- empty array: `null`.

### MAD

`MAD(x) = median(|x_i - median(x)|)`.

Scaled robust sigma is:

`robustSigma = 1.4826 * MAD`.

The 1.4826 scale factor is the standard consistency factor used to make MAD comparable to standard deviation for Gaussian data. The use of MAD here is a robust engineering choice, not a distributional claim about the physiological signals. [W1]

### Population standard deviation

`SD = sqrt(sum((x_i - mean)^2) / N)`.

Return `null` for an empty array.

### Nearest-rank percentile

For `0 < p <= 1`, after ascending sort:

`rank = ceil(p * N)` and index `clamp(rank - 1, 0, N-1)`.

This is used only for `ecg_range_adc` so the percentile definition is deterministic.

### Epsilon

`EPSILON = 1e-9` is used only when a division denominator can be zero. It is not an engineering threshold and must never be displayed.

### Stable ordering

Whenever values are tied and one item must survive, the earlier timestamp wins unless the rule explicitly says otherwise.

---

## B.2 Exact ECG beat detector

### B.2.1 Detector state

ECG beat detection is **streaming and epoch-scoped**, not recomputed independently for each 10 s analysis window.

One detector exists per `(session_id, epoch_id)` and survives across the 1 s window boundaries.

State:

```ts
interface EcgDetectorState {
  previousSample: { timeUs: number; adc: number } | null;
  energyWindow: number[];        // last 20 valid energy values
  thresholdContext: number[];    // last 2500 smoothed-energy values
  candidate: EcgCandidate | null;
  acceptedBeats: EcgBeat[];      // retained for interval extraction; prune >15 s
  segmentStartUs: number | null;
  warmedSamples: number;
}
```

`acceptedBeats` is not a second raw buffer. It contains only detected beat timestamps plus the refined peak amplitude used for refractory comparison.

### B.2.2 Sample admission

For each incoming ECG sample in canonical timestamp order:

1. If `loPlus === 1 || loMinus === 1`, exclude it from detector processing.
2. If it is earlier than the detector state's `previousSample.timeUs`, discard it as out-of-order and increment `out_of_order_samples`.
3. If there is a previous valid sample and `sample.timeUs - previous.timeUs > 12 ms`, treat this as a discontinuity:
   - finalize nothing from the open candidate;
   - clear `previousSample`;
   - clear the 20-sample smoothing window;
   - clear the 10 s threshold context;
   - clear the candidate;
   - clear the interval anchor used for RR extraction across the discontinuity;
   - start a new valid segment at the current sample;
   - do not compute a derivative for the current sample.
4. Otherwise the current sample is valid input.

**Large ECG gap threshold:** `12 ms` (>3 nominal 4 ms periods). This is a prototype acquisition-quality heuristic. It is intentionally stricter than merely accepting any timestamp that is nondecreasing.

A lead-off interval is also a discontinuity. The detector must not bridge a lead-off span with a derivative or RR interval.

### B.2.3 Derivative

For a current valid sample `i` with the immediately preceding valid sample `i-1` in the same continuous segment:

```text
d[i] = adc[i] - adc[i-1]
```

No timestamp normalization is performed inside the derivative because the detector operates on the firmware's nominal 250 Hz ECG stream after the explicit timestamp-gap check.

### B.2.4 Squared energy

```text
energy[i] = d[i] * d[i]
```

The result is a JavaScript `number`; integer overflow is not an issue at the raw 12-bit ADC range.

### B.2.5 80 ms causal smoothing

At 250 Hz, 20 samples correspond to 80 ms.

The smoothing window is causal and includes the current energy value:

```text
energySmooth[i] = mean(last 20 energy values including energy[i])
```

Startup:

- fewer than 20 energy values: emit no smoothed value and do not start a candidate;
- once 20 values exist: calculate the first smoothed value.

### B.2.6 Adaptive threshold

Maintain the last 2500 `energySmooth` values, corresponding to 10 s at 250 Hz.

Before 250 smoothed-energy values exist, the detector is in **threshold warm-up** and no candidates are accepted. This prevents a threshold computed from a trivially small sample set.

Once at least 250 context values exist:

```text
medianE       = median(thresholdContext)
madE          = MAD(thresholdContext)
robustSigmaE  = 1.4826 * madE
threshold     = medianE + 4 * robustSigmaE
```

The current smoothed-energy value is part of `thresholdContext`.

If `madE === 0`, the threshold becomes exactly `medianE`. This is intentional: a constant energy background has no estimated robust spread. Candidate gating is then controlled by the strict `>` comparison below.

The factor `4` is a prototype heuristic inspired by the adaptive-threshold principle of QRS detection; it is not imported as a clinical Pan–Tompkins constant. Pan and Tompkins established the general use of slope/amplitude/width analysis and adaptive thresholds for QRS detection. [W2]

### B.2.7 Candidate start/continuation/end

A candidate is an inclusive run of consecutive smoothed-energy samples satisfying:

```text
energySmooth > threshold
```

Rules:

- start: first above-threshold sample after a non-above-threshold sample;
- continuation: each consecutive above-threshold sample extends the same candidate;
- end: first below-or-equal-threshold sample terminates the candidate;
- no candidate merging is performed;
- a candidate that continues into a timestamp gap or lead-off is discarded, not finalized;
- a candidate that is still open at session stop is discarded.

Candidate duration is computed from candidate start/end sample timestamps:

```text
candidateDurationMs = endTimeMs - startTimeMs
```

Accepted candidate duration range:

```text
20 ms <= candidateDurationMs <= 200 ms
```

A candidate outside this interval is rejected.

This duration range is a prototype detector guardrail. It is not a clinical QRS-width classification.

### B.2.8 Candidate seed

For an accepted-duration candidate, select the seed sample with maximum:

```text
abs(d[i])
```

over the candidate's member samples.

Tie: earliest sample timestamp.

### B.2.9 Peak refinement

Search the original ECG ADC waveform in the same continuous segment over:

```text
[seedTime - 40 ms, seedTime + 40 ms]
```

clamped to the available contiguous samples.

Compute the local ADC baseline as the median of all valid ADC values in that ±40 ms search interval.

For each sample in that interval compute:

```text
localDeflection = abs(adc - localBaseline)
```

Select the sample with maximum `localDeflection` as the refined beat time.

Tie: earliest timestamp.

The refinement therefore does not assume whether the dominant QRS deflection is positive or negative.

### B.2.10 Refractory behavior

After refinement, compare the new candidate to the most recently accepted beat.

If:

```text
newPeakTime - lastAcceptedPeakTime < 250 ms
```

the two peaks belong to the same refractory conflict.

Keep the candidate with larger `localDeflection`. If equal, keep the earlier peak.

If the new candidate wins, replace the previously stored beat with the new beat.

This rule is applied repeatedly, so a sequence of closely spaced candidates collapses to the strongest deterministic candidate.

`250 ms` is a prototype detector guardrail corresponding to a 240 bpm maximum detection frequency; it is not a clinical upper limit. The role of a refractory period is consistent with established QRS detector design principles. [W2][W3]

### B.2.11 RR intervals

For each accepted beat whose timestamp is inside the current analysis window, calculate an interval from the immediately preceding accepted beat in the same continuous detector segment.

The preceding beat can lie before the analysis-window start.

An RR interval is valid only when:

```text
300 ms <= RR <= 2000 ms
```

and the interval does not cross a lead-off or timestamp-gap discontinuity.

If the preceding beat is unavailable because the detector segment was reset, no RR interval is produced for the current beat.

Duplicate/near-duplicate beats have already been removed by the 250 ms refractory rule; no second de-duplication pass is required.

### B.2.12 ECG feature extraction from detector output

For a window `[start,end)`:

- `beat_count`: accepted refined beats with `start <= beatTime < end`;
- `rr_intervals_ms`: internal list of valid intervals whose **current beat** is in the window;
- `rr_interval_ms`: median of `rr_intervals_ms`, or `null` if no valid intervals;
- `heart_rate_bpm`: `60000 / median(rr_intervals_ms)` when at least 3 valid intervals exist, else `null`;
- `rr_mean_ms`: mean of valid intervals, or `null` if none;
- `rr_std_ms`: population SD when at least 5 valid intervals exist, else `null`;
- `ecg_range_adc`: nearest-rank `P95(adc) - P5(adc)` over valid non-lead-off ADC samples in the window;
- `lead_off_fraction`: `leadOffSampleCount / totalObservedEcgSampleCount`, `0` when no ECG samples exist.

Do not expose a feature named `HRV`.

### B.2.13 Why state is retained across windows

The detector is intentionally epoch-streaming. Re-running it separately for every overlapping 10 s window produces different candidate decisions near the left edge because the derivative, moving-average, adaptive threshold, and refractory state have histories extending before that edge. Retained state makes identical input streams produce one deterministic beat sequence independent of the 1 s emission grid.

---

## B.3 Exact PPG pulse detector

### B.3.1 Detector state

Use a separate streaming detector per `(session_id, epoch_id)`:

```ts
interface PpgDetectorState {
  lastRawSample: { timeUs: number; ir: number } | null;
  smoothWindow: number[];       // last 3 IR values
  thresholdContext: number[];   // last 1000 smoothed IR values
  previousAcceptedPulse: PpgPulse | null;
  acceptedPulses: PpgPulse[];
  segmentStartUs: number | null;
}
```

`1000` smoothed samples = 10 s at the nominal 100 Hz PPG rate.

### B.3.2 Sample admission and gap reset

Use IR as the primary pulse-detection channel.

RED is carried through and feature-calculated but never drives pulse timing in V1.

For each PPG sample:

- reject out-of-order samples without reordering;
- if the timestamp gap from the previous valid sample is `>25 ms`, reset smoothing, threshold context, pending local-maximum evaluation, and the previous pulse interval anchor;
- the first sample after a gap begins a new segment and is not compared against the pre-gap sample.

`25 ms` is the V1 PPG large-gap threshold.

### B.3.3 Smoothing

Use a causal 3-sample moving average including the current sample:

```text
smooth[i] = mean(ir[i-2], ir[i-1], ir[i])
```

Do not emit a smoothed point until 3 contiguous valid IR samples exist.

### B.3.4 Adaptive prominence threshold

Maintain the last 1000 smoothed values.

Before at least 100 smoothed samples (1 s) exist, do not accept pulse peaks.

For the current threshold context:

```text
medianIR       = median(context)
madIR          = MAD(context)
robustSigmaIR  = 1.4826 * madIR
minimumProminence = max(1, 2 * robustSigmaIR)
```

The `1` is one raw-count minimum so a zero-MAD flat signal cannot make all strict local maxima pass a zero threshold.

The current smoothed value is included in the context.

### B.3.5 Local peak condition

A candidate peak is the center sample `i` of three consecutive smoothed values satisfying:

```text
smooth[i] > smooth[i-1]
AND
smooth[i] > smooth[i+1]
```

Strict comparison is intentional. Flat or plateau maxima are **not** accepted as peaks in V1.

This gives deterministic plateau handling without introducing an additional plateau-width policy.

Because `smooth[i+1]` is required, peak evaluation is delayed by one input sample. This is an implementation detail and does not alter the timestamp assigned to the peak.

Local peak methods are established heuristic approaches in PPG analysis literature, while the literature also warns that motion can materially distort pulse morphology. [W4][W5]

### B.3.6 Trough for prominence

For candidate peak time `tPeak`, search the smoothed IR signal over:

```text
[max(segmentStart, tPeak - 600 ms), tPeak]
```

and choose the minimum smoothed IR value.

Tie: earliest timestamp.

```text
prominence = smoothPeak - troughSmooth
```

Accept the candidate only when:

```text
prominence >= minimumProminence
```

`600 ms` is a V1 engineering lookback chosen to span multiple possible pulse intervals without building a more complicated morphology detector.

### B.3.7 Minimum spacing / conflict resolution

For consecutive accepted candidates:

```text
delta = candidateTime - previousAcceptedTime
```

If `delta >= 300 ms`, accept the new candidate.

If `delta < 300 ms`, compare candidate prominence with previous prominence:

- larger prominence survives;
- equal prominence → earlier timestamp survives.

The previous accepted pulse is replaced if the later candidate wins.

`300 ms` is a V1 pulse detector guardrail, not a clinical rate limit.

### B.3.8 Interval validity

For pulse features, accept IBI values only when:

```text
300 ms <= IBI <= 2000 ms
```

An IBI crossing a timestamp-gap discontinuity is invalid.

A single IBI >2000 ms is rejected but does not reset the pulse detector. The next pulse continues to use the preceding accepted pulse as its interval anchor.

A detector segment reset does reset the interval anchor.

### B.3.9 Window-boundary behavior

Detection state is retained across the 1 s emission grid exactly like ECG.

For a current 10 s window:

- `pulse_count`: accepted pulse timestamps inside `[start,end)`;
- `pulse_interval_ms`: median of valid IBIs whose current pulse is inside the window;
- `pulse_rate_bpm`: `60000 / median(IBI)` when at least 3 valid IBIs exist, else `null`;
- `pulse_interval_mean_ms`: mean of valid IBIs, or `null`;
- `pulse_interval_std_ms`: population SD when at least 5 valid IBIs exist, else `null`;
- first in-window pulse uses a preceding accepted pulse outside the window when it belongs to the same segment and produces a valid IBI.

### B.3.10 Pulse amplitude

For each accepted pulse in the current window with a preceding accepted pulse in the same segment:

```text
amplitude = currentPeakIR - min(rawIR between previousAcceptedPulse and currentPeak)
```

The interval is inclusive of the previous pulse endpoint and current pulse endpoint.

For the first current-window pulse, the preceding pulse can lie before the window start; the 15 s raw buffer retains enough context.

Then:

```text
pulse_amplitude_raw = median(valid amplitudes for current-window pulses)
```

This is raw-count amplitude, not perfusion index.

### B.3.11 PPG auxiliary features

```text
ppg_red_mean = mean(RED)
ppg_ir_mean  = mean(IR)
ppg_red_std  = population SD(RED)
ppg_ir_std   = population SD(IR)
```

Return `null` for an empty modality sample set.

### B.3.12 Motion handling

The PPG detector does not cancel motion artifacts.

IMU-derived `movement_level` is evaluated independently. If `movement_level === "high"`, PPG quality is `limited` even if pulse detection succeeded. This is a data-quality decision, not signal cleaning. Motion is a well-established source of PPG distortion. [W4][W5]

---

## B.4 Shared peak-detection utility decision

Do **not** create a generic `PeakDetector` class.

Share only low-level deterministic helpers:

```ts
median(values)
mad(values)
populationStd(values)
nearestRankPercentile(values, p)
mean(values)
clamp(value, min, max)
```

ECG and PPG detectors remain separate because their:

- input semantics,
- smoothing,
- thresholding,
- candidate windows,
- spacing rules,
- refinement,
- and validity conditions

differ materially.

This is the smallest abstraction that removes genuinely duplicated logic without hiding modality-specific behavior.

---

## B.5 Exact window scheduler

### B.5.1 Global time source

The scheduler uses the canonical sample time already created from the accepted packet, but its grid coordinates are **epoch-relative**. They are offsets from the fixed ESP32 timestamp anchor for the current `(session_id, epoch_id)`; they are not the values persisted in `window_start_us` and `window_end_us`.

```text
sampleTimeUs = packet.raw_packet.t0_us + sample.dt_us
epochRelativeUs = sampleTimeUs - epochEspAnchorUs
sampleTimeMs = packet.plot_t0_ms + sample.dt_us / 1000
             = epochRelativeUs / 1000
```

`epochEspAnchorUs` is the accepted packet's `esp_anchor_us` and remains fixed for the epoch. The scheduler may use the relative millisecond fields for the readable grid, but exact grid boundaries are integer microsecond offsets: the first end is `10,000,000` relative microseconds and each subsequent end advances by `1,000,000` relative microseconds.

When a complete relative grid window `[startMs, endMs)` is emitted, construct its durable/transport timestamp fields deterministically:

```text
start_us = epochEspAnchorUs + startMs * 1000
end_us   = epochEspAnchorUs + endMs * 1000
```

Therefore `start_us` and `end_us` are **absolute ESP32 `esp_timer_us` timestamps**, while `start_ms` and `end_ms` remain epoch-relative analysis-grid coordinates. Every V1 window has `end_us = start_us + 10,000,000`, equivalently persisted `window_end_us = window_start_us + 10,000,000`; the relative coordinates `0, 10,000, 11,000, ...` must never be written into the persisted `_us` columns.

No packet arrival time is used for feature timing. [P1][R2]

### B.5.2 Per-epoch state

```ts
interface AnalysisWindowState {
  sessionId: string;
  epochId: string;
  espAnchorUs: number;
  nextWindowEndMs: number;
  latestSampleMs: number;
  lastProcessedPacketSeq: number | null;
  packetGapEvents: PacketGapEvent[];
  packetMetadata: PacketMetadata[];
}
```

On the first accepted packet in an epoch:

```text
epochRelativeStart = 0 ms
nextWindowEnd = 10,000 ms
```

### B.5.3 First complete window

The first window is emitted exactly when the union of accepted modality sample timestamps reaches `10,000 ms`:

```text
window = [0, 10,000)
```

A sample at exactly `10,000 ms` is excluded from that first window and belongs to the next window.

This matches the `[start,end)` rule. [P1]

### B.5.4 One packet producing multiple windows

After all samples from a packet are inserted, compute the maximum canonical `sampleTimeMs` present across all accepted samples in the packet and state.

Then:

```ts
while (latestSampleMs >= nextWindowEndMs) {
  emitWindow(
    start = nextWindowEndMs - 10_000,
    end   = nextWindowEndMs,
  );
  nextWindowEndMs += 1_000;
}
```

This means one packet can cause zero, one, or many window emissions.

The windows are emitted strictly in ascending `end_ms` order.

No sample values are synthesized during a timestamp gap.

### B.5.5 Empty / all-unavailable windows

A complete grid window is still emitted when one or more modalities have no samples. No values are invented.

If all modalities have zero samples in a complete grid window, the result is:

- all modalities `unavailable`;
- `MM-07` selected;
- `evidence_tier = "insufficient"`;
- all scalar feature values `null`;
- every modality's `quality.sample_count = 0` and no modality samples contribute to the window; `source.analysis_input_gap_count` reflects any queue-drop events overlapping the window.

This is a real statement about data availability, not a synthetic physiological result.

### B.5.6 Out-of-order samples

The analysis layer does not sort or repair timestamps.

For each modality, if `sampleTimeMs < lastAcceptedSampleTimeMs`, the sample is dropped and counted in `source.discarded_out_of_order_samples`.

Packet order remains the transport order already established by `SequenceTracker`. The existing `SequenceTracker` classifies first/normal/gap/duplicate-stale packets and prevents stale duplicates from reaching the accepted-packet bus. [R4]

### B.5.7 Packet gap representation

For every accepted packet with `sequence_status === "gap"`, create:

```ts
interface PacketGapEvent {
  previousSeq: number | null;
  nextSeq: number;
  missingPackets: number;
  startMs: number;
  endMs: number;
}
```

For a gap between packets A and B, use:

```text
startMs = packetAEndMs
endMs   = packetBStartMs
```

If either boundary is unavailable, use the two packet start times as the conservative interval.

A packet-gap event affects a window's modality quality only when the event interval intersects the window:

```text
gapEndMs > windowStartMs
AND
 gapStartMs < windowEndMs
```

The packet gap does not automatically invalidate a modality when it is entirely outside that window.

### B.5.8 Analysis-input drops

When the serialized analysis queue is full, the dropped packet is not lost from ingestion/storage. The pipeline records a short-lived `AnalysisInputGapEvent` containing the packet sequence and packet time interval. A complete window increments `source.analysis_input_gap_count` when such an event intersects the window. Analysis-input drops never become device `sequence_status` gaps.

```ts
interface AnalysisInputGapEvent {
  seq: number;
  startMs: number;
  endMs: number;
}
```

Retain these events for the same 15 s analysis metadata horizon as packet metadata.

### B.5.9 Sample-gap representation

Each modality independently records timestamp gaps. A large gap affects the window when its interval intersects the window.

### B.5.9 Epoch transition

When the next accepted packet has a different `epoch_id`:

1. stop processing the old epoch after all already-enqueued packets for that epoch are processed;
2. do not emit any partial old-epoch final window;
3. discard any open ECG/PPG candidate crossing the transition;
4. discard ECG/PPG interval anchors crossing the transition;
5. clear all sample buffers;
6. clear window scheduler state;
7. clear packet-gap metadata;
8. reset all baseline state;
9. reset rule persistence counters;
10. create a fresh analysis state for the new epoch.

`boot_id` is retained as output metadata but is not independently treated as a second analysis reset when `epoch_id` is unchanged.

The repository's `ObjectiveTimeMapper` keys anchors by `(sessionId, bootId)` and creates a new epoch anchor for a newly seen `(session,boot)` pair. [R5]

### B.5.10 Session stop

Do **not** emit a partial final window.

Example: if the latest complete emitted window ended at `19,000 ms` and session stop occurs at `19,500 ms`, the `[9,500,19,500)` partial window is not emitted.

Already-complete windows are never retroactively generated using stop time.

---

## B.6 Exact sample-buffer implementation

### Decision: use `Array`, not a ring buffer or third-party deque

The current V1 live workload is only about 580 samples/s across five modalities, and the analysis requirement is a short 15 s rolling retention. A simple monotonic array with a head index is easier to reason about and test than a custom circular structure, while still keeping memory bounded. The repository has no time-series library dependency and already uses ordinary TypeScript/JavaScript collections. [P1][R6]

### Buffer contract

```ts
interface TimedSample {
  sampleTimeMs: number;
}

class SampleBuffer<T extends TimedSample> {
  private items: T[] = [];
  private head = 0;
  private lastTimeMs = -Infinity;

  append(sample: T): boolean;
  range(startMs: number, endMs: number): readonly T[];
  pruneBefore(cutoffMs: number): void;
  clear(): void;
  latestTimeMs(): number | null;
  size(): number;
}
```

### Append

```ts
if (sample.sampleTimeMs < lastTimeMs) return false;
items.push(sample);
lastTimeMs = sample.sampleTimeMs;
return true;
```

Equal timestamps are accepted in input buffers only when the modality semantics permit them; the expected firmware streams are timestamp-ordered without duplicates. Detector modules handle exact duplicate peak timestamps by their own rules.

### Range lookup

Because timestamps are monotonic, use a forward scan from `head` for V1. The maximum retained set is small enough that a binary search is unnecessary.

Include samples satisfying:

```text
startMs <= sampleTimeMs < endMs
```

### Pruning

After each packet:

```text
cutoff = latestGlobalSampleMs - 15,000 ms
```

Advance `head` while `items[head].sampleTimeMs < cutoff`.

When `head > 1024 && head * 2 > items.length`, compact with `items = items.slice(head)` and reset `head = 0`.

### Retention reason

15 s provides:

- the current 10 s feature window;
- the preceding 2 s needed for interval/amplitude context;
- additional margin for asynchronous packet grouping.

No full-session in-memory sample history is retained.

---

## B.7 Exact quality functions

### B.7.1 Common quality precedence

For every modality, evaluate conditions in this order:

1. `unavailable` conditions;
2. `limited` conditions;
3. `good` conditions;
4. otherwise `usable`.

Return reason codes in fixed priority order and de-duplicate them.

### Common coverage

The V1 expected sample counts are fixed for a 10 s window:

| Modality | Nominal rate | Expected samples / 10 s |
|---|---:|---:|
| ECG | 250 Hz | 2500 |
| PPG | 100 Hz | 1000 |
| GSR | ~128 Hz | 1280 |
| IMU | 100 Hz | 1000 |
| Temperature | 2 Hz | 20 |

`coverageFraction = clamp(observedSampleCount / expectedSampleCount, 0, 1)`.

The denominator uses observed sample presence, not valid-feature count. Lead-off and motion are quality modifiers applied separately.

The firmware rates are defined in the current V5.3 firmware. [R7]

### Common large-gap thresholds

| Modality | Large-gap condition |
|---|---:|
| ECG | `gap_ms > 12` |
| PPG | `gap_ms > 25` |
| GSR | `gap_ms > 20` |
| IMU | `gap_ms > 25` |
| Temperature | `gap_ms > 1,500` |

All are `PROTOTYPE_HEURISTIC` acquisition-quality thresholds except where directly tied to the firmware's expected sampling interval; they do not imply physiological abnormality.

### ECG quality

Inputs:

```text
total samples
lead-off fraction
valid RR interval count
coverage
large-gap flag
packet-gap intersection flag
```

Classification:

```text
unavailable if:
  total samples == 0
  OR lead_off_fraction > 0.50

limited if:
  lead_off_fraction > 0.20
  OR valid RR intervals < 3
  OR coverage < 0.50
  OR large gap
  OR intersecting packet gap

good if:
  coverage >= 0.80
  AND lead_off_fraction <= 0.05
  AND valid RR intervals >= 4
  AND no large gap
  AND no intersecting packet gap

otherwise usable
```

Reason codes, in priority order:

```text
NO_SAMPLES
LEAD_OFF_OVER_50
COVERAGE_BELOW_50
LEAD_OFF_OVER_20
RR_INSUFFICIENT
LARGE_GAP
PACKET_GAP
COVERAGE_BELOW_80
LEAD_OFF_OVER_5
```

### PPG quality

Inputs:

```text
IR sample count
coverage
valid pulse interval count
movement_level
large gap
packet gap
```

Classification:

```text
unavailable if:
  IR sample count == 0
  OR valid pulse intervals == 0 AND at least one IR sample exists with no usable pulse evidence

limited if:
  coverage < 0.50
  OR valid pulse intervals in {1,2}
  OR movement_level == high
  OR large gap
  OR packet gap

good if:
  coverage >= 0.80
  AND valid pulse intervals >= 4
  AND movement_level != high
  AND no large gap
  AND no packet gap

otherwise usable
```

This explicitly resolves the previous report's internal test conflict: **PPG with zero valid pulse intervals is `unavailable`; one or two valid intervals is `limited`.** This is a feature-availability classification, not a statement that the physical PPG sensor is disconnected.

Reason codes:

```text
NO_SAMPLES
NO_VALID_PULSES
COVERAGE_BELOW_50
PULSE_INTERVAL_INSUFFICIENT
HIGH_MOTION
LARGE_GAP
PACKET_GAP
COVERAGE_BELOW_80
```

### GSR quality

Classification:

```text
unavailable if total samples == 0

limited if:
  coverage < 0.50
  OR large gap
  OR packet gap
  OR saturatedFraction >= 0.05

good if:
  coverage >= 0.80
  AND no large gap
  AND no packet gap
  AND saturatedFraction < 0.05

otherwise usable
```

For the current signed 12-bit TLA2022 path, saturation is defined as:

```text
raw <= -2048 OR raw >= 2047
```

`5%` is the V1 engineering quality threshold for repeated rail values. Absolute conductance is still not inferred from this legacy TinyGSR path. [P1][R7][W6]

Reason codes:

```text
NO_SAMPLES
COVERAGE_BELOW_50
LARGE_GAP
PACKET_GAP
SATURATED
COVERAGE_BELOW_80
```

### IMU quality

```text
unavailable if total samples == 0

limited if coverage < 0.50 OR large gap OR packet gap

good if coverage >= 0.80 AND no large gap AND no packet gap

otherwise usable
```

Reason codes:

```text
NO_SAMPLES
COVERAGE_BELOW_50
LARGE_GAP
PACKET_GAP
COVERAGE_BELOW_80
```

### Temperature quality

```text
unavailable if sample count == 0

limited if:
  sample count in [1,9]
  OR coverage < 0.50
  OR max gap > 1500 ms
  OR packet gap

usable if sample count >= 10

good if:
  sample count >= 16
  AND max gap <= 1500 ms
  AND no packet gap
```

Reason codes:

```text
NO_SAMPLES
SAMPLES_BELOW_10
STALE
LARGE_GAP
PACKET_GAP
SAMPLES_BELOW_16
```

A stale temperature window never blocks other modalities from being analyzed.

### Quality function signature

```ts
function evaluateQuality(
  window: AnalysisWindow,
  modalityData: ModalityWindowData,
  metadata: WindowMetadata,
): ModalityQuality;
```

The function is pure. It does not mutate detector/baseline state.

---

## B.8 Exact baseline state machine

### B.8.1 Baseline window eligibility

Baseline collection starts at the first complete 10 s analysis window of an epoch and closes exactly at 60,000 ms from epoch start.

Only windows satisfying:

```text
window.end_ms <= 60,000
```

contribute to baseline.

The baseline is **not** backfilled after 60 s.

### B.8.2 Feature-level eligibility

Each rule-relevant feature has its own baseline accumulator.

Required baseline features:

| Modality | Required baseline feature |
|---|---|
| ECG | `heart_rate_bpm` |
| PPG | `pulse_rate_bpm` |
| GSR | `gsr_raw_mean` |
| IMU | `motion_index_g` |
| Temperature | `temperature_mean_c` |

A feature value enters baseline only when:

```text
modality quality >= usable
AND
feature.value !== null
AND
feature.valid === true
```

Each feature keeps its own list of eligible values.

### B.8.3 Baseline readiness

At collection close (`epochRelativeTime >= 60,000 ms`):

```text
feature baseline ready = eligible feature values >= 4
```

A modality baseline is ready when its rule-relevant required feature is ready.

A feature/modality that does not reach 4 eligible windows within the first 60 s is marked `incomplete` for that epoch and never becomes ready later in that epoch.

This resolves the previous report's apparent contradiction between “first 60 s” and “at least 4 usable windows”: **both are mandatory; collection is limited to the first 60 s, and four eligible windows are required within that interval.**

### B.8.4 Stored baseline values

For each ready feature:

```text
baseline_median = median(eligible values)
baseline_MAD    = MAD(eligible values)
```

The eligible-value order does not matter because the estimators are order-independent.

### B.8.5 Global baseline readiness flag

The previous boolean is refined as follows:

```text
AnalysisResult.baseline_ready = true
```

iff:

```text
at least TWO of:
  ECG baseline ready
  PPG baseline ready
  GSR baseline ready
  Temperature baseline ready
```

are true.

IMU is contextual and is therefore not required for the global multimodal baseline-ready flag.

The result also carries per-modality baseline state so a single boolean never hides which baseline is actually ready.

### B.8.6 MAD = 0

No arbitrary minimum variance is injected into the stored baseline.

Store:

```text
baseline_MAD = 0
```

when mathematically zero.

When calculating robust z:

```text
robustSigma = 1.4826 * baseline_MAD
robustZ = (current - baselineMedian) / max(robustSigma, EPSILON)
```

When `baseline_MAD === 0`, any exact-equal current value gives `robustZ = 0` and a non-equal value gives an extremely large signed magnitude because of `EPSILON`. For V1 GSR rule behavior this is intentional and deterministic; it identifies deviation from a perfectly flat baseline rather than inventing a spread.

### B.8.7 Relative comparisons

For ECG HR and PPG PR:

```text
percentChange = 100 * (current - baselineMedian) / max(abs(baselineMedian), EPSILON)
```

For temperature:

```text
deltaC = current - baselineMedian
percentChange = 100 * deltaC / max(abs(baselineMedian), EPSILON)
```

For GSR:

```text
deltaRaw = currentMean - baselineMedian
robustZ = (currentMean - baselineMedian) / max(1.4826 * baselineMAD, EPSILON)
```

### B.8.8 Reset

Reset on:

```text
session_id change
OR epoch_id change
```

A `boot_id` change necessarily creates a new epoch in the current time-mapper design and therefore causes the same reset through `epoch_id`.

### B.8.9 Rule persistence state

Each persistent rule owns a counter:

```ts
interface RulePersistenceState {
  consecutiveTrue: number;
}
```

Update:

```text
condition true and eligible -> counter += 1
condition false              -> counter = 0
ineligible                   -> counter = 0
```

A rule fires on the window where the counter reaches its required count.

No counter survives an epoch reset.

---

## B.9 Exact modality rule evaluation

All threshold values below are tagged in code as `threshold_source: "prototype_heuristic"` unless the threshold is directly a hardware scale or a baseline-derived quantity.

### ECG-01 — heart-rate relative change

Inputs:

```text
ECG quality >= usable
heart_rate_bpm != null
baseline HR ready
lead_off_fraction <= 0.20
```

Condition:

```text
abs(percentChangeHR) >= 15.0
```

Persistence: `2` consecutive eligible windows.

Output text:

`Heart-rate change detected`

Exact boundaries:

```text
15.000%  -> condition true
14.999%  -> condition false
15.001%  -> condition true
```

If any intervening window is false or ineligible, the counter resets.

### ECG-02 — limited ECG beat evidence

Eligible when:

```text
ECG sample_count > 0
AND
heart_rate_bpm == null
```

and the reason is beat/gap/lead-off evidence insufficiency.

Status: `fired` on every such window; no persistence required.

Output:

`ECG data are limited for beat-based analysis`

If ECG has no samples at all, status is `ineligible` rather than fired.

### PPG-01 — pulse-rate relative change

Inputs:

```text
PPG quality >= usable
pulse_rate_bpm != null
baseline PR ready
```

Condition:

```text
abs(percentChangePR) >= 15.0
```

Persistence: 2 consecutive eligible windows.

Boundaries are identical to ECG-01.

Output:

`Pulse-rate change detected`

### PPG-02 — ECG/PPG rate disagreement

Inputs:

```text
ECG quality >= usable
PPG quality >= usable
HR != null
PR != null
```

Compute:

```text
rateDifference = abs(HR - PR)
rateThreshold = max(10.0, 0.10 * ((HR + PR) / 2))
```

Fire when:

```text
rateDifference > rateThreshold
```

This comparison is strict.

```text
exactly 10.0 bpm difference with threshold 10.0 -> false
10.0001 bpm -> true
```

No persistence requirement.

Output:

`Cardiovascular measurement disagreement`

### GSR-01 — electrodermal upward change indicator

Inputs:

```text
GSR quality >= usable
gsr_raw_mean != null
baseline GSR ready
robust_z != null
gsr_raw_slope_raw_per_s != null
```

Condition:

```text
robust_z >= 2.0
AND
slope > 0
```

Persistence: 2 consecutive eligible windows.

Boundaries:

```text
robust_z = 2.000 and slope > 0 -> true
robust_z = 1.999 and slope > 0 -> false
robust_z = 2.000 and slope = 0 -> false
robust_z = 2.001 and slope = -0.001 -> false
```

Output:

`Increased electrodermal activity relative to session baseline`

### IMU-01 — elevated movement context

Movement-level thresholds are:

```text
lowThreshold  = max(0.03, baselineMotion + 2*MADMotion)
highThreshold = max(0.10, baselineMotion + 3*MADMotion)
```

When the IMU baseline is not ready, use fixed thresholds:

```text
lowThreshold  = 0.03 g
highThreshold = 0.10 g
```

Classification:

```text
motion_index_g < lowThreshold             -> low
lowThreshold <= motion_index_g < highThreshold -> moderate
motion_index_g >= highThreshold           -> high
```

Rule fires whenever:

```text
IMU quality >= usable
AND movement_level == high
```

No persistence requirement.

Output:

`Elevated movement during analysis window`

### TEMP-01 — local temperature change

Inputs:

```text
Temperature quality >= usable
temperature_mean_c != null
baseline temperature ready
```

Condition:

```text
abs(temperature_delta_c) >= 0.5
```

Persistence: 3 consecutive eligible windows.

Boundaries:

```text
0.500 °C -> true
0.499 °C -> false
-0.500 °C -> true
-0.499 °C -> false
```

Output:

`Local skin-temperature change detected`

### QUALITY-01 — insufficient modality evidence

For each modality:

```text
required feature missing
OR modality quality == unavailable
```

means the corresponding rule is `ineligible` and emits no physiological observation.

`QUALITY-01` is therefore a bookkeeping evaluation, not a displayed physiological event.

---

## B.10 Exact multimodal precedence

### B.10.1 Observation dimensions

The engine derives exactly three physiological dimensions:

```text
CARDIOVASCULAR
  = ECG-01 OR PPG-01, provided PPG-02 is not unresolved

ELECTRODERMAL
  = GSR-01

TEMPERATURE
  = TEMP-01
```

IMU is context only.

### B.10.2 One primary pattern

Exactly one `multimodal_result` is selected per window.

Multiple modality rules can fire simultaneously. The result object exposes all fired modality rule IDs, but only one multimodal pattern is primary.

Priority:

```text
1. MM-06  cardiovascular measurement disagreement
2. MM-01  cardiovascular change + elevated movement
3. MM-02  multi-modality physiological change observed
4. MM-03  isolated cardiovascular change
5. MM-04  isolated electrodermal change
6. MM-05  isolated local temperature change
7. MM-08  no material change from session baseline observed
8. MM-07  insufficient evidence
```

The first matching rule wins.

### MM-06 — cardiovascular measurement disagreement

Match whenever PPG-02 fired.

```text
pattern = Cardiovascular measurement disagreement
supporting = ["ecg", "ppg"]
contradicting = ["ecg", "ppg"]
rule_ids = ["PPG-02", "MM-06"]
```

This always wins over other patterns because disagreement prevents clean cardiovascular fusion.

### MM-01 — cardiovascular change with elevated movement

Match when:

```text
cardiovascular_change == true
movement_level == high
AND
PPG-02 did not fire
```

```text
pattern = Cardiovascular change co-occurred with elevated movement
supporting = cardiovascular source modalities + ["imu"]
contradicting = []
evidence_tier = "limited"
```

If both ECG-01 and PPG-01 fire, both ECG and PPG appear in supporting modalities; IMU is also included because it supplies the context.

### MM-02 — multi-modality physiological change observed

Match when:

```text
at least TWO of:
  cardiovascular
  electrodermal
  temperature

AND
at least TWO distinct supporting modalities quality >= usable
AND
movement_level != high
AND
PPG-02 did not fire
AND
condition persists for >=2 consecutive windows
```

Persistence here refers to the same dimension-combination predicate, not merely any change dimension. Thus an ECG-only window followed by GSR-only window does not count as persistent MM-02.

Output:

`Multi-modality physiological change observed`

### MM-03 — isolated cardiovascular change

Match when:

```text
cardiovascular_change == true
AND electrodermal_change == false
AND temperature_change == false
AND PPG-02 == false
```

No additional multimodal persistence is required because ECG-01/PPG-01 already carry their own two-window persistence.

### MM-04 — isolated electrodermal change

Match when:

```text
electrodermal_change == true
AND cardiovascular_change == false
AND temperature_change == false
```

### MM-05 — isolated temperature change

Match when:

```text
temperature_change == true
AND cardiovascular_change == false
AND electrodermal_change == false
```

### MM-07 — insufficient evidence

Match when:

```text
baseline_ready == false
OR usable_modality_count < 2
```

where `usable_modality_count` counts modalities whose quality is `good` or `usable`.

Also match when a required multimodal comparison is impossible because its participating modality is `unavailable`.

`MM-07` is below MM-06 in priority so a concrete ECG/PPG disagreement is still exposed as the primary data interpretation when both rates were available.

### MM-08 — no material change from session baseline observed

Match when:

```text
baseline_ready == true
AND usable_modality_count >= 3
AND no modality change observation is active
AND PPG-02 == false
```

Output:

`No material change from session baseline observed`

This must never be rendered as “normal”, “healthy”, or “stable patient”.

### B.10.3 Supporting vs contradicting modalities

- `supporting_modalities`: modalities whose rule outputs directly support the selected primary pattern or its context.
- `contradicting_modalities`: modalities that explicitly disagree with a fused interpretation; in V1 this is only ECG + PPG under MM-06.
- No modality is marked contradicting merely because it is unavailable or quiet.

### B.10.4 All fired rules

`AnalysisResult.rules_triggered` contains:

```text
all fired modality-rule IDs in fixed modality order:
ECG, PPG, GSR, IMU, temperature
then the selected multimodal rule ID
```

It does **not** contain multimodal rules that matched but lost precedence.

---

## B.11 Exact evidence tier

Replace the previous `strong` label with:

```ts
type EvidenceTier =
  | "corroborated"
  | "moderate"
  | "limited"
  | "insufficient";
```

Rationale: the word `strong` can be read as a clinical-strength or validation-strength assertion. `corroborated` describes the actual V1 structure: multiple independent observational dimensions satisfying deterministic rules.

### Deterministic assignment

Apply in this order:

```text
insufficient if:
  selected pattern == MM-06
  OR selected pattern == MM-07
  OR a required comparison input is unavailable

corroborated if:
  selected pattern == MM-02
  AND >=2 physiological dimensions active
  AND >=3 supporting modalities with quality == good
  AND the same multimodal condition persisted for >=3 consecutive windows
  AND no contradiction

moderate if:
  selected pattern == MM-02
  AND >=2 physiological dimensions active
  AND >=2 supporting modalities with quality >= usable
  AND the same multimodal condition persisted for >=2 consecutive windows
  AND no contradiction

moderate if:
  selected pattern == MM-08
  AND >=3 supporting modalities with quality == good

limited otherwise when:
  the selected pattern is MM-01, MM-03, MM-04, or MM-05
  OR one supporting modality is available
  OR any key supporting modality has quality == limited
```

A no-change MM-08 result is `moderate` only when at least 3 modalities are good and the baseline has been ready for the full observation period; otherwise it is `limited`.

There is no numeric confidence or probability.

---


# 4. Final data structures and result contracts

## C.1 Core enums

```ts
export type AnalysisModality =
  | "ecg"
  | "ppg"
  | "gsr"
  | "imu"
  | "temperature";

export type AnalysisQualityState =
  | "good"
  | "usable"
  | "limited"
  | "unavailable";

export type EvidenceTier =
  | "corroborated"
  | "moderate"
  | "limited"
  | "insufficient";

export type RuleStatus =
  | "fired"
  | "not_fired"
  | "ineligible";

export type ThresholdSource =
  | "hardware"
  | "literature"
  | "prototype_heuristic"
  | "baseline_derived";
```

## C.2 Window reference

```ts
export interface AnalysisWindowRef {
  start_us: number;          // absolute ESP32 esp_timer_us timestamp
  end_us: number;            // absolute ESP32 esp_timer_us timestamp
  start_ms: number;           // epoch-relative analysis-grid coordinate
  end_ms: number;             // epoch-relative analysis-grid coordinate
  duration_ms: 10_000;
}
```

`start_us` and `end_us` are derived from the epoch's fixed `esp_anchor_us`, not from the epoch-relative `start_ms`/`end_ms` values alone and not from browser or backend arrival time. The duration type is a literal `10_000` so V1 result construction cannot accidentally emit a partial window.

## C.3 Quality

```ts
export interface ModalityQuality {
  state: AnalysisQualityState;
  sample_count: number;
  expected_sample_count: number;
  coverage_fraction: number;
  max_gap_ms: number | null;
  packet_gap: boolean;
  reason_codes: string[];
}
```

`coverage_fraction` is always in `[0,1]`.

## C.4 Baseline

```ts
export type BaselineFeatureState =
  | "building"
  | "ready"
  | "incomplete";

export interface FeatureBaseline {
  state: BaselineFeatureState;
  eligible_window_count: number;
  median: number | null;
  mad: number | null;
}

export interface ModalityBaselineState {
  modality: AnalysisModality;
  state: BaselineFeatureState;
  features: Record<string, FeatureBaseline>;
}

export interface BaselineSummary {
  collection_complete: boolean;
  ready_modality_count: number;
  ready_modalities: AnalysisModality[];
  modality_states: Record<AnalysisModality, ModalityBaselineState>;
}
```

The concrete implementation uses typed feature keys internally; `Record<string, FeatureBaseline>` is acceptable here because baseline storage is explicitly keyed by the finite feature identifiers defined by each modality feature interface. No caller is permitted to insert arbitrary feature names at runtime.

## C.5 Baseline relation

```ts
export interface BaselineRelation {
  delta: number | null;
  percent_change: number | null;
  robust_z: number | null;
}
```

Semantics:

- `delta` uses the feature's native unit;
- `percent_change` is used for HR/PR/temperature where meaningful;
- `robust_z` is used for GSR;
- unused relations are `null`.

## C.6 Concrete modality features

```ts
export interface EcgFeatures {
  beat_count: number;
  heart_rate_bpm: number | null;
  rr_interval_ms: number | null;       // median valid RR in current window
  rr_mean_ms: number | null;
  rr_std_ms: number | null;
  ecg_range_adc: number | null;
  lead_off_fraction: number;
}

export interface PpgFeatures {
  pulse_count: number;
  pulse_rate_bpm: number | null;
  pulse_interval_ms: number | null;    // median valid IBI in current window
  pulse_interval_mean_ms: number | null;
  pulse_interval_std_ms: number | null;
  pulse_amplitude_raw: number | null;
  ppg_red_mean: number | null;
  ppg_ir_mean: number | null;
  ppg_red_std: number | null;
  ppg_ir_std: number | null;
}

export interface GsrFeatures {
  gsr_raw_mean: number | null;
  gsr_raw_min: number | null;
  gsr_raw_max: number | null;
  gsr_raw_range: number | null;
  gsr_raw_std: number | null;
  gsr_raw_delta_from_baseline: number | null;
  gsr_raw_slope_raw_per_s: number | null;
  gsr_robust_z: number | null;
}

export interface ImuFeatures {
  acceleration_magnitude_g_mean: number | null;
  acceleration_magnitude_g_std: number | null;
  motion_index_g: number | null;
  gyro_magnitude_dps_mean: number | null;
  movement_level: "low" | "moderate" | "high" | null;
}

export interface TemperatureFeatures {
  temperature_mean_c: number | null;
  temperature_min_c: number | null;
  temperature_max_c: number | null;
  temperature_delta_c: number | null;
  temperature_slope_c_per_min: number | null;
}
```

## C.7 Per-modality result

```ts
export interface ModalityFeatureMeta {
  unit: string;
  valid: boolean;
  baseline: BaselineRelation | null;
}

export interface RuleEvaluation {
  rule_id: string;
  status: RuleStatus;
  inputs: Record<string, number | string | boolean | null>;
  evidence: string[];
  threshold_source: ThresholdSource;
}

export interface EcgAnalysisResult {
  modality: "ecg";
  quality: ModalityQuality;
  features: EcgFeatures;
  feature_meta: Record<keyof EcgFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export interface PpgAnalysisResult {
  modality: "ppg";
  quality: ModalityQuality;
  features: PpgFeatures;
  feature_meta: Record<keyof PpgFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export interface GsrAnalysisResult {
  modality: "gsr";
  quality: ModalityQuality;
  features: GsrFeatures;
  feature_meta: Record<keyof GsrFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export interface ImuAnalysisResult {
  modality: "imu";
  quality: ModalityQuality;
  features: ImuFeatures;
  feature_meta: Record<keyof ImuFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export interface TemperatureAnalysisResult {
  modality: "temperature";
  quality: ModalityQuality;
  features: TemperatureFeatures;
  feature_meta: Record<keyof TemperatureFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export type AnyModalityAnalysisResult =
  | EcgAnalysisResult
  | PpgAnalysisResult
  | GsrAnalysisResult
  | ImuAnalysisResult
  | TemperatureAnalysisResult;

export type ModalityResults = {
  ecg: EcgAnalysisResult;
  ppg: PpgAnalysisResult;
  gsr: GsrAnalysisResult;
  imu: ImuAnalysisResult;
  temperature: TemperatureAnalysisResult;
};
```

## C.8 Multimodal result

```ts
export type MultimodalPattern =
  | "Cardiovascular measurement disagreement"
  | "Cardiovascular change co-occurred with elevated movement"
  | "Multi-modality physiological change observed"
  | "Isolated cardiovascular change observed"
  | "Isolated electrodermal change observed"
  | "Isolated local skin-temperature change observed"
  | "No material change from session baseline observed"
  | "Insufficient evidence for multimodal interpretation";

export interface MultimodalAnalysisResult {
  pattern: MultimodalPattern;
  evidence_tier: EvidenceTier;
  supporting_modalities: AnalysisModality[];
  contradicting_modalities: AnalysisModality[];
  rule_ids: string[];
  explanation: string;
}
```

## C.9 Source trace

```ts
export interface AnalysisSourceTrace {
  first_packet_seq: number | null;
  last_packet_seq: number | null;
  packet_count: number;
  packet_gap_count: number;
  truncated_packet_count: number;
  modalities_present: AnalysisModality[];
  discarded_out_of_order_samples: number;
  analysis_input_gap_count: number;
}
```

## C.10 Final `AnalysisResult`

```ts
export interface AnalysisResult {
  type: "analysis_update";
  session_id: string;
  device_id: string;
  boot_id: string;
  epoch_id: string;

  analysis_version: string;
  conversion_version: string;
  feature_version: string;
  rule_version: string;

  created_at_ms: number;
  window: AnalysisWindowRef;
  source: AnalysisSourceTrace;

  baseline_ready: boolean;
  baseline: BaselineSummary;

  modality_results: ModalityResults;
  multimodal_result: MultimodalAnalysisResult;
  rules_triggered: string[];
}
```

### Result serialization

- JSON only.
- `null` means “feature unavailable/not computable for this window”; do not serialize `NaN` or `Infinity`.
- Timestamps are integer milliseconds/microseconds as named.
- Feature units are fixed strings from the table below.

| Field family | Unit |
|---|---|
| `heart_rate_bpm`, `pulse_rate_bpm` | `bpm` |
| RR/IBI intervals | `ms` |
| ECG range | `ADC counts` |
| PPG amplitude/counts | `ADC/FIFO counts` |
| GSR raw features | `counts` or `counts/s` |
| IMU acceleration | `g` |
| IMU gyroscope | `deg/s` |
| temperature | `degC` or `degC/min` |

No `Record<string, any>` is used for the public result.

---


# 5. Final state, concurrency, and lifecycle model

## D.1 Serialized analysis queue

The previous report's one-`setImmediate`-per-packet pattern is replaced by a **single serialized bounded queue**.

The reason is not that Node cannot preserve callback creation order; Node documents that multiple `setImmediate()` callbacks are queued in creation order. The problem is that each callback can become an independently scheduled unit while the analysis layer itself can contain asynchronous persistence/result fan-out, making packet lifecycle ordering harder to reason about. The single queue gives the analysis state machine one explicit serial execution point. [W7]

### Queue contract

```ts
interface AnalysisWorkItem {
  packet: AcceptedObjectivePacket;
}

class SerializedAnalysisQueue {
  readonly capacity = 1000;

  enqueue(packet: AcceptedObjectivePacket): boolean;
  getDepth(): number;
  close(): void;
}
```

### Enqueue policy

The `AcceptedPacketBus` subscriber does exactly:

```ts
if (!queue.enqueue(packet)) {
  analysisMetrics.queueDrops += 1;
  markAnalysisDegraded();
}
```

No feature extraction, DB write, or WebSocket send occurs in the subscriber.

The queue capacity is 1000 accepted packets. At the current ~10 packet/s input rate this represents about 100 s of queued packet count under sustained analysis lag, while keeping memory bounded. [P1]

### Drop policy when full

**Drop the newest packet for analysis.**

Do not evict older queued packets.

Record:

```text
queue_drops += 1
analysis_input_gap_count += 1
```

The dropped packet remains part of raw ingestion and raw persistence; only the derived analysis path loses it.

The next successfully processed packet is not treated as a device sequence gap. It is an analysis-input gap and is recorded separately in the analysis source metadata/status.

### Worker

Use exactly one worker scheduled by `setImmediate`.

Pseudo-behavior:

```ts
function scheduleWorker(): void {
  if (scheduled || running || stopped) return;
  scheduled = true;
  setImmediate(runWorker);
}

async function runWorker(): Promise<void> {
  scheduled = false;
  running = true;

  try {
    for (let i = 0; i < 4 && queue.length > 0; i += 1) {
      const item = queue.shift()!;
      processAcceptedPacket(item.packet); // synchronous deterministic analysis
    }
  } finally {
    running = false;
    if (!stopped && queue.length > 0) scheduleWorker();
  }
}
```

The `4`-packet turn budget prevents an arbitrarily deep backlog from monopolizing one event-loop turn while keeping analysis strictly ordered.

### Exceptions

`processAcceptedPacket` is wrapped by the worker in a top-level `try/catch` per packet.

On exception:

1. increment `windows_failed` only if a window construction had already begun; otherwise increment `packet_processing_failures`;
2. log the failure;
3. mark analysis runtime degraded;
4. do not publish a partial `AnalysisResult`;
5. continue with the next queued packet;
6. never throw back through `AcceptedPacketBus`.

The accepted packet, raw persistence, and device ACK path continue independently because the bus subscriber itself never performs the work synchronously. The existing bus also catches subscriber exceptions. [R1][R2]

### State-commit rule

Pipeline stages that can throw must not partially commit baseline/rule state before result construction succeeds.

Use this order:

```text
read packet
→ normalize samples
→ build candidate windows
→ calculate quality/features into local objects
→ calculate baseline proposal into local object
→ evaluate rules into local object
→ construct complete AnalysisResult(s)
→ commit baseline + persistence counters + rule counters
→ publish result(s)
```

This makes a thrown calculation unable to leave a half-updated rule persistence counter.

---

## D.2 Lifecycle state machine

### Conceptual states

```text
NO_SESSION
    ↓ first accepted packet
ACTIVE_SESSION / ACTIVE_EPOCH
    ↓ first 10 s window
BASELINE_BUILDING
    ↓ collection closes and required feature baselines exist
BASELINE_READY or BASELINE_INCOMPLETE
    ↓ every completed window
WINDOW_ANALYSIS
    ↓ session stop requested
SESSION_STOPPING
    ↓ queued packets for session drained
SESSION_ENDED
```

There is not a separate persistent state object for `NO_SESSION`; the absence of a session key represents that state.

### Exact transitions

| Current | Event | Next | Action |
|---|---|---|---|
| NO_SESSION | first accepted packet for session/epoch | ACTIVE_SESSION / ACTIVE_EPOCH | create buffers, detectors, scheduler, baseline state |
| ACTIVE_SESSION | time reaches first complete 10 s window | BASELINE_BUILDING | emit first window and begin baseline accumulation |
| BASELINE_BUILDING | complete window before 60 s | BASELINE_BUILDING or BASELINE_READY | update eligible baseline features; readiness is independent per modality |
| BASELINE_BUILDING | 60 s collection closes with ≥2 rule-relevant physiological modality baselines ready | BASELINE_READY | freeze all baselines; mark incomplete modalities permanently incomplete for this epoch |
| BASELINE_BUILDING | 60 s collection closes with <2 rule-relevant physiological modality baselines ready | BASELINE_INCOMPLETE | freeze all baselines; global `baseline_ready=false`; no later baseline completion in this epoch |
| BASELINE_READY | each complete window | WINDOW_ANALYSIS | run features/rules/multimodal result |
| any active state | new epoch ID | ACTIVE_SESSION / ACTIVE_EPOCH | reset all state, begin new baseline |
| active state | stop requested | SESSION_STOPPING | retain state and drain already accepted packets |
| SESSION_STOPPING | queue contains no more packet for session | SESSION_ENDED | emit no partial final window, free session/epoch state |

### Session-stop integration contract

`ObjectiveSessionManager.stopSession()` remains the session acceptance gate and is not redesigned. It synchronously marks the session `COMPLETED` and removes it from the device's active-session map. The analysis pipeline exposes only the following lifecycle hook to make the handoff explicit:

```ts
interface AnalysisSessionLifecycle {
  requestSessionStop(sessionId: string): void;
}
```

The existing session-stop route calls `requestSessionStop(sessionId)` immediately after `stopSession(sessionId)` returns `{ changed: true }`. It does not call the hook again for an already-completed session. The hook marks that session as `SESSION_STOPPING`; it does not close the shared queue or discard work belonging to any session.

The required ordering is:

```text
session stop requested
        ↓
ObjectiveSessionManager.stopSession() marks COMPLETED/removes active-session gate
        ↓
analysisPipeline.requestSessionStop(sessionId)
        ↓
no newly accepted packets for that completed session enter analysis
        ↓
already queued packets for that session drain in FIFO order
        ↓
no partial final window is emitted
        ↓
per-session/per-epoch analysis state is destroyed
```

Because the `AcceptedPacketBus` subscriber enqueues synchronously during publication, every accepted packet published before the stop transition is either already in the analysis queue or is being handled by its single worker. The pipeline must not free state until no queued or currently processing work item for that session remains. Only a new bus delivery after the stopping marker would be rejected defensively at the enqueue boundary; already-admitted work items continue through `processAcceptedPacket()` and are not rejected. Under the existing live-session gate, such a new delivery should not normally occur.

### Important baseline clarification

`BASELINE_READY` is a convenience conceptual state. The actual runtime retains per-modality baseline readiness because ECG/PPG/GSR/temperature can become ready independently.

A window can therefore have:

```text
ECG baseline ready
PPG baseline ready
GSR baseline incomplete
Temperature baseline incomplete
```

and still have `AnalysisResult.baseline_ready === true` because at least two physiological change modalities are ready.

### Device connect/reconnect

The analysis pipeline is not started merely because the device WebSocket connects. The first accepted packet creates the state. `ObjectiveSessionManager.handleDeviceConnected()` transitions session state to `LIVE` but does not create analysis buffers itself. [R2][R8]

### Backend restart

The current session repository recovers non-completed sessions as `DISCONNECTED`, and a subsequent connection moves the session back to `LIVE`. The current `ObjectiveTimeMapper` starts with no in-memory anchor after a process restart; the next accepted `(session,boot)` packet receives a new epoch. Therefore a backend restart creates a new analysis epoch and the old baseline is not reused. [R5][R8]

---


# 6. Final repository integration

## E.1 Exact files to create

```text
src/objective/analysis/
├── types.ts
├── versions.ts
├── converters.ts
├── statistics.ts
├── windows.ts
├── features.ts
├── quality.ts
├── baseline.ts
├── rules.ts
├── multimodalRules.ts
├── pipeline.ts
└── resultBus.ts

src/objective/analysisResultStore.ts
src/objective/history/analysisHistoryRepository.ts
src/objective/analysisRoutes.ts

tests remain top-level under src/objective/:
src/objective/analysisConverters.test.ts
src/objective/analysisWindows.test.ts
src/objective/analysisFeatures.test.ts
src/objective/analysisQuality.test.ts
src/objective/analysisBaseline.test.ts
src/objective/analysisRules.test.ts
src/objective/analysisPipeline.test.ts
src/objective/analysisPersistence.test.ts
src/objective/analysisHistory.test.ts
```

This file placement intentionally matches the current test script `node --import tsx --test src/objective/*.test.ts`. No package-script expansion is required. [R6]

## E.2 Exact responsibility of each module

### `analysis/types.ts`

All public and internal analysis TypeScript interfaces and enums.

No SQL.

No HTTP.

### `analysis/versions.ts`

```ts
export const ANALYSIS_VERSION = "analysis-1.0";
export const CONVERSION_VERSION = "conversion-1.0";
export const FEATURE_VERSION = "feature-1.0";
export const RULE_VERSION = "rules-1.0";
```

### `analysis/converters.ts`

Pure raw-to-analysis-ready conversion functions:

```ts
convertEcgSample()
convertPpgSample()
convertGsrSample()
convertImuSample()
convertTemperatureSample()
```

Current conversion policy remains:

- ECG raw ADC counts only;
- PPG RED/IR counts only;
- GSR raw counts (an ADC-mV engineering value remains internal and is not part of the public result);
- IMU `/16384` and `/131` conversions;
- TMP117 raw × `0.0078125` °C/LSB. [P1][W8][W9]

### `analysis/statistics.ts`

Only low-level deterministic statistical helpers.

### `analysis/windows.ts`

Owns:

- per-session/per-epoch sample buffers;
- packet metadata;
- packet-gap overlap;
- 10 s / 1 s scheduler;
- 15 s pruning.

No feature or rule logic.

### `analysis/features.ts`

Owns modality detector state and feature extraction.

No UI text.

No SQL.

### `analysis/quality.ts`

Owns all quality functions and reason-code constants.

### `analysis/baseline.ts`

Owns 60 s collection, per-feature median/MAD state, readiness and reset.

### `analysis/rules.ts`

Owns exactly ECG-01/02, PPG-01/02, GSR-01, IMU-01, TEMP-01, QUALITY-01.

No generic DSL.

A small typed rule interface is acceptable:

```ts
interface ModalityRule<Input> {
  id: string;
  evaluate(input: Input): RuleEvaluation;
}
```

### `analysis/multimodalRules.ts`

Owns exactly MM-01 through MM-08, including the priority order.

No database, WebSocket, or persistence code.

### `analysis/pipeline.ts`

Owns the serialized analysis state and coordinates:

```text
accepted packet
→ conversion
→ window insertion
→ complete windows
→ quality
→ features
→ baseline
→ modality rules
→ multimodal rules
→ AnalysisResult
→ result bus
```

It also exposes `requestSessionStop(sessionId)` as the lifecycle hook defined in Section D.2. This marks only that session as stopping and finalizes its state after its already-queued work drains.

### `analysis/resultBus.ts`

Synchronous publish/subscribe identical in shape to the current `AcceptedPacketBus`, except the payload is `AnalysisResult`.

Subscriber exceptions are caught and logged so live delivery and storage remain isolated.

### `analysisResultStore.ts`

Asynchronous bounded result-storage worker using the same basic queue/retry isolation pattern already used by `ObjectivePacketStore`. [R9]

### `history/analysisHistoryRepository.ts`

Only historical analysis reads and replay-time mapping.

### `analysisRoutes.ts`

Only HTTP request parsing and response formatting for `/analysis`.

## E.3 `src/index.ts` exact wiring

Current `index.ts` constructs the packet bus, packet store, live gateway, device gateway, status route, and WebSocket router. It must be extended without moving existing ingestion responsibilities. [R3]

Final construction order:

```text
pool
↓
sessionRepository
historyRepository
analysisHistoryRepository
↓
AcceptedPacketBus
↓
ObjectivePacketStore
↓
AnalysisResultBus
↓
LiveGateway(acceptedPacketBus, analysisResultBus)
↓
AnalysisPipeline(acceptedPacketBus, analysisResultBus)
↓
AnalysisResultStore(analysisResultBus, pool)
↓
DeviceGateway(... acceptedPacketBus ...)
```

The current live gateway constructor is extended from:

```ts
createObjectiveLiveGateway(acceptedPacketBus)
```

to:

```ts
createObjectiveLiveGateway(
  acceptedPacketBus,
  analysisResultBus,
)
```

The WebSocket router path remains unchanged.

The existing session route's dependencies are extended with `analysisPipeline: ObjectiveAnalysisPipeline` only for the session-stop lifecycle hook. After `sessionManager.stopSession(sessionId)` returns `changed: true`, the route calls `analysisPipeline.requestSessionStop(sessionId)` before returning the completed-session response. This is a small integration callback; it does not move session ownership into the analysis pipeline or add another service.

## E.4 Device gateway modification

No packet validation, sequence, session, or ACK logic is changed.

No analysis code is inserted into `deviceGateway.ts`.

The only effective integration change is the new downstream subscription created by the analysis pipeline.

The current device gateway's sequence/time-mapped packet publication remains the authoritative analysis input boundary. [R2]

## E.5 Status route modification

Extend `ObjectiveStatusRouteDependencies` with:

```ts
analysisPipeline: ObjectiveAnalysisPipeline;
analysisResultStore: ObjectiveAnalysisResultStore;
```

and return the compact analysis block defined in Section F. The route remains `/api/objective/status`. [R10]

## E.6 Database verification modification

The current `database.ts` explicitly requires only `001_objective_persistence.sql` and verifies only the existing packet/session relations. This is insufficient once the analysis table exists. [R11]

Change to:

```ts
export const REQUIRED_OBJECTIVE_MIGRATIONS = [
  "001_objective_persistence.sql",
  "002_objective_analysis.sql",
] as const;
```

Require all entries to exist in `objective_schema_migrations`.

Verify at startup that at minimum these relations exist:

```text
objective_sessions
objective_sessions_one_non_completed_per_device
objective_packets
objective_packets_pkey
objective_packets_session_received_order
objective_analysis_results
objective_analysis_results_pkey
objective_analysis_results_session_epoch_window
```

The migration runner already discovers every valid `NNN_name.sql` file in lexical order, so creating `002_objective_analysis.sql` requires no special migration-runner feature. [R11][R12]

---


# 7. Final SQL, API, WebSocket, and frontend contracts

## F.1 Final SQL migration

Create `db/migrations/002_objective_analysis.sql` exactly as follows:

```sql
CREATE TABLE objective_analysis_results (
  session_id UUID NOT NULL
    REFERENCES objective_sessions (session_id)
    ON DELETE CASCADE,
  boot_id TEXT NOT NULL,
  epoch_id UUID NOT NULL,

  window_start_us BIGINT NOT NULL,
  window_end_us BIGINT NOT NULL,

  analysis_version TEXT NOT NULL,
  conversion_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,

  created_at_ms BIGINT NOT NULL,
  result JSONB NOT NULL,

  PRIMARY KEY (
    session_id,
    epoch_id,
    window_start_us,
    analysis_version
  ),

  CHECK (window_end_us = window_start_us + 10000000)
);

CREATE INDEX objective_analysis_results_session_epoch_window
  ON objective_analysis_results (
    session_id,
    epoch_id,
    window_start_us
  );
```

### Why `boot_id` and `epoch_id` are both stored

Store both.

- `epoch_id` identifies the analysis/time-mapping domain.
- `boot_id` identifies the physical device boot identity already used by ingestion/replay.
- The combination is useful in diagnostics and historical segmentation.

Neither is used alone as the primary key.

`device_id` is omitted from the table because it is derivable from `objective_sessions.device_id`; the full `AnalysisResult` retains it for transport traceability.

`window_end_us` is stored for direct querying and a database check enforces the exact 10 s window length. It is not part of the idempotency key because it is deterministically derived from `window_start_us`.

## F.2 Persistence identity / idempotency

The exact derived-result identity is:

```text
session_id
+
epoch_id
+
window_start_us
+
analysis_version
```

Insert semantics:

```sql
INSERT ...
ON CONFLICT (
  session_id,
  epoch_id,
  window_start_us,
  analysis_version
)
DO NOTHING
```

This is intentional. PostgreSQL defines `ON CONFLICT DO NOTHING` as the no-op conflict behavior; it is appropriate for immutable versioned derived rows. [W10]

Behavior:

| Case | Result |
|---|---|
| Exact same identity written twice | second write ignored |
| Same window, same epoch, new `analysis_version` | new row inserted |
| Same window, different `rule_version` under same `analysis_version` | treated as an application version-contract error; do not overwrite existing row |
| Same window, different `conversion_version` under same analysis version | application version-contract error; do not overwrite |

Version changes therefore create new derived identities only by changing `analysis_version`. Conversion/feature/rule versions describe the implementation represented by that analysis version.

## F.3 Result store SQL

Use:

```sql
INSERT INTO objective_analysis_results (
  session_id,
  boot_id,
  epoch_id,
  window_start_us,
  window_end_us,
  analysis_version,
  conversion_version,
  feature_version,
  rule_version,
  created_at_ms,
  result
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (
  session_id,
  epoch_id,
  window_start_us,
  analysis_version
)
DO NOTHING
RETURNING 1;
```

The result store counts `rowCount === 0` as `suppressed_duplicates += 1`.

Queue capacity: 1000 results.

Retry delay: 500 ms, matching the current packet-store persistence pattern. [R9]

Queue-full policy: drop newest derived result, increment `storage_drops`, and mark storage degraded. No retry occurs for an item that was never admitted to the queue.

## F.4 Historical API

Endpoint:

```text
GET /api/objective/sessions/:sessionId/analysis
```

Query parameters:

```text
from_ms     optional, default 0, finite number >=0
duration_ms optional, default 30000, 0 < duration <= 60000
analysis_version optional, non-empty <=64 characters; default current ANALYSIS_VERSION
```

The 30 s default and 60 s maximum match the existing replay limits. [P1][R13]

### Validation

- malformed `sessionId` URL encoding → `400`;
- missing session → `404`;
- invalid `from_ms` → `400`;
- invalid `duration_ms` → `400`;
- invalid `analysis_version` → `400`;
- PostgreSQL failure → `503`.

### Historical response

```ts
export interface HistoricalAnalysisEnvelope {
  replay_start_ms: number;
  replay_end_ms: number;
  result: AnalysisResult;
}

export interface HistoricalAnalysisWindow {
  from_ms: number;
  duration_ms: number;
  to_ms: number;
  result_count: number;
  result_cap: 1000;
  capped: boolean;
}

export interface HistoricalAnalysisResponse {
  session: ObjectiveSession;
  window: HistoricalAnalysisWindow;
  results: HistoricalAnalysisEnvelope[];
}
```

### Exact SQL mapping

The repository must map the persisted **absolute ESP32 timestamp** windows onto the existing replay timeline rather than inventing a second clock. The persisted `_us` values are never interpreted as epoch-relative `0`, `10,000,000`, `11,000,000`, ... values; subtract the stored epoch anchor first, then apply the existing backend/replay origin mapping.

Use this structure:

```sql
WITH epoch_anchors AS (
  SELECT
    session_id,
    boot_id,
    epoch_id,
    MIN(esp_anchor_us) AS esp_anchor_us,
    MIN(backend_anchor_ms) AS backend_anchor_ms
  FROM objective_packets
  WHERE session_id = $1
  GROUP BY session_id, boot_id, epoch_id
),
session_origin AS (
  SELECT MIN(
    backend_anchor_ms::double precision + plot_t0_ms
  ) AS origin_wall_ms
  FROM objective_packets
  WHERE session_id = $1
),
positioned AS (
  SELECT
    r.*,
    (
      a.backend_anchor_ms::double precision
      + (r.window_start_us - a.esp_anchor_us)::double precision / 1000.0
      - o.origin_wall_ms
    ) AS replay_start_ms,
    (
      a.backend_anchor_ms::double precision
      + (r.window_end_us - a.esp_anchor_us)::double precision / 1000.0
      - o.origin_wall_ms
    ) AS replay_end_ms
  FROM objective_analysis_results r
  JOIN epoch_anchors a
    ON a.session_id = r.session_id
   AND a.boot_id = r.boot_id
   AND a.epoch_id = r.epoch_id
  CROSS JOIN session_origin o
  WHERE r.session_id = $1
    AND r.analysis_version = $4
)
SELECT ...
FROM positioned
WHERE replay_end_ms > $2
  AND replay_start_ms < $2 + $3
ORDER BY replay_start_ms, epoch_id, window_start_us
LIMIT 1001;
```

Request arguments:

```text
$1 = session_id
$2 = from_ms
$3 = duration_ms
$4 = analysis_version
```

Fetch 1001 rows to detect capping, then return at most 1000.

`replay_start_ms` and `replay_end_ms` are therefore derived from the existing raw-packet replay timeline (`backend_anchor_ms + plot_t0_ms` and its session origin). The frontend consumes these coordinates; it never derives replay positions from browser WebSocket arrival time or `Date.now()`.

### Why overlap, not start-point-only matching

A historical query window can begin in the middle of an analysis window. The correct overlap predicate is:

```text
replay_end_ms   > requested_from
AND
replay_start_ms < requested_to
```

This matches the half-open `[start,end)` interpretation.

### Cursor lookup rule

On the frontend, an analysis envelope contains the cursor whenever:

```text
replay_start_ms <= cursorMs
AND cursorMs < replay_end_ms
```

No stale previous analysis result is shown outside its half-open interval.

## F.5 Historical old-session behavior

When a session predates analysis deployment and has no matching analysis rows for the selected version:

```text
Analysis not available for this interval.
```

Do not silently recompute raw packets during normal review.

A future explicit backfill command can invoke the pure analysis engine, but V1 review does not do so.

## F.6 WebSocket contract

Keep:

```text
/ws/objective/live/:sessionId
```

Add exactly one message type:

```json
{
  "type": "analysis_update",
  "result": { "...": "AnalysisResult" }
}
```

The existing `ready` and `packet` semantics do not change. [R14]

### Live gateway exact behavior

The existing `LiveGateway` uses a session-scoped client map and a 256 KiB `bufferedAmount` threshold. An analysis result uses that same client map and threshold. [R14]

For each `AnalysisResult`:

```text
clients = clientsBySession[result.session_id]
for each client:
  if socket not OPEN -> skip
  if bufferedAmount >= 256 KiB -> increment dropped_analysis and skip
  else send analysis_update
```

No analysis queue is added to each browser connection.

### Broadcast ordering

A live analysis message is **not guaranteed to be adjacent to the packet that caused it**.

The guaranteed ordering is:

1. raw packet messages are emitted by the existing accepted-packet path when packets arrive;
2. analysis messages are emitted in strictly increasing analysis-window order by the serialized analysis worker.

A client must use `result.window.start_ms/end_ms` rather than WebSocket arrival position to understand analysis chronology.

This is a necessary consequence of keeping analysis asynchronous so ingestion/ACK remains isolated.

### Analysis drop behavior

Analysis messages are dropped for slow clients exactly like packet messages.

A dropped analysis message does not backpressure or slow the device ingestion path.

Historical API is the durable source for reviewing missed derived results.

### Reconnect behavior

The current server does not replay missed live messages on WebSocket reconnect.

When the browser reconnects:

- it receives the existing `ready` message;
- the browser clears the live analysis display for the active session until a fresh `analysis_update` arrives;
- no analysis result is inferred from the absence of a message.

The browser can obtain the current historical analysis through the HTTP endpoint.

### Stale result guard

The frontend must ignore an `analysis_update` when:

```text
result.session_id !== state.activeSessionId
OR
result.epoch_id !== state.currentEpochId
OR
result.window.end_ms <= state.lastAnalysisWindowEndMs
```

when the third condition is relevant.

This prevents a late old-epoch or duplicate analysis message from repopulating a cleared UI.

## F.7 Status / health contract

Extend `/api/objective/status` with:

```json
{
  "analysis": {
    "windows_emitted": 0,
    "windows_failed": 0,
    "packet_processing_failures": 0,
    "queue_depth": 0,
    "queue_drops": 0,
    "storage_queue_depth": 0,
    "storage_errors": 0,
    "storage_drops": 0,
    "last_window": {
      "session_id": null,
      "epoch_id": null,
      "end_ms": null
    },
    "baseline": {
      "collection_complete": false,
      "ready_modalities": []
    },
    "pipeline_healthy": true,
    "storage_healthy": true,
    "degraded": false
  }
}
```

`degraded` is:

```text
!pipeline_healthy OR !storage_healthy
```

A historical error counter does not permanently make the system degraded after recovery.

`pipeline_healthy` is false only while the pipeline has an active failure condition or queue-drop degradation state.

`storage_healthy` follows the same recovery semantics as the existing packet store: successful subsequent writes can clear the degraded state even though cumulative error/drop counters remain nonzero. [R9]

No new metrics system is introduced.

## F.8 Frontend integration contract

The current dashboard is plain HTML/CSS/JavaScript and owns live sockets and replay state. Do not add a frontend framework. [R15]

Modify:

```text
public/objective/index.html
public/objective/objective.css
public/objective/objective.js
```

### Live message handling

Add a branch to the existing live WebSocket message handler:

```js
if (message.type === "analysis_update") {
  handleLiveAnalysisUpdate(message.result);
}
```

`handleLiveAnalysisUpdate`:

1. checks session id;
2. checks epoch id;
3. checks monotonic window end;
4. stores the latest live result;
5. renders the analysis panel.

### Session change

On `activeSessionId` change:

```text
clear live analysis result
clear last analysis end timestamp
```

### Epoch change

On packet-driven epoch change:

```text
clear live analysis result
clear last analysis end timestamp
```

This matches the current frontend's existing epoch/boot reset behavior for raw charts. [R15]

### Historical cache

Cache analysis chunks in the existing REVIEW state under a key:

```text
sessionId + analysisVersion + fromMs + durationMs
```

No second replay clock is created.

### Historical cursor

Select the single historical result whose envelope satisfies:

```text
replay_start_ms <= cursorMs < replay_end_ms
```

If none exists:

```text
Analysis unavailable for this point
```

Never retain the previous result after the cursor leaves its interval.

---


# 8. Final deterministic test fixtures

All fixtures are deterministic. No random number generation is permitted.

## G.1 ECG fixtures

### ECG-F01 — clean deterministic beat sequence

- 250 Hz timestamps: exactly 4000 µs apart.
- Construct four periodic QRS-like derivative bursts separated by 800 ms.
- Each burst is 20–80 ms wide.
- Outside bursts, ADC changes are constant small steps.
- Expected: exactly 4 refined beat timestamps after detector warm-up and refractory handling.

### ECG-F02 — known RR sequence

Peak timestamps:

```text
1000
1800
2600
3400
4200
```

RR = `[800,800,800,800] ms`.

Expected:

```text
median RR = 800 ms
HR = 75 bpm
rr_mean_ms = 800
rr_std_ms = 0
```

### ECG-F03 — refractory conflict

Two candidate peaks at:

```text
2000 ms, 2200 ms
```

Second candidate is inside 250 ms.

Case A: first deflection 30, second deflection 40 → second survives.

Case B: both deflection 40 → first survives.

### ECG-F04 — lead-off

- valid samples before lead-off;
- 500 ms of lead-off;
- valid samples after.

Expected:

- no derivative across lead-off;
- no candidate spanning lead-off;
- no RR interval spanning lead-off.

### ECG-F05 — 12 ms gap boundary

Case A:

```text
gap = 12.000 ms
```

Expected: **not** a large-gap reset by the `>` rule.

Case B:

```text
gap = 12.001 ms
```

Expected: reset/discontinuity.

### ECG-F06 — candidate width boundary

Candidate duration:

```text
19.999 ms -> reject
20.000 ms -> accept
200.000 ms -> accept
200.001 ms -> reject
```

### ECG-F07 — RR boundaries

```text
299.999 ms -> invalid
300.000 ms -> valid
2000.000 ms -> valid
2000.001 ms -> invalid
```

### ECG-F08 — window boundary

Beats at:

```text
9.700 s
10.500 s
```

Window `[10,20)s` must use the 9.7 s beat as the prior beat when computing the first 10.5 s RR interval, provided no discontinuity occurred.

### ECG-F09 — adaptive threshold MAD=0

Constant derivative energy after warm-up.

Expected `MAD=0`, `robustSigma=0`, threshold=`medianE`.

### ECG-F10 — out-of-order sample

Inject one sample with timestamp less than the previous valid sample.

Expected: sample discarded, count incremented, no buffer reorder.

---

## G.2 PPG fixtures

### PPG-F01 — regular pulse train

100 Hz timestamps, pulse peaks exactly every 800 ms.

Expected:

```text
pulse rate = 75 bpm
```

after enough pulses for the 3-interval minimum.

### PPG-F02 — strict local maxima

Signal:

```text
10, 12, 15, 12, 10
```

Expected one peak at 15.

### PPG-F03 — plateau

Signal:

```text
10, 15, 15, 10
```

Expected no peak because strict comparisons reject the plateau.

### PPG-F04 — prominence boundary

Construct a candidate with exactly the adaptive minimum prominence.

Expected accepted.

One count below the threshold → rejected.

### PPG-F05 — spacing boundary

Two peaks exactly 300 ms apart → both accepted.

Two peaks at 299.999 ms → conflict resolution keeps only one according to prominence/tie policy.

### PPG-F06 — high motion

Regular valid pulse train plus deterministic IMU fixture classified `high`.

Expected:

- pulse detector still detects pulses;
- PPG quality = `limited`;
- PPG-01 ineligible.

### PPG-F07 — timestamp gap

Gap exactly 25.000 ms → no reset.

Gap 25.001 ms → reset.

### PPG-F08 — window boundary

Pulse at 9.8 s and pulse at 10.6 s.

Window `[10,20)s` uses the 9.8 s pulse as the prior interval anchor if no gap occurred.

### PPG-F09 — no pulses

1000 regular samples with no accepted local maximum.

Expected PPG quality = `unavailable` with `NO_VALID_PULSES`.

---

## G.3 GSR fixtures

### GSR-F01 — flat baseline

Twenty identical raw values.

Expected:

```text
std = 0
slope = 0
MAD = 0
```

### GSR-F02 — exact positive ramp

Times 0–9 s; raw values increase exactly 10 counts/s.

Expected OLS slope exactly `+10 counts/s` within floating-point tolerance.

### GSR-F03 — exact negative ramp

Expected slope exactly negative.

### GSR-F04 — robust-z boundary

Baseline median 100, MAD 10:

```text
robustSigma = 14.826
```

Current mean chosen so robust z is exactly 2.0 → GSR-01 eligible on the z condition when slope >0.

z=1.999 → false.

### GSR-F05 — saturated

Make ≥5% of 1280 expected samples equal to raw rail `2047`.

Expected quality = `limited` with `SATURATED`.

---

## G.4 IMU fixtures

### IMU-F01 — stationary 1 g

```text
ax=0
gay=0
az=16384
```

Expected:

```text
magnitude = 1.0 g
motion_index_g = 0
```

### IMU-F02 — known vector

Use deterministic raw values for which the Euclidean magnitude is calculable exactly enough for an assertion tolerance.

### IMU-F03 — movement boundary

Construct baseline motion median/MAD so that:

```text
motion_index exactly lowThreshold -> moderate
motion_index exactly highThreshold -> high
```

because low is strict `<` while high is `>=`.

### IMU-F04 — no baseline fallback

Before baseline ready, verify fixed `0.03/0.10 g` thresholds are used.

---

## G.5 Temperature fixtures

### TEMP-F01 — stable

All samples identical.

Expected slope 0 and delta 0.

### TEMP-F02 — monotonic deterministic ramp

Known two-minute-equivalent slope expressed across the 10 s window.

Expected OLS slope exactly within tolerance.

### TEMP-F03 — conversion boundary

```text
raw = 128  -> +1.0000 °C
raw = -128 -> -1.0000 °C
```

### TEMP-F04 — quality count boundaries

```text
0 samples  -> unavailable
1 sample   -> limited
9 samples  -> limited
10 samples -> usable
15 samples -> usable
16 samples -> good
```

---

## G.6 Multimodal fixtures

### MM-F01 — ECG-only change

ECG-01 fires; no GSR/TEMP change; no disagreement.

Expected MM-03.

### MM-F02 — GSR-only change

Expected MM-04.

### MM-F03 — temperature-only change

Expected MM-05.

### MM-F04 — ECG + GSR

Both persistent rules fire; movement not high; no disagreement.

Expected MM-02.

### MM-F05 — ECG + GSR + high movement

ECG-01 and GSR-01 fire, IMU-01 fires, movement high.

Expected MM-01, not MM-02.

### MM-F06 — ECG/PPG disagreement plus other changes

ECG-01, PPG-01, GSR-01 all fire but ECG/PPG difference exceeds disagreement threshold.

Expected primary MM-06.

### MM-F07 — insufficient baseline

Baseline not ready, some raw data available.

Expected MM-07 and `insufficient` evidence.

### MM-F08 — fewer than two usable modalities

Expected MM-07.

### MM-F09 — no material change

At least 3 usable modalities, baseline ready, no change rules, no disagreement.

Expected MM-08.

### MM-F10 — evidence precedence

Cases must explicitly assert:

```text
MM-06 beats MM-01
MM-01 beats MM-02
MM-02 beats MM-03/04/05
MM-03/04/05 beat MM-08
MM-08 beats MM-07
```

---

## G.7 Pipeline/concurrency fixtures

### PIPE-F01 — one packet, zero windows

Packet latest sample <10 s.

Expected no result.

### PIPE-F02 — one packet, one window

Packet advances latest time from <10 s to ≥10 s.

Expected exactly window `[0,10)s`.

### PIPE-F03 — one packet, multiple windows

Packet advances latest sample to 12.3 s.

Expected windows ending at 10 s, 11 s, and 12 s, in order.

### PIPE-F04 — out-of-order packet sample

Expected sample dropped and source trace count incremented.

### PIPE-F05 — queue ordering

Enqueue packet sequences 1,2,3,4 quickly.

Expected processing order 1,2,3,4.

### PIPE-F06 — queue full

Fill 1000 packet queue entries, then enqueue packet 1001.

Expected:

```text
accepted packet remains valid/ingested
analysis queue drop += 1
packet 1001 not analyzed
raw persistence unaffected
```

### PIPE-F07 — failure isolation

Inject a deterministic feature exception for one packet.

Expected:

```text
analysis packet failure increments
worker continues
subsequent packet processed
AcceptedPacketBus publish still returns
raw packet persistence subscriber still executes
```

### PIPE-F08 — session stop with queued packets

Queue packets A,B,C, request session stop before worker drains them.

Expected A,B,C process; no new packets accepted after stop; no partial final window emitted; state is destroyed only after the session's queued packets are drained.

---

## G.8 Persistence fixtures

### DB-F01 — exact duplicate

Insert identical identity twice.

Expected one row.

### DB-F02 — new analysis version

Insert same window with `analysis_version = analysis-2.0`.

Expected two rows coexist.

### DB-F03 — foreign key

Insert nonexistent session id.

Expected DB foreign-key failure.

### DB-F04 — historical overlap

Create a 10 s analysis window and query a 1 s range in its middle.

Expected result returned because intervals overlap.

### DB-F05 — boundary exclusion

Query starts exactly at an analysis window's end.

That window must not be returned by overlap filtering.

### DB-F06 — bounded query

Create >1000 analysis rows and request a 60 s query.

Expected `result_cap=1000` and `capped=true` only when >1000 rows are actually selected.

---


# 9. Physical validation and calibration checklist

## H.1 Software-validatable

These do not require the hardware:

```text
raw-to-analysis conversions
sample timestamp arithmetic
window boundaries
multiple-window emission
buffer pruning
ECG candidate logic
ECG refractory logic
ECG RR validity
PPG local maxima
PPG prominence
PPG spacing
GSR statistics/slope
IMU scale arithmetic
TMP117 conversion arithmetic
quality state precedence
baseline state machine
rule thresholds
rule persistence
multimodal precedence
evidence tier
AnalysisResult serialization
queue ordering
failure containment
WebSocket message shape
historical SQL mapping logic
idempotent insertion
```

## H.2 Physically validatable

Only the following require real sensor hardware or real logged hardware data.

### ECG

1. Verify the physical AD8232 breakout variant.
2. Verify lead-off pins actually report the board's LO+/LO- behavior.
3. Measure observed ECG sample rate and timestamp jitter.
4. Record real ECG while stationary.
5. Verify detector beat timestamps against the recorded waveform by visual inspection.
6. Verify a known acquisition interruption creates the expected analysis quality behavior.
7. Do not approve any absolute mV conversion until ADC attenuation/calibration and breakout gain are documented.

The current firmware uses raw `analogRead()` ADC counts at 12-bit resolution and does not expose the calibration metadata needed to justify a universal backend mV conversion. [R7][W8][W11]

### PPG

1. Verify actual MAX30101 board/module.
2. Verify actual LED/sample configuration remains the firmware configuration.
3. Measure observed 100 Hz data rate and timestamp behavior.
4. Record stationary PPG and verify pulse detector timestamps.
5. Record deterministic motion and verify quality becomes `limited` under the defined IMU motion classification.
6. Do not add SpO2 until a validated algorithm/calibration path is separately established. [P1][W4][W5]

### GSR

1. Verify exact legacy TinyGSR board revision.
2. Verify `protocentral_TLA20xx` library behavior and ADC code semantics.
3. Measure observed GSR rate.
4. Feed a known resistor network and record raw ADC response.
5. Verify positive/negative response direction.
6. Do not label the result as absolute `µS` without board-specific calibration.

The previous report identified the legacy TinyGSR's trimpot-dependent analog front end as the key reason absolute conductance remains unresolved. [P1][W6]

### IMU

1. Place the sensor stationary on each principal orientation.
2. Verify acceleration magnitude is approximately 1 g in each orientation.
3. Record zero-rate gyroscope bias while stationary.
4. Verify the expected axis/sign conventions.
5. Verify observed sampling around 100 Hz.

The current firmware configuration is ±2 g and ±250 °/s, yielding 16384 LSB/g and 131 LSB/(°/s). [R7][W9]

### Temperature

1. Verify TMP117 register conversion against known raw codes.
2. Verify observed ~2 Hz sampling.
3. Verify placement on the wearable and contact consistency.
4. Check thermal self-heating / PCB coupling qualitatively.
5. Verify local-temperature trend behavior over minutes, not instantaneous spikes.

TMP117 uses a 16-bit signed result with 0.0078125 °C/LSB in the current conversion path. [R7][W8]

### End-to-end timing

Use a real log to verify:

```text
ECG observed rate
PPG observed rate
GSR observed rate
IMU observed rate
TMP117 observed rate
packet span
sequence gaps
sample timestamp gaps
PPG timestamp corrections observed in firmware
backend epoch creation
analysis window emission timing
```

The first implementation does not require clinical validation; the target is engineering correctness of the acquisition-to-analysis pipeline.

---


# 10. Final ready-to-code checklist

Every item below is now resolved unless explicitly marked as a physical dependency.

## Data representation

- [x] **RESOLVED** — Canonical analysis sample timestamps use existing ESP-derived packet timestamps.
- [x] **RESOLVED** — ECG remains in ADC counts.
- [x] **RESOLVED** — PPG remains in RED/IR counts.
- [x] **RESOLVED** — Legacy GSR remains in raw/proxy domain.
- [x] **RESOLVED** — IMU uses `/16384` and `/131` engineering conversions.
- [x] **RESOLVED** — TMP117 uses `raw * 0.0078125` °C.
- [x] **RESOLVED** — No missing-value interpolation.
- [x] **RESOLVED** — Public `AnalysisResult` uses concrete TypeScript feature interfaces.

## Timestamp handling

- [x] **RESOLVED** — Sample intervals are half-open `[start,end)`.
- [x] **RESOLVED** — Sample at exact window end is excluded.
- [x] **RESOLVED** — Out-of-order analysis samples are dropped, not sorted.
- [x] **RESOLVED** — Packet gaps and sample gaps are tracked separately.
- [x] **RESOLVED** — Epoch change resets all analysis state.

## Windowing

- [x] **RESOLVED** — 10,000 ms window.
- [x] **RESOLVED** — 1,000 ms emission step.
- [x] **RESOLVED** — First emission ends at epoch +10,000 ms.
- [x] **RESOLVED** — One packet can emit multiple complete windows.
- [x] **RESOLVED** — Complete all-unavailable windows are emitted.
- [x] **RESOLVED** — Partial final stop window is never emitted.

## Buffering

- [x] **RESOLVED** — Per-modality monotonic arrays with head-index pruning.
- [x] **RESOLVED** — 15 s sample retention.
- [x] **RESOLVED** — No third-party time-series library.

## ECG detection

- [x] **RESOLVED** — Detector state is retained across windows.
- [x] **RESOLVED** — Lead-off samples are excluded.
- [x] **RESOLVED** — Large ECG gap is `>12 ms`.
- [x] **RESOLVED** — Derivative is adjacent-sample ADC difference.
- [x] **RESOLVED** — Energy smoothing is causal 20-sample mean.
- [x] **RESOLVED** — Threshold context is causal 10 s / 2500 smoothed samples.
- [x] **RESOLVED** — Threshold is `median + 4 * 1.4826 * MAD`.
- [x] **RESOLVED** — Threshold warm-up is 1 s.
- [x] **RESOLVED** — Candidate duration is 20–200 ms inclusive.
- [x] **RESOLVED** — Candidate runs are not merged.
- [x] **RESOLVED** — Peak refinement is ±40 ms around derivative-energy seed.
- [x] **RESOLVED** — Refinement maximizes absolute deflection from local median.
- [x] **RESOLVED** — Refractory interval is 250 ms.
- [x] **RESOLVED** — Refractory conflict keeps larger deflection, ties keep earlier beat.
- [x] **RESOLVED** — RR validity is 300–2000 ms inclusive.
- [x] **RESOLVED** — RR intervals crossing gaps/lead-off are rejected.
- [x] **RESOLVED** — First in-window RR uses prior retained beat.

## PPG detection

- [x] **RESOLVED** — IR is the primary pulse channel.
- [x] **RESOLVED** — Smoothing is causal 3-sample mean.
- [x] **RESOLVED** — Threshold context is 10 s.
- [x] **RESOLVED** — Peak warm-up is 1 s.
- [x] **RESOLVED** — Local maxima are strict three-point maxima.
- [x] **RESOLVED** — Plateaus are rejected.
- [x] **RESOLVED** — Trough lookback is 600 ms.
- [x] **RESOLVED** — Minimum prominence is `max(1, 2*1.4826*MAD)`.
- [x] **RESOLVED** — Minimum peak spacing is 300 ms.
- [x] **RESOLVED** — Peak conflicts keep larger prominence, ties keep earlier peak.
- [x] **RESOLVED** — IBI validity is 300–2000 ms inclusive.
- [x] **RESOLVED** — High motion changes PPG quality, not the detector signal.
- [x] **RESOLVED** — Detector state is retained across windows.

## Feature calculation

- [x] **RESOLVED** — HR uses median valid RR.
- [x] **RESOLVED** — PR uses median valid IBI.
- [x] **RESOLVED** — Population SD is used for short-window interval SD.
- [x] **RESOLVED** — ECG range uses nearest-rank P95−P5.
- [x] **RESOLVED** — GSR slope uses OLS in seconds.
- [x] **RESOLVED** — Temperature slope uses OLS in minutes.
- [x] **RESOLVED** — IMU motion index is median `|magnitude−1|`.

## Quality

- [x] **RESOLVED** — Four states only: good/usable/limited/unavailable.
- [x] **RESOLVED** — Expected counts are 2500/1000/1280/1000/20.
- [x] **RESOLVED** — Large-gap thresholds are fixed per modality.
- [x] **RESOLVED** — PPG zero valid intervals = unavailable; one/two = limited.
- [x] **RESOLVED** — Quality precedence is unavailable → limited → good → usable.
- [x] **RESOLVED** — Exact reason-code order is fixed.

## Baseline

- [x] **RESOLVED** — Baseline collection lasts only first 60 s.
- [x] **RESOLVED** — At least 4 eligible windows are required per rule-relevant feature.
- [x] **RESOLVED** — No late baseline completion after collection closes.
- [x] **RESOLVED** — Baselines use median + MAD.
- [x] **RESOLVED** — Baselines freeze after collection.
- [x] **RESOLVED** — Baselines reset per epoch.
- [x] **RESOLVED** — Per-modality readiness is explicit.
- [x] **RESOLVED** — Global `baseline_ready` means at least two physiological change modalities have rule-relevant baselines.
- [x] **RESOLVED** — MAD=0 is preserved exactly; no artificial spread is stored.

## Rules

- [x] **RESOLVED** — ECG-01 threshold is `>=15%`, two consecutive eligible windows.
- [x] **RESOLVED** — ECG-02 fires on present-but-insufficient ECG beat evidence.
- [x] **RESOLVED** — PPG-01 threshold is `>=15%`, two consecutive eligible windows.
- [x] **RESOLVED** — PPG-02 is strict `>` against `max(10 bpm,10%)` threshold.
- [x] **RESOLVED** — GSR-01 is `robust_z>=2` AND slope `>0`, two consecutive windows.
- [x] **RESOLVED** — IMU-01 is high movement, with fixed pre-baseline fallback thresholds.
- [x] **RESOLVED** — TEMP-01 is `abs(delta)>=0.5°C`, three consecutive windows.
- [x] **RESOLVED** — Persistence counters reset on false or ineligible windows.

## Multimodal precedence

- [x] **RESOLVED** — Exactly one primary multimodal pattern is selected.
- [x] **RESOLVED** — MM-06 has highest priority.
- [x] **RESOLVED** — MM-01 outranks MM-02 when movement is high.
- [x] **RESOLVED** — MM-02 requires the same multimodal condition for two consecutive windows.
- [x] **RESOLVED** — MM-07 is the insufficient-evidence fallback.
- [x] **RESOLVED** — MM-08 is the baseline-like fallback only after baseline readiness and ≥3 usable modalities.

## Evidence tier

- [x] **RESOLVED** — Numeric confidence does not exist.
- [x] **RESOLVED** — `strong` is replaced by `corroborated`.
- [x] **RESOLVED** — Tier assignment is deterministic and non-probabilistic.

## Concurrency

- [x] **RESOLVED** — Analysis uses a single serialized bounded packet queue.
- [x] **RESOLVED** — Queue capacity is 1000 packets.
- [x] **RESOLVED** — Queue-full policy drops newest analysis input only.
- [x] **RESOLVED** — One worker processes packets in order.
- [x] **RESOLVED** — Worker processes at most 4 packets per event-loop turn.
- [x] **RESOLVED** — Analysis errors never reject accepted packets or affect ACK.
- [x] **RESOLVED** — State commits occur only after a full result is constructed.

## Analysis lifecycle

- [x] **RESOLVED** — State is keyed by `(session_id,epoch_id)`.
- [x] **RESOLVED** — First accepted packet creates runtime analysis state.
- [x] **RESOLVED** — Epoch changes reset detector, windows, baseline and persistence state.
- [x] **RESOLVED** — Session stop drains already-accepted packets.
- [x] **RESOLVED** — Session stop does not emit partial windows.
- [x] **RESOLVED** — State is freed only after queued packets for that session drain.
- [x] **RESOLVED** — Backend restart creates a new analysis epoch via the existing mapper lifecycle.

## WebSocket

- [x] **RESOLVED** — Existing `/ws/objective/live/:sessionId` is reused.
- [x] **RESOLVED** — `analysis_update` is the only new message type.
- [x] **RESOLVED** — Analysis uses the same 256 KiB slow-client threshold.
- [x] **RESOLVED** — Analysis delivery is best-effort and can be dropped.
- [x] **RESOLVED** — Analysis chronology is taken from window timestamps, not message adjacency.
- [x] **RESOLVED** — Client rejects stale session/epoch/window results.

## Database persistence

- [x] **RESOLVED** — One derived table only.
- [x] **RESOLVED** — No raw schema modification.
- [x] **RESOLVED** — Primary key is `(session_id,epoch_id,window_start_us,analysis_version)`.
- [x] **RESOLVED** — Duplicate same-version results are ignored.
- [x] **RESOLVED** — Version changes coexist as separate rows.
- [x] **RESOLVED** — `boot_id` and `epoch_id` are both stored.
- [x] **RESOLVED** — Historical endpoint defaults to current analysis version.
- [x] **RESOLVED** — Old versions remain in DB but are requested explicitly.

## Historical retrieval

- [x] **RESOLVED** — New endpoint is `/api/objective/sessions/:sessionId/analysis`.
- [x] **RESOLVED** — 30 s default / 60 s maximum.
- [x] **RESOLVED** — Query uses half-open interval overlap.
- [x] **RESOLVED** — Repository returns replay start/end coordinates.
- [x] **RESOLVED** — Frontend uses the existing replay clock.
- [x] **RESOLVED** — No automatic historical recomputation.

## Testing

- [x] **RESOLVED** — Analysis test files remain top-level under `src/objective/`.
- [x] **RESOLVED** — No random fixtures.
- [x] **RESOLVED** — Boundary values are explicitly tested.
- [x] **RESOLVED** — Concurrency/failure isolation is tested.
- [x] **RESOLVED** — Historical overlap/boundary behavior is tested.

## Physical dependencies

These are physical validation/calibration dependencies, not blockers to implementing the specified V1 software. The V1 code proceeds in the documented raw/domain units and deterministic firmware-timestamp assumptions; the claims below remain unavailable until the corresponding hardware work is completed.

- [x] **PHYSICAL VALIDATION DEPENDENCY — does not block V1 software implementation** — Exact ECG breakout gain/filter/ADC calibration is required before exposing any absolute mV representation; implement and report ECG in ADC counts meanwhile.
- [x] **PHYSICAL VALIDATION DEPENDENCY — does not block V1 software implementation** — Absolute legacy TinyGSR conductance calibration is required before exposing any absolute µS representation; raw/proxy GSR features remain implementable and permitted.
- [x] **PHYSICAL VALIDATION DEPENDENCY — does not block V1 software implementation** — Actual observed sensor rates and timestamp jitter must be verified on hardware logs for hardware validation and threshold confidence; deterministic code can be implemented against the documented firmware rates and ESP timestamp domain.
- [x] **PHYSICAL VALIDATION DEPENDENCY — does not block V1 software implementation** — IMU bias and axis orientation require a static hardware test for physical validation of movement interpretation; the documented scale conversion and motion arithmetic remain implementable.
- [x] **PHYSICAL VALIDATION DEPENDENCY — does not block V1 software implementation** — TMP117 wearable placement and self-heating behavior require physical measurement for interpretation/validation; the exact temperature conversion and trend implementation remain available.
- [x] **PHYSICAL VALIDATION DEPENDENCY — does not block V1 software implementation** — PPG optical geometry and physical placement must be documented before treating raw amplitudes as comparable across sessions/devices; raw-count pulse timing and the defined detector remain implementable.

---


# 11. Clinician-facing language and dashboard presentation

## 19.1 Vocabulary boundary

| Concept | Safe V1 wording | Avoid |
|---|---|---|
| raw ECG code | `ECG ADC` | `ECG voltage` unless calibrated |
| heart-rate feature | `Heart rate` / `Heart-rate change detected` | `cardiac stress` |
| RR variability | `RR interval variability` | `HRV` in a 10 s window |
| raw PPG | `PPG RED`, `PPG IR` | `oxygen saturation` |
| pulse-rate feature | `Pulse rate` / `Pulse-rate change detected` | `blood-flow state` |
| GSR raw | `GSR raw` | `stress level` |
| relative GSR | `Increased electrodermal activity relative to session baseline` | `stress detected` |
| IMU | `Movement context` | `agitation`, `impairment` |
| temperature | `Local skin temperature` | `fever`, `hypothermia` |
| combined observation | `Multi-modality physiological change observed` | `clinical episode detected` |
| data problem | `Insufficient data for interpretation` | `patient unstable` |
| ECG/PPG mismatch | `Cardiovascular measurement disagreement` | `ECG wrong` |
| evidence | `Corroborated / Moderate / Limited / Insufficient evidence` | `Confidence 92%` |

## 19.2 GUI evidence hierarchy

For each active pattern the clinician should see:

```text
Observed pattern

Evidence tier

Time window

Supporting signals

Feature values

Baseline-relative changes

Signal quality

Triggered rule IDs
```

Example:

```text
Multi-modality physiological change observed

Evidence: Moderate
Window: T+00:42–T+00:52

Supporting signals:
  ECG — heart-rate change detected
  GSR — increased electrodermal activity relative to baseline

Movement context:
  Low

Rules:
  ECG-01
  GSR-01
  MM-02

Data quality:
  ECG — Good
  PPG — Usable
  GSR — Good
  IMU — Good
  Temperature — Good
```

The GUI should not claim the cause of the pattern.

---


## Existing frontend LIVE/REVIEW integration

The current dashboard is already implemented as plain HTML/CSS/browser JavaScript with uPlot, including:

- five live plots;
- session selection/history;
- a REVIEW mode;
- synchronized replay cursor support;
- bounded replay caching;
- gap markers;
- live/review state. [9][10]

Therefore do **not** introduce React or a new frontend build system for V1.

## 20.1 Minimal HTML changes

In:

```text
public/objective/index.html
```

add one analysis panel containing:

```text
analysis-pattern
analysis-evidence
analysis-window
analysis-supporting-signals
analysis-feature-summary
analysis-quality-summary
analysis-rule-list
```

The panel should remain hidden or show an explicit empty state when no result exists.

## 20.2 Minimal CSS changes

In:

```text
public/objective/objective.css
```

add:

```text
analysis panel hierarchy
status badge styles
quality chips
rule detail styling
review/live visual separation
```

Do not add unsupported “risk meter” or physiological score widgets.

## 20.3 Minimal JavaScript changes

The current `objective.js` already owns live sockets, replay state, uPlot synchronization, gap handling, and session state. [9]

Add:

```text
handleLiveAnalysisUpdate(message)

renderAnalysisResult(result)

fetchHistoricalAnalysis(sessionId, fromMs, durationMs)

renderHistoricalAnalysisAtCursor(replayPositionMs)
```

Do not create a second replay clock.

Do not create a second WebSocket.

## 20.4 Review mode

At each historical replay chunk:

```text
raw packet chunk
+
analysis result chunk
```

are loaded independently but keyed by the same replay time coordinate.

At the replay cursor:

```text
select latest analysis result whose window contains cursor
```

If none exists:

```text
Analysis unavailable for this point
```

rather than showing stale data from the previous window.

---


# 12. Pipeline execution behavior and failure containment

```text
on AcceptedObjectivePacket(packet)
        ↓
enqueue in the single bounded serialized analysis queue
        ↓
one setImmediate-scheduled worker (at most four packets per turn)
        ↓
processAcceptedPacket(packet)
        ↓
expand raw arrays into normalized timestamped samples
        ↓
append to session/epoch buffers
        ↓
record packet sequence/gap/truncation metadata
        ↓
when latest time reaches next 1 s grid point:
        ↓
build [end-10s, end) window
        ↓
quality checks
        ↓
feature extraction
        ↓
baseline comparison
        ↓
modality rules
        ↓
multimodal rules
        ↓
construct AnalysisResult
        ↓
AnalysisResultBus.publish(result)
        ├── live gateway
        └── async result store
```

## Failure containment

If any stage fails:

```text
analysis failure
→ log analysis error
→ mark analysis state degraded
→ skip only the affected analysis result/window
→ ingestion continues
→ raw packet persistence continues
→ packet ACK behavior unchanged
```

No analysis error may:

```text
throw through deviceGateway
reject a packet
prevent ACK
stop raw persistence
close the device socket
corrupt session state
```

---


## Versioning

Use four simple strings:

```ts
export const ANALYSIS_VERSION = "analysis-1.0";
export const CONVERSION_VERSION = "conversion-1.0";
export const FEATURE_VERSION = "feature-1.0";
export const RULE_VERSION = "rules-1.0";
```

## Version meanings

### Conversion version
Changes when a raw-to-engineering conversion changes.

### Feature version
Changes when a feature definition or algorithm changes.

### Rule version
Changes when a threshold, persistence condition, rule wording, or rule combination changes.

### Analysis version
Changes when the whole result structure/interpretation contract changes.

Do not build a model registry.

These four strings are enough for V1 reproducibility.

---


## Historical analysis repository behavior

Recommended functions:

```ts
interface ObjectiveAnalysisRepository {
  getWindow(
    sessionId: string,
    fromMs: number,
    durationMs: number,
  ): Promise<AnalysisResultWindow>;
}
```

The query should:

1. validate session existence in the route;
2. select analysis rows by session;
3. map persisted absolute-ESP analysis timestamps through the corresponding stored epoch anchor and existing replay timeline;
4. compare the resulting session replay time against `from_ms` / `duration_ms`;
5. order by replay time, epoch, window start;
6. return a bounded result set.

The query must use parameters.

No browser-side SQL or raw database exposure is permitted.

---


## Persistence versus recomputation

## Decision: persist results for V1

### Persisted derived analysis advantages

```text
live result == later historical result
```

The clinician reviewing a session sees the same result that was emitted during live monitoring, provided the same analysis version is selected.

It also allows:

```text
quick historical review
rule-version auditing
result provenance
```

### Why raw packets still remain the source of truth

The raw row is immutable and replayable. Analysis results are secondary and can be regenerated by applying the same pure rules to raw data.

### Why V1 should not recompute automatically

Automatic historical recomputation introduces more moving parts:

```text
history query
→ raw reconstruction
→ window reconstruction
→ baseline reconstruction
→ feature calculations
→ rules
```

The raw replay system already works and the analysis result store can make review immediate.

Therefore:

```text
LIVE
→ calculate + persist

REVIEW
→ read persisted analysis

TEST / explicit future backfill
→ run pure analysis engine against raw
```

---


# 13. End-to-end execution trace

The following is an **illustrative packet using the repository's actual schema and field names**. It is not a scenario engine and is not intended as synthetic patient data.

## 26.1 Raw packet

```json
{
  "schema": 1,
  "session_id": "00000000-0000-0000-0000-000000000001",
  "seq": 420,
  "timebase": "esp_timer_us",
  "created_us": 52010000,
  "t0_us": 52000000,
  "t1_us": 52010000,
  "truncated": 0,
  "n": [25, 10, 13, 10, 1],
  "ecg": [
    [0, 2039, 0, 0],
    [4000, 2050, 0, 0]
  ],
  "ppg": [
    [0, 118240, 106832],
    [10000, 118410, 106950]
  ],
  "gsr": [
    [0, 420],
    [7813, 425]
  ],
  "imu": [
    [0, 220, -110, 16350, 18, -7, 3]
  ],
  "temp": [
    [0, 3904]
  ]
}
```

This passes the existing validator only if the packet contains complete valid arrays/counts; the excerpt above is intentionally shortened for readability and is not itself a complete transport frame. The validator remains authoritative. [1]

## 26.2 Sample conversion

Example ECG sample:

```text
sample.dt_us = 4000
packet.t0_us = 52,000,000

sampleTimeUs = 52,004,000
```

Example IMU:

```text
ax_g = 220 / 16384 = 0.0134 g
ay_g = -110 / 16384 = -0.0067 g
az_g = 16350 / 16384 = 0.9979 g

gyro X = 18 / 131 = 0.1374 °/s
```

Example temperature:

```text
temperature_c = 3904 * 0.0078125
               = 30.5 °C
```

## 26.3 Window assembly

Suppose the latest accepted sample time reaches:

```text
T+42.000 s
```

The analysis engine constructs:

```text
[32.000 s, 42.000 s)
```

and gathers all real samples whose canonical timestamps lie inside that interval.

## 26.4 Feature extraction

Suppose the real window produces:

```text
ECG:
  beat_count = 11
  median RR = 820 ms
  heart_rate_bpm = 73.17
  rr_mean_ms = 826.4
  rr_std_ms = 38.1

PPG:
  pulse_count = 10
  median IBI = 815 ms
  pulse_rate_bpm = 73.62

GSR:
  mean = 431 counts
  baseline median = 401 counts
  robust z = 2.2
  slope = +1.9 counts/s

IMU:
  motion_index = 0.017 g
  movement_level = low

Temperature:
  mean = 30.55 °C
  baseline = 30.49 °C
```

## 26.5 Modality rules

```text
ECG-01
  if baseline HR differs by >=15% → not fired in this illustrative window

PPG-01
  if baseline PR differs by >=15% → not fired

PPG-02
  ECG and PPG rates agree closely → not fired

GSR-01
  robust_z >=2
  slope >0
  persistence condition satisfied
  → fired

IMU-01
  movement_level == low
  → not fired

TEMP-01
  |delta| <0.5 °C
  → not fired
```

## 26.6 Multimodal rules

Only one physiological dimension is active:

```text
ELECTRODERMAL = true
CARDIOVASCULAR = false
TEMPERATURE = false
```

Therefore:

```text
MM-04
→ Isolated electrodermal change observed
```

No stress/craving/relapse label is created.

## 26.7 Final `AnalysisResult`

The illustrative window below assumes `esp_anchor_us = 1,000,000,000`: the epoch-relative `42,000,000`–`52,000,000` microsecond grid interval is persisted as absolute ESP timestamps `1,042,000,000`–`1,052,000,000`.

```json
{
  "type": "analysis_update",
  "session_id": "00000000-0000-0000-0000-000000000001",
  "device_id": "ESP32-example",
  "boot_id": "BOOT-example",
  "epoch_id": "epoch-example",
  "analysis_version": "analysis-1.0",
  "conversion_version": "conversion-1.0",
  "feature_version": "feature-1.0",
  "rule_version": "rules-1.0",
  "created_at_ms": 1700000000000,
  "window": {
    "start_us": 1042000000,
    "end_us": 1052000000,
    "start_ms": 42000,
    "end_ms": 52000,
    "duration_ms": 10000
  },
  "source": {
    "first_packet_seq": 411,
    "last_packet_seq": 420,
    "packet_count": 10,
    "packet_gap_count": 0,
    "truncated_packet_count": 0,
    "modalities_present": ["ecg", "ppg", "gsr", "imu", "temperature"]
  },
  "baseline_ready": true,
  "multimodal_result": {
    "pattern": "Isolated electrodermal change observed",
    "evidence_tier": "limited",
    "supporting_modalities": ["gsr"],
    "contradicting_modalities": [],
    "rule_ids": ["GSR-01", "MM-04"],
    "explanation": "Electrodermal activity increased relative to the session baseline while no other physiological change dimension met the V1 rule conditions."
  },
  "rules_triggered": ["GSR-01", "MM-04"]
}
```

## 26.8 Live dashboard path

```text
AnalysisResultBus
      ↓
LiveGateway
      ↓
/ws/objective/live/<sessionId>
      ↓
objective.js
      ↓
analysis panel
```

## 26.9 Historical path

```text
objective_analysis_results
      ↓
ObjectiveAnalysisRepository
      ↓
GET /api/objective/sessions/:sessionId/analysis
      ↓
objective.js REVIEW cache
      ↓
analysis marker + cursor details
```

---


# 14. Performance, latency, and resource model

## 28.1 Event rate

Current nominal sensor rate:

```text
580 sample/s
```

Current packet rate:

```text
~10 packet/s
```

## 28.2 Window workload

One 10 s window contains approximately:

```text
5,800 sensor samples total
```

A 1 s update therefore examines on the order of a few thousand samples.

Even if V1 recomputes statistics over the entire 10 s buffers rather than using every possible incremental optimization, this workload is small for Node.js/TypeScript.

## 28.3 CPU

Recommended V1 approach:

```text
standard event loop
no worker threads
no GPU
no native addon
```

The expensive operations are only:

```text
median/MAD
simple loops
peak scans
```

for at most a few thousand values per analysis update.

## 28.4 Memory

One active session with ~15 s retained samples needs only a small in-process buffer. The precise byte count depends on whether normalized samples use ordinary JS objects or compact typed arrays. There is no need to retain raw-session history in memory because PostgreSQL already owns the durable source.

## 28.5 Latency

The analysis result is not an instantaneous per-sample alarm.

Expected observation latency is approximately:

```text
≤1 s to next analysis step
+
10 s trailing context
+
rule persistence requirement
```

For a two-window rule, the visible rule condition can therefore lag a real change by roughly 1–3 s after enough of the window contains the change.

This is appropriate for a prototype “live analysis” dashboard and should be described as such.

## 28.6 No external message broker

Redis/Kafka/RabbitMQ are unnecessary.

The current architecture already provides:

```text
bounded queues
async persistence
session-scoped WebSocket delivery
```

and the current workload is only ~10 accepted packets/s.

---


# 15. Runtime status and observability

Extend `/api/objective/status` with an optional analysis block:

The exact field names and health semantics are defined in Section F.7; this is only a compact observability view of that same block.

```json
{
  "analysis": {
    "windows_emitted": 123,
    "windows_failed": 0,
    "queue_depth": 0,
    "storage_queue_depth": 0,
    "storage_errors": 0,
    "storage_drops": 0,
    "last_window": {
      "session_id": null,
      "epoch_id": null,
      "end_ms": 42000
    },
    "baseline_ready": true
  }
}
```

Keep this compact.

Do not add Prometheus, OpenTelemetry, or a new metrics backend.

---


## Database/replay consistency

The system now has three related but distinct data classes:

```text
1. raw packets
2. live analysis results
3. historical analysis results
```

Their guarantees are:

| Data | Guarantee |
|---|---|
| accepted raw packet | existing ingestion guarantee; ACK means accepted into backend memory |
| persisted raw packet | asynchronous PostgreSQL write; bounded queue, existing semantics |
| live analysis result | best-effort downstream derived result |
| persisted analysis result | best-effort derived history with explicit versioning |

The important invariant is:

```text
loss of derived analysis must never imply loss/rejection of raw packets
```

---


# 16. Remaining physical/calibration uncertainties

These are physical validation/calibration dependencies that should not be guessed in code; they do not prevent implementation of the documented V1 raw-domain conversions, deterministic timing, features, or rules. They constrain later calibration, cross-device comparability, and physical interpretation.

## 32.1 ECG electrical conversion

Must physically establish:

```text
exact AD8232 breakout variant
external gain network
filter corner frequencies
reference/virtual-ground relationship
ESP32 ADC attenuation
ADC calibration characteristics
```

Until then:

```text
ECG = ADC counts
```

only.

## 32.2 GSR absolute conductance

Must establish:

```text
exact TinyGSR hardware revision
trimmer/gain setting
exact `protocentral_TLA20xx` library version
exact read_adc() code path
```

If absolute µS is required later:

```text
measure known resistors
fit board-specific transfer
store calibration coefficient
```

Do not silently import the newer TinyGSR v3 formula into the legacy board. ProtoCentral explicitly distinguishes the old trimpot-based board from the v3 precision transimpedance design. [22]

## 32.3 PPG physical comparability

Must physically document:

```text
sensor module/board variant
LED supply
optical geometry
skin contact site
mechanical fixation
```

The first implementation should therefore stay in raw-count/domain features and pulse timing.

## 32.4 IMU biases

A static physical test should establish:

```text
zero-rate gyro bias
static acceleration magnitude
axis orientation
```

The exact datasheet conversion is known; the per-unit bias is not.

## 32.5 Temperature placement

Need physical measurement of:

```text
sensor placement
skin contact quality
self-heating behavior
thermal coupling to enclosure/PCB
```

This affects the meaning of the absolute local temperature value even though TMP117's digital conversion is exact.

## 32.6 End-to-end timing

Use actual logs to verify:

```text
ECG observed rate
PPG observed rate
GSR observed rate
IMU observed rate
TMP117 observed rate
packet span
sequence gaps
actual PPG timestamp correction frequency
```

The firmware targets are known; real measured rates should still be displayed as observed runtime facts.

---


## Facts, feature definitions, and prototype heuristics

## Category 1 — hardware/electrical facts

These are evidence-backed and should be treated as fixed for the current build:

```text
ESP32 ADC resolution = 12-bit raw representation
MPU6050 ±2 g = 16384 LSB/g
MPU6050 ±250 °/s = 131 LSB/(°/s)
TMP117 = 0.0078125 °C/LSB
TLA2022 ±0.512 V = 0.25 mV/LSB
MAX30101 = RED/IR optical ADC/FIFO with current-domain ADC scaling
ECG lead-off flags are real AD8232 digital flags
```

The firmware settings provide the actual chosen rates/configuration. [11][14][18][21][24][25]

## Category 2 — physiological feature definitions

Supported by biomedical/technical literature:

```text
heart rate from RR intervals
pulse rate from PPG pulse intervals
EDA terminology / tonic-phasic distinction
motion-artifact relevance to PPG
standardized HRV terminology and limits
```

[19][20][23][26]

## Category 3 — prototype rule thresholds

These include:

```text
15% HR/PR relative change
2 consecutive windows
GSR robust_z >= 2
10 bpm / 10% ECG-PPG disagreement
0.5 °C temperature change
0.03 g / 0.10 g movement thresholds
adaptive beat/pulse detector constants
```

These are explicitly:

```text
engineering-derived prototype heuristics
```

They are not clinical thresholds.

---


## Explicit V1 non-goals

Do not add any of the following merely because the sensor hardware could theoretically support it:

```text
SpO2
clinical ECG diagnosis
atrial fibrillation classification
QT/QTc analysis
clinical HRV report
respiration rate
EDA SCR event counts in µS
stress score
arousal score
intoxication score
withdrawal score
craving score
relapse score
patient risk score
ML classifier
neural network
feature store
Kafka
Redis Streams
microservices
worker pool
GPU processing
advanced adaptive denoising
wavelet denoising
ICA/PCA artifact removal
Kalman filtering
sophisticated PPG motion cancellation
```

Each would require a separate evidence/validation argument and most would violate the current scope.

---


# 17. Exact implementation order

## Step 1 — Freeze the existing transport boundary

Verify and test that no change is made to:

```text
packetValidator
AcceptedPacketBus
DeviceGateway ACK path
packetStore raw persistence
```

## Step 2 — Add analysis data types/version constants

Create:

```text
analysis/types.ts
analysis/versions.ts
```

## Step 3 — Add sample converters

Implement pure hardware conversion functions.

Do not implement any rules yet.

## Step 4 — Add rolling window engine

Implement:

```text
session/epoch state
sample insertion
sample pruning
10 s window
1 s step
packet gap tracking
```

## Step 5 — Add feature calculations

Implement:

```text
ECG beat/HR/RR
PPG pulse/PR
GSR trend
IMU magnitude/motion
temperature statistics
```

## Step 6 — Add quality

Make all feature validity explicit before rules run.

## Step 7 — Add baseline

Implement 60 s fixed within-epoch baseline using median/MAD.

## Step 8 — Add modality rules

Implement ECG, PPG, GSR, IMU-context, and temperature rules exactly as specified.

## Step 9 — Add multimodal rules

Implement the eight deterministic multimodal rules.

## Step 10 — Add `AnalysisResultBus`

Publish only fully formed `AnalysisResult` objects.

## Step 11 — Attach pipeline to `AcceptedPacketBus`

Subscribe the pipeline to enqueue only. The queue's single worker is scheduled with `setImmediate()` and processes FIFO packets with the four-packet turn budget defined in Section D.1.

## Step 12 — Add live delivery

Extend existing `LiveGateway` to broadcast `analysis_update` messages.

## Step 13 — Add analysis persistence

Create:

```text
db/migrations/002_objective_analysis.sql
analysisResultStore.ts
```

with the same bounded asynchronous isolation pattern as raw packet persistence.

## Step 14 — Add historical API

Create:

```text
analysisRoutes.ts
```

and a small analysis repository that maps persisted absolute-ESP result timestamps onto the existing replay timeline.

## Step 15 — Add clinician UI panel

Extend existing `index.html`, `objective.css`, and `objective.js`.

Do not introduce a frontend framework.

## Step 16 — Add deterministic tests

Run all conversion/window/feature/quality/baseline/rule/persistence/failure-isolation tests.

## Step 17 — Run live physical regression

With real ESP32 five-sensor data:

```text
start session
stream
observe analysis updates
verify raw packets persist
stop session
```

## Step 18 — Run historical review

Open the same session in REVIEW and verify:

```text
analysis results align to the same replay timeline
rule IDs are preserved
quality/gaps are preserved
no stale results appear across windows
```

---


# 18. Recommended commit structure

Do not modify the existing completed ingestion/live/replay milestone history. Treat this as a new downstream analysis milestone.

## Commit A — deterministic analysis core

```text
feat(objective-analysis): add deterministic physiological analysis core
```

Scope:

```text
analysis types
converters
windows
features
quality
baseline
modality rules
multimodal rules
unit tests
```

## Commit B — live + persistence

```text
feat(objective-analysis): stream and persist analysis results
```

Scope:

```text
AnalysisResultBus
AcceptedPacketBus integration
analysis result persistence
status additions
live `analysis_update`
backend tests
```

## Commit C — historical review / clinician presentation

```text
feat(objective-analysis): add historical analysis review
```

Scope:

```text
analysis history repository
analysis HTTP API
REVIEW integration
clinician analysis panel
analysis cursor synchronization
```

## Commit D — physical validation

```text
test(objective): validate physiological analysis pipeline
```

Scope:

```text
real sensor stream
conversion validation
feature validation
quality behavior
rule outputs
live stability
historical replay
failure isolation
validation document
```

---
