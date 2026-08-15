# Objective Monitoring — Phase C Specification
## Historical Replay + Clinician Review / Presentation

> **Purpose of this file**
>
> This document defines Milestone C after the physically validated Phase A ingestion boundary and Phase B live/persistence system.
>
> It is intentionally more specific than `OBJECTIVE_MONITORING_GLOBAL_SPEC.md`, but it does not pre-lock implementation trivia that is better decided while preparing each commit packet from the actual repository state.
>
> Phase C must turn the durable Phase-B packet history into a **bounded, synchronized, trustworthy historical review experience**, while materially improving the clinician-facing UI/UX.
>
> This phase is **not** permission to jump into physiological inference, impairment classification, ML, or speculative signal-processing pipelines.
>
> The central goal is:
>
> > make the already-collected raw physiology easy to review, navigate, understand, and demonstrate without misrepresenting gaps, timing, signal meaning, or durability.

---

## 1. Phase Goal

At the end of Phase C, the objective-monitoring prototype should support:

```text
Physical sensors
    ↓
ESP32 V5.3
    ↓
validated ingestion
    ↓
AcceptedPacketBus
    ├──────────────────────────────┐
    ↓                              ↓
live clinician monitoring          PostgreSQL
                                   ↓
                              durable sessions
                                   ↓
                              durable packets
                                   ↓
                         bounded historical read API
                                   ↓
                         synchronized replay engine
                                   ↓
                      clinician historical review UI
```

The clinician should be able to:

```text
use the existing live-monitoring workflow
select a previous persisted monitoring session
see a concise session/data-continuity summary
play / pause / seek through the recorded session
change replay speed
review all five signals on one synchronized timeline
see ingestion gaps as real discontinuities
see stored-history gaps as real discontinuities
see boot/time-epoch boundaries explicitly
focus on an individual signal without losing context
understand data availability and basic acquisition quality
return easily between live monitoring and historical review
```

Phase C should leave the project with a **demonstrable clinician monitoring workstation**, not merely a collection of backend endpoints and plots.

---

## 2. What We Start With

Phase A and Phase B are closed and physically validated.

Current Phase-B closure commit:

```text
4683887
test(objective): validate live persistence and clinician monitoring
```

Authoritative current baseline includes:

```text
firmware/esp32_v5_3_backend_session.ino

src/index.ts
src/objective/acceptedPacketBus.ts
src/objective/deviceGateway.ts
src/objective/deviceRegistry.ts
src/objective/objectiveWebSocketRouter.ts
src/objective/sessionManager.ts
src/objective/sessionRoutes.ts
src/objective/statusRoutes.ts
src/objective/timeMapper.ts

src/objective/persistence/database.ts
src/objective/persistence/migrate.ts
src/objective/persistence/packetStore.ts
src/objective/persistence/sessionRepository.ts

src/objective/live/liveGateway.ts

src/objective/dashboard/dashboardRoutes.ts

public/objective/index.html
public/objective/objective.css
public/objective/objective.js

db/migrations/001_objective_persistence.sql
```

Current browser visualization uses:

```text
plain HTML
CSS
browser JavaScript
local uPlot
```

Current required runtime dependencies are intentionally small:

```text
pg
ws
uplot
```

Do not rebuild Phase A or Phase B inside this phase.

---

## 3. Current Validated Boundary That Must Remain Stable

The validated ingestion path remains:

```text
ESP32 packet
    ↓
device authentication / session binding
    ↓
Schema V1 validation
    ↓
sequence classification
    ↓
time mapping
    ↓
AcceptedPacketBus
    ├── live client fan-out
    └── bounded async PostgreSQL persistence
    ↓
ACK:<seq>
```

Phase C is primarily a **read/presentation phase**.

It must not move historical queries, replay logic, chart work, or processing into the device-ingestion / ACK path.

The following contracts remain authoritative:

```text
ACK means accepted into backend ingestion memory
ACK does not mean PostgreSQL committed

raw Schema V1 remains the source of truth

ESP32 monotonic time remains the canonical
within-epoch signal timing domain

gaps must never be fabricated over

live clients remain downstream-only

PostgreSQL remains the historical source
for replayable accepted packets
```

---

## 4. Phase Principle

The main Phase-C rule is:

> **Read the durable raw history faithfully, reconstruct only the timing information already supported by stored anchors, and make it exceptionally easy for a clinician to inspect.**

Phase C should improve:

```text
historical accessibility
timeline reconstruction
replay usability
visual hierarchy
data-continuity visibility
presentation quality
```

without changing:

```text
sensor acquisition
packet schema
device protocol
ACK semantics
accepted-packet boundary
raw persistence invariant
```

---

## 5. Phase Scope

Implement the minimum complete Milestone-C capability:

1. Historical packet read/query support from PostgreSQL.
2. A bounded replay-manifest API for a persisted monitoring session.
3. A bounded replay packet-window API.
4. A cross-epoch historical replay timeline derived from the existing stored time anchors.
5. Explicit historical detection of:
   - ingestion/transport gaps,
   - missing persisted packet rows,
   - boot changes,
   - time-epoch changes.
6. Synchronized historical replay for all five signal families.
7. Replay controls:
   - play,
   - pause,
   - seek,
   - restart,
   - replay speed.
8. Bounded browser replay buffering / prefetching.
9. A clinician session-review workflow integrated into `/clinician/objective`.
10. A substantially refined clinician-facing information architecture and visual hierarchy.
11. A synchronized replay cursor / shared historical viewport.
12. Clear session summary and data-continuity presentation.
13. Non-clinical, transparent data-quality / acquisition-quality cues.
14. Preservation of the existing live-monitoring workflow.
15. Real-browser validation using real persisted five-sensor data.
16. Final Phase-C validation record.
17. Global milestone closure only after replay and UI validation pass.

---

## 6. Explicitly Out of Scope

Do **not** add during Phase C:

```text
heart-rate estimation
SpO2 estimation
HRV
ECG diagnosis / rhythm classification
EDA tonic/phasic decomposition
SCR event detection
stress score
arousal score
intoxication classification
impairment classification
relapse-risk physiology
clinical decision rules
physiology-triggered alerts
ML inference
training pipelines
feature stores
large signal-processing pipelines
automatic diagnostic labels

patient-profile integration
patient identity on the ESP32
production clinician authentication
mobile application
cross-session clinical comparison
clinician annotations
report generation
CSV/export workflows

Kafka
Redis
microservices
time-series database
per-sample SQL rows
binary transport
precision clock synchronization
offline ESP32 store-and-forward
backend disk/WAL spool

firmware network-queue redesign
historical reconstruction of packets that were never persisted
```

The known ESP32 Wi-Fi/network-queue limitation remains visible as a gap.

Phase C should **show** missing intervals correctly; it should not pretend to recover data that never reached durable history.

---

## 7. Phase Architecture

Target architecture:

```text
                            Node / TypeScript backend

                    ┌─────────────────────────────┐
                    │      existing live path     │
ESP32 → ingestion → AcceptedPacketBus → Live WS  │
                    │                             │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                              PostgreSQL
                                   │
                   objective_sessions / packets
                                   │
                                   ▼
                         Historical Repository
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
             Replay Manifest API          Packet Window API
                    │                             │
                    └──────────────┬──────────────┘
                                   ▼
                         Clinician browser
                                   │
                ┌──────────────────┴──────────────────┐
                │                                     │
                ▼                                     ▼
            LIVE workspace                       REVIEW workspace
                │                                     │
          current stream                      bounded packet windows
                                                      │
                                                      ▼
                                              replay clock / seek
                                                      │
                                                      ▼
                                           synchronized five-signal UI
```

Everything remains inside one normal backend process plus PostgreSQL.

A separate replay service is not justified.

---

## 8. Current Durable History Contract

Current PostgreSQL packet rows already contain:

```text
session_id
boot_id
seq
received_at_ms
sequence_status
gap_before
epoch_id
esp_anchor_us
backend_anchor_ms
plot_t0_ms
raw_packet JSONB
```

with uniqueness:

```text
(session_id, boot_id, seq)
```

and an existing index supporting session-ordered reads:

```text
(session_id, received_at_ms, boot_id, seq)
```

Phase C should read from these existing rows.

Do not duplicate raw packets into a second replay table merely to make the read API look cleaner.

Do not overwrite or rewrite historical `raw_packet`.

---

## 9. Historical Read Boundary

Historical replay must read through a small backend repository/API boundary.

Do not let browser code connect directly to PostgreSQL.

Do not reuse the live WebSocket as a database-replay transport.

Canonical direction:

```text
PostgreSQL
    ↓
Objective Replay / History Repository
    ↓
HTTP replay APIs
    ↓
browser replay engine
```

Historical HTTP reads are intentionally separate from:

```text
/ws/objective/live/:sessionId
```

because live delivery and durable historical completeness have different semantics.

---

## 10. Historical Timeline Model

Within a boot/time epoch, the existing stored time mapping already provides what replay needs.

For a stored packet:

```text
packet_effective_wall_ms =
    backend_anchor_ms
    + plot_t0_ms
```

For the session:

```text
timeline_origin_wall_ms =
    minimum packet_effective_wall_ms
```

Then define historical packet-relative time:

```text
replay_t0_ms =
    packet_effective_wall_ms
    - timeline_origin_wall_ms
```

For an individual sample:

```text
sample_replay_ms =
    replay_t0_ms
    + dt_us / 1000
```

Equivalent conceptual mapping:

```text
sample_esp_us =
    raw_packet.t0_us + dt_us

sample_wall_approx_ms =
    backend_anchor_ms
    + (sample_esp_us - esp_anchor_us) / 1000
```

The browser should receive or derive the simplest equivalent representation.

Do **not** use:

```text
browser receive time
Date.now() during replay
replay-request response time
```

as signal X coordinates.

---

## 11. Meaning of Historical Wall Time

Historical cross-epoch wall-clock placement is **approximate**.

The system does not provide precision wall-clock synchronization.

The correct interpretation is:

```text
within an epoch:
ESP32 monotonic timing preserves relative signal timing

between epochs:
backend time anchors provide an approximate real-world placement
```

The UI may display:

```text
session-relative time
T+00:42.500
```

as the primary replay clock.

It may additionally display approximate wall time for human context.

Do not imply millisecond-accurate absolute synchronization across ESP32 reboots, backend restarts, or unrelated devices.

---

## 12. Boot Epoch vs Time-Mapping Epoch

Phase C should improve the distinction between:

```text
boot_id
epoch_id
```

### `boot_id` changes

Means:

```text
physical ESP32 reboot
```

### `epoch_id` changes while `boot_id` stays the same

Can occur when the backend/time mapper is recreated, for example across backend restart.

That is a new historical time-mapping epoch, but not necessarily a device reboot.

The review UI should therefore distinguish:

```text
Device reboot
```

from:

```text
Time/backend epoch boundary
```

when the stored identities allow the distinction.

Do not label every `epoch_id` change as a physical ESP32 reboot.

---

## 13. Historical Discontinuities Are First-Class Events

Replay must never draw a visually continuous signal across data that is known to be absent.

Phase C must represent at least:

```text
1. ingestion / transport gap
2. stored-history gap
3. time-epoch boundary
4. physical device reboot
```

These may all create visible chart discontinuities, but they should not all be described as the same failure.

---

## 14. Ingestion / Transport Gap

Existing metadata remains authoritative:

```text
gap_before > 0
```

or:

```text
sequence_status == "gap"
```

means the backend itself observed a forward device sequence gap.

This can result from behavior such as:

```text
ESP32 bounded network queue exhaustion
transport loss
device-side send/recovery loss
```

Replay must:

```text
show the missing interval
break the signal line
retain the real following packet timing
not interpolate missing samples
```

The UI should describe this as an ingestion/transport gap, not as a browser problem.

---

## 15. Stored-History Gap

Phase B deliberately has a bounded persistence guarantee.

This means an accepted packet can theoretically be absent from durable history after:

```text
backend process crash after ACK but before INSERT
persistence queue exhaustion / storage drop
other explicit durable-history loss
```

The next stored packet can therefore have:

```text
sequence_status == "normal"
gap_before == 0
```

even though one or more rows are missing from PostgreSQL.

Historical replay must detect this separately.

For consecutive **persisted** packets within the same `boot_id`, conceptually:

```text
persisted_sequence_jump =
    current_seq - previous_persisted_seq - 1
```

Then:

```text
history_gap_before =
    max(
        0,
        persisted_sequence_jump - current_packet.gap_before
    )
```

The exact implementation may use a SQL window function or equivalent repository logic.

The invariant is more important than the exact SQL.

A replay page must not accidentally draw a continuous line across packets missing only from durable storage.

---

## 16. Pagination / Window-Boundary Gap Correctness

Stored-history gap detection must remain correct even when the browser requests only part of a session.

The first packet returned in a replay window must have enough historical context to determine whether stored packet rows are missing immediately before it.

Do not rely solely on:

```text
"compare with the previous packet already loaded in this browser"
```

because arbitrary seek/window requests may start in the middle of a sequence gap.

The backend should expose a replay-safe derived value such as:

```text
history_gap_before
```

or an equivalent explicit discontinuity marker.

---

## 17. Truncated Packets

Historical replay should preserve:

```text
raw_packet.truncated
```

as a data-continuity / packet-quality fact.

A truncated packet is not automatically invalid.

Replay behavior:

```text
render the samples that exist
surface the truncation in session/window quality metadata
do not fabricate the samples that were omitted
```

Do not use `truncated` as a clinical quality judgement.

---

## 18. Replay Manifest API

Provide a small session-level historical manifest.

Canonical direction:

```text
GET /api/objective/sessions/:sessionId/replay
```

The response should be inexpensive relative to returning all raw packets.

Conceptually:

```json
{
  "session": {
    "session_id": "...",
    "device_id": "...",
    "status": "COMPLETED",
    "created_at_ms": 0,
    "completed_at_ms": 0
  },
  "timeline": {
    "origin_wall_ms": 0,
    "duration_ms": 0,

    "packet_count": 0,

    "ingestion_gap_events": 0,
    "ingestion_missing_packets": 0,

    "history_gap_events": 0,
    "history_missing_packets": 0,

    "truncated_packets": 0,

    "boot_count": 0,
    "epoch_count": 0,

    "first_received_at_ms": 0,
    "last_received_at_ms": 0,

    "segments": []
  }
}
```

Reasonable exact naming may differ.

The manifest should provide enough information to build:

```text
session summary
full-session scrubber
gap markers
epoch markers
recorded data span
```

without downloading the full raw session first.

---

## 19. Replay Segment Model

Manifest segments should be based primarily on:

```text
epoch_id
boot_id
```

Conceptually:

```text
ReplaySegment {
  epoch_id
  boot_id

  start_ms
  end_ms

  first_seq
  last_seq

  ingestion gaps
  stored-history gaps
}
```

A new `epoch_id` creates a new visible segment.

A changed `boot_id` should additionally identify the boundary as a physical device reboot.

Do not merge epochs merely because they belong to the same monitoring session.

---

## 20. Replay Packet-Window API

Provide bounded raw historical retrieval.

Canonical direction:

```text
GET /api/objective/sessions/:sessionId/replay/packets
```

with query parameters conceptually equivalent to:

```text
from_ms
duration_ms
```

Recommended initial bounds:

```text
default duration     ~30 seconds
maximum duration     ~60 seconds
hard packet-row cap  ~1000 packets
```

Exact values may be adjusted slightly during implementation if real packet-size measurements justify it.

The response should contain replay-safe historical envelopes, conceptually:

```text
session_id
boot_id
received_at_ms

sequence_status
gap_before
history_gap_before

epoch_id
esp_anchor_us
backend_anchor_ms
plot_t0_ms

replay_t0_ms

raw_packet
```

`raw_packet` remains unchanged.

Do not return derived replacement sample arrays.

---

## 21. Replay Query Semantics

The historical API should:

```text
404 unknown session

return a valid empty manifest
for a known session with zero persisted packets

validate from_ms / duration_ms

reject nonsensical or excessive windows

use parameterized SQL

return packets in a deterministic historical order

keep response size bounded
```

Database read failure should surface as:

```text
503 objective persistence unavailable
```

or equivalent.

Do not silently return partial data as though the request succeeded completely.

If an explicit hard cap truncates a requested result, expose that fact.

---

## 22. Database / Index Strategy

The current schema already has:

```text
objective_packets
PRIMARY KEY (session_id, boot_id, seq)

INDEX
(session_id, received_at_ms, boot_id, seq)
```

Start Phase C by using the current schema.

Do **not** add:

```text
second raw packet table
per-sample table
materialized signal table
time-series database
derived-data table
```

before actual read/query evidence requires it.

A new SQL index or small migration is acceptable **only if** real replay query profiling shows the current index is insufficient for expected prototype sessions.

Do not pre-optimize speculative hours-long workloads.

---

## 23. Replay Repository Boundary

A reasonable internal direction is:

```text
src/objective/replay/
  replayRepository.ts
  replayRoutes.ts
```

Responsibilities:

```text
lookup durable session
build manifest
derive timeline origin
derive epoch/boot segments
derive historical storage-gap metadata
return bounded packet windows
```

Keep:

```text
packetStore.ts
```

focused on asynchronous writes.

Do not turn the write-side packet store into a large read/write persistence god object merely because it already knows the table name.

---

## 24. Historical Replay Semantics

Replay is a visualization of **persisted history**.

It is not:

```text
re-sending packets through AcceptedPacketBus
replaying packets into the live WebSocket
pretending the ESP32 is currently producing them
```

The browser owns a historical playback clock.

Conceptually:

```text
manifest
    ↓
historical packet windows
    ↓
browser replay clock
    ↓
shared visible time window
    ↓
five synchronized signal plots
```

Live and replay modes should remain conceptually distinct.

---

## 25. Replay Clock

The browser should maintain one session-relative replay position:

```text
replay_position_ms
```

Playback controls:

```text
play
pause
seek
restart / jump to beginning
```

Recommended initial speed choices:

```text
0.5×
1×
2×
4×
```

A slightly different small set is acceptable if the UX is clearer.

While playing:

```text
replay_position_ms
    += elapsed_real_ms * playback_speed
```

The same replay position drives every signal.

Do not create one timer per sensor.

---

## 26. Replay Seek Behavior

The clinician must be able to move directly to another part of the session.

Seek should:

```text
move the global replay cursor
load the bounded historical window needed around that position
render all sensors on the same timeline
preserve gap/epoch semantics
```

Seek must not require loading every packet from session start first.

A multi-minute session should be reviewable immediately near its end.

---

## 27. Browser Replay Buffering

Do not load and retain the entire historical session in browser memory by default.

Use bounded chunks/windows.

A reasonable direction:

```text
current packet window
+
small adjacent prefetch
```

For example:

```text
previous/current/next bounded chunks
```

or a similarly small LRU cache.

The exact cache implementation is not locked.

The invariants are:

```text
browser memory remains bounded
seek does not require full-session download
normal playback does not repeatedly fetch the same tiny interval
```

---

## 28. Historical Chart Window

Unlike the Phase-B live page, historical review should make cross-sensor alignment visually obvious.

For REVIEW mode, prefer one **shared visible X-axis window** across all signal plots.

Useful viewport presets may include:

```text
10 seconds
30 seconds
60 seconds
```

or equivalent zoom controls.

Every replay signal should display the same historical time range.

This is more useful for clinician correlation than giving each historical plot an unrelated time span.

---

## 29. Five-Signal Historical Representation

### ECG

Replay:

```text
raw ADC waveform
```

Historical cursor/detail may show:

```text
LO+
LO-
lead connected / lead-off state
```

Do not diagnose ECG.

Do not calculate heart rate in this phase.

### PPG

Replay:

```text
RED raw waveform
IR raw waveform
```

Do not add:

```text
SpO2
heart rate
perfusion claims
```

### GSR / EDA

Replay:

```text
raw TinyGSR/TLA2022 trend
```

Do not label the trace as:

```text
stress
arousal
anxiety
```

### IMU

Display-only conversions remain acceptable:

```text
ax / 16384 → g
ay / 16384 → g
az / 16384 → g

gx / 131 → degrees/s
gy / 131 → degrees/s
gz / 131 → degrees/s
```

The primary historical motion trace may remain:

```text
acceleration magnitude in g
```

At the replay cursor, showing the latest six converted axes is useful.

### Temperature

Display-only conversion remains:

```text
raw * 0.0078125 → °C
```

Raw database values remain unchanged.

---

## 30. No Implicit Interpolation

Historical review must not invent values at the replay cursor.

For example:

```text
temperature sample before cursor
temperature sample after cursor
```

does not automatically justify creating an interpolated temperature value.

For low-rate signals, show:

```text
nearest known sample
last known sample with age
or no current value
```

as appropriate.

Do not fabricate smooth data merely to make the UI look better.

---

## 31. Data Quality / Acquisition Quality Presentation

The global specification permits signal-quality presentation, but Phase C must keep that transparent and non-clinical.

Useful quality facts include:

```text
observed sensor sample rate
data present / no recent data
packet truncation
ingestion gaps
stored-history gaps
boot count
epoch count
ECG hardware lead-off state
```

These are directly tied to known acquisition/transport metadata.

For replay, show per-window or session-level information such as:

```text
ECG observed rate
PPG observed rate
GSR observed rate
IMU observed rate
temperature observed rate
```

where it remains simple and clearly labelled as **observed data rate**, not physiological quality.

---

## 32. Do Not Create an Unvalidated "Signal Quality Score"

Do not collapse heterogeneous facts into a pseudo-authoritative number such as:

```text
Signal quality: 87%
Physiology quality: Good
Patient state confidence: 92%
```

unless a separately validated definition exists.

For sensors without a direct hardware quality flag, Phase C should prefer factual cues:

```text
data present
observed rate
continuity
gaps
truncation
```

rather than inventing contact-quality thresholds from raw amplitude.

---

## 33. Minimal Processing Boundary

Phase C does **not** require a new physiological feature merely because the global milestone mentions minimal processing/presentation.

The current justified derived display values are already enough to satisfy the processing side of the milestone:

```text
IMU physical-unit conversion
IMU acceleration magnitude
temperature °C conversion
observed sample/data rates
continuity / gap summaries
ECG lead-off presentation
historical timing reconstruction
```

Do not add a physiological feature unless it has:

```text
a clear product use
a defensible algorithm
sensor suitability
validation evidence
safe interpretation wording
```

No such feature should be assumed merely for visual impressiveness.

---

## 34. UI/UX Is a Phase-C Requirement

Phase C should treat the clinician interface as a core product deliverable.

A technically correct replay page that looks like a debug console is **not sufficient**.

The finished interface should feel like a coherent clinician monitoring workstation:

```text
clear
high-information
calm
fast to understand
easy to navigate
visually polished
trustworthy
```

The objective is not decorative complexity.

The objective is that a first-time viewer can quickly understand:

```text
am I looking at LIVE or REVIEW?
which session?
is the device connected?
what point in time am I viewing?
are data missing?
did the device reboot?
which signal is which?
how do I start/stop/replay/seek?
```

---

## 35. Clinician Information Architecture

Keep one canonical clinician route:

```text
/clinician/objective
```

Evolve it into two clearly separated top-level modes:

```text
LIVE
REVIEW
```

Do not create unrelated pages for every function.

Conceptual layout:

```text
┌───────────────────────────────────────────────────────────────┐
│ Objective Monitoring        LIVE | REVIEW     global status   │
├───────────────────────────────────────────────────────────────┤
│ contextual session header / controls                         │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│                  primary signal workspace                     │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ context / timeline / quality / diagnostics                   │
└───────────────────────────────────────────────────────────────┘
```

Exact visual composition may differ.

---

## 36. LIVE Workspace

Preserve the Phase-B capabilities:

```text
device connection
session start
session stop
live WebSocket
five live signals
storage/live health
session history
```

But improve hierarchy.

The most important live information should be visually dominant:

```text
device/session state
five signals
important gap/storage warnings
start/stop action
```

Detailed operational counters should not visually compete with the signals.

A compact or expandable diagnostics area is preferable to a permanent wall of counters.

---

## 37. REVIEW Workspace

The review workspace should contain:

```text
session selector/browser

selected-session summary

playback controls

full-session timeline / scrubber

gap + epoch markers

five synchronized historical plots

current cursor values

data continuity / acquisition quality

optional expanded system/session details
```

Historical REVIEW must look and behave differently enough from LIVE that a clinician cannot easily mistake recorded data for current patient data.

Use clear labels such as:

```text
Historical review
Recorded session
T+00:42
```

Do not reuse a green "LIVE" visual state in replay.

---

## 38. Session Browser

Recent durable sessions should become actionable.

A session row/card should show enough to select intelligently:

```text
status
date/time
device
session duration or recorded span where available
```

When selected, the manifest can provide richer facts:

```text
packets
gaps
epochs
stored-history completeness
```

Do not make the main history UI dominated by full UUIDs.

A shortened identifier with copy/details behavior is more readable, while the complete UUID remains accessible.

Avoid an N+1 manifest query for every visible history row solely for decoration.

---

## 39. Replay Deep-Link / Navigation State

A useful simple direction is to preserve review state in the URL, for example:

```text
/clinician/objective?view=review&session=<session_id>
```

or an equivalent same-page approach.

This allows:

```text
refresh without losing selected session
browser back/forward behavior
directly reopening a known review
```

Do not introduce a client-side routing framework solely for this.

---

## 40. Playback Controls

Provide a compact, obvious replay control bar.

At minimum:

```text
Play / Pause
restart / beginning
current T+ time
total duration
seek scrubber
speed selector
```

The control bar should remain easy to access while examining the plots.

Useful keyboard behavior is encouraged:

```text
Space → play/pause
Left/Right → small seek
```

if it remains simple and does not interfere with ordinary page navigation/accessibility.

---

## 41. Full-Session Timeline / Scrubber

The replay scrubber should show more than a naked range input.

It should visually communicate the structure of the recorded session.

Useful timeline markers:

```text
ingestion/transport gap
stored-history gap
device reboot
time/backend epoch boundary
```

A clinician should be able to see where discontinuities occur before playing through the entire session.

Do not encode critical meaning by color alone; use labels/tooltips/icons/legend as appropriate.

---

## 42. Synchronized Historical Plots

The five historical plots must share:

```text
one replay position
one visible X-axis range
one timeline model
```

Hover/cursor synchronization across plots is strongly preferred.

A cursor at:

```text
T+42.500 s
```

should make it easy to inspect:

```text
ECG
PPG
GSR
IMU
temperature
```

around the same moment.

Use uPlot's supported synchronization mechanism or a small app-level equivalent.

Do not introduce another large chart library solely for cursor sync.

---

## 43. Focus / Expanded Signal View

For a polished clinician experience, allow an individual signal panel to be expanded/focused.

Examples:

```text
ECG focus
PPG focus
GSR focus
motion focus
temperature focus
```

Focus mode should:

```text
use more screen area
preserve the shared replay clock
preserve seek/play controls
retain obvious return-to-grid behavior
```

Do not create separate routes or duplicate replay engines per signal.

---

## 44. Current-Value Presentation

At the replay cursor, show concise current/nearest values where meaningful:

```text
ECG ADC + lead state
PPG RED / IR
GSR raw
IMU magnitude + axes
temperature °C
```

Do not display a value if the nearest available data is separated from the cursor by a known gap in a way that would mislead the clinician.

Where necessary, indicate:

```text
no sample
stale
gap
```

instead of carrying a value across an unavailable interval.

---

## 45. Session Summary

The selected-session review header should make the session understandable without opening SQL or a debug panel.

Useful facts:

```text
session status
session created time
session completed time
recorded signal span
device ID
packet count
ingestion gap count / missing packets
stored-history gap count / missing packets
boot count
epoch count
truncated packets
```

Do not mix:

```text
session lifecycle duration
```

with:

```text
actual recorded signal span
```

without clear labels.

A WAITING interval before first sensor packet is not the same as recorded physiology duration.

---

## 46. Diagnostics / Health Presentation

Retain the Phase-B health information, but improve how it is presented.

Default view:

```text
high-level state
important warnings
```

Expandable details:

```text
accepted packet counts
ACKs
duplicates
invalid packets
reconnects
live drops
storage queue/errors/drops
```

Historical review should emphasize:

```text
record completeness
gaps
epochs
truncation
```

rather than current live socket counters.

---

## 47. Visual Design Quality

The clinician interface should receive deliberate visual design work.

Priorities:

```text
strong hierarchy
consistent spacing
clear typography
high chart readability
consistent signal identity
clear state badges
good contrast
intentional empty/loading/error states
compact but not cramped controls
minimal visual noise
```

Use a coherent signal palette and reuse it consistently between:

```text
live plot
historical plot
legend
current-value label
focus mode
```

Do not make the interface impressive by adding unsupported clinical gauges.

A clean five-signal workstation is more credible than decorative risk meters.

---

## 48. Responsive / Demonstration Boundary

The primary target is a clinician/demo desktop or laptop browser.

The interface should remain usable at common presentation sizes such as approximately:

```text
1366×768
1440×900
1920×1080
```

Avoid a fixed layout that requires horizontal page scrolling at normal laptop widths.

Mobile-specific redesign is not part of Phase C.

Charts may stack/reflow at narrower widths, but desktop signal review is the priority.

---

## 49. Accessibility / Interaction Quality

Use:

```text
real buttons
visible focus states
semantic status text
keyboard-accessible controls
sufficient contrast
text labels in addition to color
```

Loading and disabled states should be obvious.

Errors should be visible without destroying the currently usable part of the interface.

Do not rely on hover-only interaction for essential replay controls.

---

## 50. Frontend Technology Boundary

The current frontend is already a same-process static application using uPlot.

Phase C is allowed to organize the browser code better because replay will materially increase UI complexity.

A reasonable direction is:

```text
public/objective/
  index.html
  objective.css

  app.js
  api.js
  live.js
  replay.js
  charts.js
```

or another small browser-module split.

This is only a suggested structure.

Prefer:

```text
native browser ES modules
existing local uPlot
same backend static serving
```

before introducing:

```text
React
Next.js
Vue
Vite
large component frameworks
design-system dependencies
```

The current Phase-C scope does not yet justify a full SPA toolchain by default.

If actual implementation becomes materially harder to maintain without a build system, reassess from concrete evidence rather than architectural fashion.

---

## 51. Static Asset Safety

If browser code is split into modules, update the static-serving allowlist deliberately.

Continue serving only known assets.

Do not replace the current fixed dashboard asset map with:

```text
generic URL → arbitrary filesystem path
```

just to avoid listing several JavaScript modules.

No directory-traversal surface should be introduced.

---

## 52. Browser / API Error Behavior

Replay errors must be explicit.

Examples:

```text
session not found
database unavailable
replay manifest unavailable
packet window failed
packet window capped/truncated
```

UI behavior should:

```text
show a concise actionable error
pause historical playback if required data is unavailable
preserve already-loaded data where safe
allow retry
```

Do not silently jump over an unavailable replay chunk.

That would make the historical record look more complete than it is.

---

## 53. Authorization Boundary

The same Phase-B prototype trust boundary remains.

Do not invent a separate clinician authentication implementation in Phase C.

However:

```text
historical packet APIs
session manifests
review UI
```

must remain structured so application-level clinician authorization can be inserted later.

Do not expose:

```text
device token
DATABASE_URL
Wi-Fi credentials
```

through replay endpoints or browser assets.

---

## 54. Phase Observability

Do not build a new observability stack for replay.

Useful lightweight read-side information may include:

```text
historical API errors
manifest reads
bounded packet-window failures
```

but avoid noisy per-window success logging.

Replay performance should primarily be validated through:

```text
bounded response sizes
browser behavior
query latency at actual prototype session sizes
memory behavior
```

No Prometheus stack is required.

---

## 55. End-to-End Validation Required

Phase C is not complete from repository/unit tests alone.

Validate the final system using:

```text
real persisted five-sensor session data
real PostgreSQL
real Node/TypeScript backend
real Chrome/browser UI
```

A short real-device live smoke test is also required after UI refactoring to ensure the Phase-B live path remains healthy.

---

## 56. Validation A — Historical Session Manifest

Use a real persisted session.

Verify that the manifest agrees with durable data for:

```text
session identity
status
packet count
recorded span
first/last packet timing
gap counts
boot count
epoch count
truncated count
```

Where a count is derived, compare it with an independent SQL inspection or equivalent trusted evidence.

Do not accept a manifest merely because the UI renders it.

---

## 57. Validation B — Bounded Historical Retrieval

Use a multi-minute persisted session.

Verify:

```text
initial REVIEW load does not download the full raw session
packet requests are windowed/bounded
seek near the end works without replaying from the beginning
browser memory does not grow with total session duration
```

Confirm returned raw packet arrays remain unchanged from PostgreSQL.

---

## 58. Validation C — Five-Signal Synchronized Replay

Replay a real completed physical session.

Verify:

```text
ECG visible
PPG RED visible
PPG IR visible
GSR visible
IMU/motion visible
temperature visible
```

Verify all five share the same:

```text
replay clock
historical viewport
seek position
```

and use:

```text
replay_t0_ms + dt_us / 1000
```

or the equivalent stored-anchor-derived timeline.

---

## 59. Validation D — Playback Controls

Verify:

```text
play
pause
restart
seek
speed change
end-of-session behavior
```

Seek repeatedly across a multi-minute session.

Ensure playback does not create duplicate plot points or stale previous-session data.

Switching session should reset the replay engine cleanly.

---

## 60. Validation E — Real Ingestion Gap Replay

Use a real persisted session containing a known physical sequence gap, such as a transport/network-queue loss scenario.

Verify:

```text
manifest exposes the gap
timeline marks it
charts break across it
cursor can move through the missing interval
no samples are fabricated
```

The historical UI should identify it as an ingestion/transport gap.

---

## 61. Validation F — Stored-History Gap

Test the history-only gap path deterministically.

This does not require damaging a real production session.

In an isolated validation database or test fixture, create a persisted sequence discontinuity that is **not** explained by `gap_before`.

Verify:

```text
history_gap_before > 0
or equivalent derived metadata

timeline identifies stored-history loss
charts break
UI does not mislabel it as an ESP32 ingestion gap
```

This test protects the known Phase-B bounded-persistence semantics.

---

## 62. Validation G — Multi-Epoch / Reboot Replay

Replay a real session containing a physical ESP32 reboot.

Verify:

```text
same session_id
boot_id changes
epoch_id changes
timeline contains a reboot boundary
old and new waveform segments are not connected
replay clock remains navigable across the boundary
```

Also validate, if suitable stored evidence exists, an epoch boundary with unchanged `boot_id` so it is not falsely labelled as a device reboot.

---

## 63. Validation H — Live Regression

After the Phase-C frontend changes, run the real device briefly in LIVE mode.

Verify:

```text
start session
five live streams render
packet rate remains healthy
gap logic remains correct
stop session
history updates
```

No Phase-C replay logic may regress:

```text
/ws/objective/device
/ws/objective/live/:sessionId
ACK behavior
persistence
session lifecycle
```

No firmware change should be required for normal Phase-C completion.

---

## 64. Validation I — UI/UX / Demo Quality

Validate the actual interface at common laptop/desktop sizes.

At minimum confirm:

```text
LIVE vs REVIEW is immediately obvious
current session/review identity is obvious
primary signals are visually dominant
history selection is intuitive
play/pause/seek are easy to discover
gap/reboot markers are understandable
focus/expanded signal view is usable
important warnings are visible
low-level counters do not dominate the page
no horizontal page overflow at normal laptop width
no browser exceptions
```

A first-time viewer should not need backend knowledge to understand the main workflow.

---

## 65. Validation J — Empty / Error States

Exercise:

```text
no historical sessions
known session with zero packets
unknown session
database read interruption
failed packet-window request
switch from REVIEW back to LIVE
```

The UI should remain understandable and recoverable.

Do not leave blank chart panels with no explanation.

---

## 66. Phase-C Validation Record

When final validation passes, create:

```text
docs/OBJECTIVE_MONITORING_PHASE_C_VALIDATION.md
```

Keep it concise and evidence-oriented.

Recommended sections:

```text
# Objective Monitoring — Phase C Validation

## Validation scope
## Runtime / browser / database
## Historical manifest
## Bounded packet retrieval
## Five-signal synchronized replay
## Playback / seek behavior
## Ingestion-gap replay
## Stored-history-gap replay
## Multi-epoch / reboot replay
## Live regression
## UI/UX validation
## Known limitations
## Phase-C conclusion
```

Record real observations.

Do not paste large raw packet dumps.

---

## 67. Definition of Done

Phase C is complete when:

```text
✅ persisted sessions can be selected for historical review

✅ a session replay manifest is queryable

✅ historical raw packets are retrieved in bounded windows

✅ full-session history is not required in browser memory

✅ replay uses stored ESP/backend timing anchors

✅ all five signals replay on a synchronized timeline

✅ play / pause / seek / restart work

✅ replay speed control works

✅ a multi-minute session can be opened near any point without replaying from zero

✅ ingestion gaps are explicit and create chart discontinuities

✅ persisted-history-only gaps are independently detectable

✅ epoch boundaries are explicit

✅ physical ESP32 reboot is distinguishable from same-boot epoch change

✅ raw stored packet values remain unchanged

✅ ECG remains non-diagnostic raw ADC + lead state

✅ PPG remains raw RED / IR

✅ GSR remains raw trend

✅ IMU conversion remains display-only

✅ temperature conversion remains display-only

✅ data continuity / observed acquisition quality is clearly presented

✅ no unvalidated physiological score is introduced

✅ /clinician/objective provides clearly separated LIVE and REVIEW workflows

✅ the clinician UI has a polished, coherent information hierarchy

✅ session history is easy to navigate

✅ replay timeline / markers are understandable

✅ synchronized cursor / shared viewport is available for historical review

✅ an individual signal can be focused/expanded

✅ common laptop/desktop layouts remain usable

✅ loading, empty, and error states are intentional

✅ Phase-B live monitoring still works with the physical device

✅ no ACK / persistence / session regression is introduced

✅ final real-browser validation passes

✅ Phase-C validation evidence is recorded
```

---

## 68. Commit Plan

Keep Phase C to roughly **four meaningful commits**.

This is a phase-level planning guardrail.

It is **not** permission to pre-implement later commits.

Before each actual Codex packet:

```text
inspect the current pushed repository state
review the previous accepted diff
define exactly one coherent next commit
do not jump ahead
```

If validation reveals a defect in the final commit, fix it within that closure packet before declaring Phase C complete.

### Commit 09 — bounded historical read foundation

Expected direction:

```text
feat(objective-history): add bounded historical replay APIs
```

Coherent scope:

```text
historical/replay repository
session replay manifest
cross-epoch replay timeline metadata
ingestion-gap summary
stored-history-gap derivation
bounded packet-window API
native HTTP route integration
historical API tests
```

Do not build the clinician replay UI in this commit.

No database migration should be added unless actual query evidence requires one.

---

### Commit 10 — synchronized historical replay

Expected direction:

```text
feat(objective-replay): add synchronized historical session replay
```

Coherent scope:

```text
REVIEW mode
session selection
manifest loading
bounded packet-window fetching
replay clock
play / pause / seek / restart
speed control
shared historical viewport
five synchronized signal plots
gap / epoch / reboot discontinuities
bounded browser replay cache
```

This commit should make historical replay functionally complete.

Do not spend it on unrelated visual-polish work.

---

### Commit 11 — clinician presentation / UI experience

Expected direction:

```text
feat(objective-presentation): refine clinician monitoring and review experience
```

Coherent scope:

```text
LIVE / REVIEW information architecture
session browser usability
full-session timeline / markers
synchronized cursor/details
focus / expanded signal view
session summary
data-continuity / observed-rate presentation
diagnostics hierarchy
deep-link / review navigation state if useful
responsive laptop layout
accessibility / loading / empty / error states
intentional visual polish
browser-code modularization if justified
```

This is a real product/presentation commit, not cosmetic cleanup.

Do not add unsupported physiological interpretation merely to make the dashboard look impressive.

---

### Commit 12 — Phase-C validation / closure

Expected direction:

```text
test(objective): validate historical replay and clinician presentation
```

Scope:

```text
real persisted physical five-sensor session
real PostgreSQL
real browser

manifest correctness
bounded reads
seek / speed / playback
five-signal synchronization
real ingestion-gap replay
stored-history-gap fixture
multi-epoch / reboot replay
live-mode regression
UI/UX validation

hardware/replay-discovered fixes only

docs/OBJECTIVE_MONITORING_PHASE_C_VALIDATION.md

global milestone update only after success
```

Avoid splitting trivial cleanup into additional milestone commits.

---

## 69. Global Specification Update at Closure

Do not mark Milestone C complete before final validation.

After successful Commit 12, minimally update:

```text
docs/OBJECTIVE_MONITORING_GLOBAL_SPEC.md
```

from:

```text
Milestone C — Replay + minimal processing/presentation — next
```

to:

```text
Milestone C — Replay + minimal processing/presentation — complete
```

Point to:

```text
OBJECTIVE_MONITORING_PHASE_C_VALIDATION.md
```

Do not rewrite the global architecture.

Do not promote implementation details such as replay chunk size, HTML layout, or button placement into the global specification.

---

## 70. What Follows Phase C

Phase C completes the short milestone path currently defined in the global specification:

```text
A — real ingestion
B — live + persistence
C — replay + minimal processing/presentation
```

Do **not** automatically invent a Phase D.

After Phase C, the objective-monitoring prototype will already have:

```text
real five-sensor acquisition
validated ingestion
live clinician monitoring
durable raw persistence
session history
historical synchronized replay
clinician-oriented presentation
```

Any further major work should begin from a new, separately justified requirement such as:

```text
validated physiological feature extraction
immediate impairment-corroboration research implementation
broader application / patient / clinician integration
production authorization/security
hardware transport durability changes
```

Those are not implicitly part of Phase C.

---

## 71. Phase-C Completion Principle

Phase C is successful when the project stops feeling like:

```text
"we can collect and plot five sensor streams"
```

and instead feels like:

```text
"a clinician can confidently operate the monitor,
review what happened,
navigate the physiology in time,
see where data are missing,
and understand the raw evidence without the UI
pretending to know more than the sensors actually prove."
```

The replay/data model must remain technically honest.

The clinician experience should be deliberately polished.

Both are required for Phase C to be complete.
