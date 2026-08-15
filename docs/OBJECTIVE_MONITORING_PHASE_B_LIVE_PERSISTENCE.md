# Objective Monitoring — Phase B Specification
## Live Clinician Monitoring + PostgreSQL Persistence

> **Purpose of this file**
>
> This document defines the next implementation phase after the physically validated Phase A ingestion boundary.
>
> It is intentionally more specific than `OBJECTIVE_MONITORING_GLOBAL_SPEC.md`, but it does not pre-lock details that can safely be decided while implementing individual commits.
>
> Phase B must attach useful live visualization and durable storage **downstream from the existing accepted-packet boundary** without redesigning or destabilizing the validated ESP32 → backend ingestion path.

---

## 1. Phase Goal

At the end of Phase B, the system should support:

```text
Physical sensors
    ↓
ESP32 V5.3
    ↓
validated Phase A ingestion
    ↓
AcceptedPacketBus
    ├─────────────────────────┐
    ↓                         ↓
live clinician fan-out        asynchronous persistence
    ↓                         ↓
clinician dashboard           PostgreSQL
                              ↓
                        session history
```

The clinician should be able to:

```text
see whether the objective device is connected
create/start a monitoring session
watch all five sensor streams live
observe stream/gap/storage health
stop the monitoring session
see persisted monitoring-session history
```

The backend should persist accepted raw packets so the next phase can add historical replay and later processing **without changing the ingestion contract again**.

---

## 2. What We Start With

Phase A is closed and physically validated.

Current completion commit:

```text
8f4250e
test(objective): validate session-aware hardware ingestion
```

Authoritative implementation baseline:

```text
firmware/esp32_v5_3_backend_session.ino
src/objective/*
```

Relevant durable documents:

```text
docs/OBJECTIVE_MONITORING_GLOBAL_SPEC.md
docs/OBJECTIVE_MONITORING_PHASE_A_BACKEND_INGESTION.md
docs/OBJECTIVE_MONITORING_PHASE_A_VALIDATION.md
```

The current physical path has already demonstrated:

```text
HELLO / READY
backend-issued START / STOP
~10 packets/sec
healthy five-sensor acquisition
strict Schema V1 validation
sequence/gap handling
boot epochs
accepted-packet handoff
ACK:<seq>
ESP32 reconnect/reboot recovery
safe backend-restart idle behavior
```

Do not rebuild these capabilities inside Phase B.

---

## 3. Existing Boundary That Phase B Must Preserve

The current accepted packet is conceptually:

```text
AcceptedObjectivePacket {
  device_id
  boot_id
  session_id

  received_at_ms

  sequence_status
  gap_before

  epoch_id
  esp_anchor_us
  backend_anchor_ms
  plot_t0_ms

  raw_packet
}
```

This boundary already exists in:

```text
src/objective/acceptedPacketBus.ts
```

Phase B consumers must attach to this boundary.

Do not bypass the validator/sequence/time pipeline and independently consume raw device WebSocket frames.

The intended flow remains:

```text
device packet
    ↓
authentication/session validation
    ↓
Schema V1 validation
    ↓
sequence classification
    ↓
time metadata
    ↓
AcceptedPacketBus
    ├── live consumer
    └── persistence consumer
    ↓
ACK remains tied to ingestion acceptance
```

---

## 4. Phase Scope

Implement the minimum complete Milestone-B capability:

1. PostgreSQL connectivity and migration mechanism.
2. Durable objective monitoring-session records.
3. Durable accepted-packet storage at packet granularity.
4. A non-blocking persistence handoff from `AcceptedPacketBus`.
5. Recovery of persisted non-completed monitoring sessions after backend restart.
6. A generic clinician live WebSocket stream.
7. Explicit slow-live-client protection.
8. A small runtime/status API suitable for the clinician view.
9. Persistent monitoring-session history listing.
10. A clinician-facing live dashboard.
11. Live synchronized visualization of all five signal families.
12. Gap/reboot discontinuity handling in live charts.
13. Storage/live health visibility.
14. Real ESP32 + PostgreSQL + browser end-to-end validation.

---

## 5. Explicitly Out of Scope

Do **not** add during Phase B:

```text
historical waveform replay
historical packet playback controls
signal filtering pipelines
feature extraction pipelines
ML inference
stress / intoxication / impairment classification
diagnostic labels
alert-generation rules from physiology
patient-profile modeling
full patient identity integration
mobile application UI
Redis
Kafka
microservices
time-series database
per-sample database rows
binary sensor transport
precision clock synchronization
offline ESP32 store-and-forward
local disk/WAL spool for backend storage failures
production-grade user authentication/authorization
```

Phase B creates the durable/live foundations that replay and minimal processing can use next.

Do not pull Phase C forward merely because the data is now persisted.

---

## 6. Phase Architecture

Target architecture:

```text
                            Node / TypeScript backend

ESP32 V5.3
   │
   │ /ws/objective/device
   ▼
Device Gateway
   │
   ▼
Packet Validator
   │
   ▼
Sequence + Time
   │
   ▼
AcceptedPacketBus
   │
   ├──────────────────────────────────────────┐
   │                                          │
   ▼                                          ▼
Live Fan-out                           Persistence Handoff
   │                                          │
   │ /ws/objective/live/:sessionId            ▼
   ▼                                     bounded in-memory queue
Clinician browser                              │
                                              ▼
                                           PostgreSQL
                                              │
                                              ▼
                                         session history
```

Everything remains inside one normal backend process.

PostgreSQL is the only new required infrastructure.

No stream broker is needed at current scale.

---

## 7. Important Current WebSocket-Routing Constraint

The current device gateway owns the server's WebSocket `upgrade` event and rejects paths other than:

```text
/ws/objective/device
```

Phase B needs another WebSocket route:

```text
/ws/objective/live/:sessionId
```

Therefore the implementation must establish **one unambiguous WebSocket upgrade-routing owner**.

Preferred conceptual direction:

```text
HTTP server
   ↓ upgrade
Objective WebSocket Router
   ├── /ws/objective/device
   │       → Device Gateway
   │
   └── /ws/objective/live/:sessionId
           → Live Gateway
```

Equivalent clean designs are acceptable.

Do not attach competing upgrade listeners where one gateway can close a socket intended for another gateway.

Unknown WebSocket paths should still be rejected cleanly.

This routing change is justified by the new live-client requirement; do not turn it into a generic networking framework.

---

## 8. PostgreSQL Role

PostgreSQL becomes the durable source for:

```text
monitoring-session history
accepted raw packet history
```

It does **not** replace:

```text
ESP32 monotonic timing
real-time device connection state
AcceptedPacketBus
live WebSocket delivery
```

Use the normal Node backend with a small PostgreSQL client layer.

A lightweight direct SQL approach is preferred.

An ORM is not required for this prototype.

Current expected configuration:

```text
DATABASE_URL
```

Do not commit real database credentials.

---

## 9. Database Migration Direction

The repository should contain a reproducible schema migration mechanism.

A simple direction is sufficient:

```text
db/
  migrations/
    001_objective_persistence.sql
```

plus a small migration command/script.

Do not introduce a large migration/ORM framework unless implementation evidence shows it is genuinely simpler.

The backend should not silently operate in a supposed persistent mode against an unknown/uninitialized schema.

---

## 10. Durable Session Model

Persist objective monitoring sessions separately from sensor packets.

Conceptually store:

```text
objective_sessions
------------------
session_id
device_id
status
created_at_ms
updated_at_ms
completed_at_ms   nullable
```

Existing runtime statuses remain:

```text
WAITING
LIVE
DISCONNECTED
COMPLETED
```

The exact SQL types/index names are implementation details, but these invariants should hold:

```text
session_id is unique
one non-completed session per device
completed sessions remain queryable
history survives backend-process restart
```

A PostgreSQL partial unique constraint/index for one non-completed session per device is appropriate if it keeps the rule enforceable without application-only assumptions.

Do not add `patient_id` merely to make the schema look complete.

The surrounding application has not yet supplied a real patient-identity integration contract.

---

## 11. Session Durability Semantics

Phase A intentionally kept sessions in memory.

Phase B should now make the monitoring-session identity durable.

### Session creation

A newly created monitoring session must have a durable database record before the API claims successful creation and before the backend intentionally starts sending that session to the ESP32.

Conceptually:

```text
create request
    ↓
create durable session record
    ↓
activate runtime session
    ↓
START:<session_id>
    ↓
return success
```

Exact ordering may be adapted to maintain consistency, but do not report a successfully created persistent session that never reached PostgreSQL.

### Explicit stop

A stopped session must become durably `COMPLETED`.

The device STOP operation remains safety/behaviorally important and must not be forgotten merely because persistence is temporarily unhealthy.

If durable completion fails, surface the persistence failure rather than silently claiming the durable history is correct.

### Connection-driven state

Transitions such as:

```text
LIVE ↔ DISCONNECTED
```

remain primarily runtime connection state, but persisted status should be kept reasonably current for useful history/recovery.

Do not make device ACK latency depend on session-status database writes.

---

## 12. Backend-Restart Recovery in Phase B

Phase A currently behaves safely as:

```text
backend process restart
→ in-memory session lost
→ ESP32 reconnects/authenticates
→ ESP32 remains idle
→ new session required
```

Persistence now provides enough durable identity to improve this.

Phase-B target:

```text
active/non-completed session exists in PostgreSQL
    ↓
backend restarts
    ↓
backend loads the recoverable session
    ↓
transient LIVE state is treated as disconnected until device is present
    ↓
ESP32 reconnects + HELLO
    ↓
same persisted session becomes LIVE
    ↓
START:<same session_id>
    ↓
stream resumes with a new/existing boot epoch as appropriate
```

Important distinctions:

```text
ESP32 reboot
→ same session
→ new boot_id
→ new stream epoch

backend restart only
→ same persisted session
→ ESP32 boot_id may remain unchanged

explicitly COMPLETED session
→ must never be resurrected
```

If multiple conflicting non-completed sessions are found for one device, do not guess which one is authoritative; fail clearly or mark the data inconsistency for repair.

---

## 13. Durable Packet Model

Store accepted data primarily as **one database row per existing ~100 ms packet**.

Do not explode packets into separate ECG/PPG/GSR/IMU/TEMP sample rows.

Conceptually:

```text
objective_packets
-----------------
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

A uniqueness rule equivalent to:

```text
(session_id, boot_id, seq)
```

should protect against accidental duplicate storage.

The row should reference the durable session.

Indexes should support:

```text
packets by session
ordered session history/replay later
```

without speculative analytics indexing.

---

## 14. Raw Packet Persistence Invariant

`raw_packet` remains the source-of-truth Schema V1 object.

Persist:

```text
schema
session_id
seq
timebase
created_us
t0_us
t1_us
truncated
n
ecg
ppg
gsr
imu
temp
```

without unit conversion, filtering, resampling, feature extraction, or interpretation.

Using PostgreSQL `JSONB` is acceptable.

The invariant is preservation of the validated raw values/schema, not preservation of the original textual JSON whitespace or key-order bytes.

Derived values added in later phases must be stored separately and must not overwrite this raw payload.

---

## 15. Packet Persistence Handoff

Database work must not execute directly as blocking work inside the device ingestion path.

The current `AcceptedPacketBus.publish()` is synchronous.

Therefore the persistence subscriber should do only a small bounded handoff, conceptually:

```text
AcceptedPacketBus
    ↓
synchronous enqueue
    ↓
return immediately
    ↓
ACK can proceed
```

A background/in-process persistence worker then performs the PostgreSQL insert asynchronously.

Do not:

```text
await INSERT
before ACK

perform long DB retry loops
inside AcceptedPacketBus.publish()

let DB latency control device ingestion
```

The original global ACK contract remains unchanged.

---

## 16. Persistence Queue / Failure Semantics

The persistence handoff should use a **bounded** in-process queue.

Goals:

```text
normal PostgreSQL latency
→ queue remains near empty

brief PostgreSQL slowdown/outage
→ queue absorbs a limited backlog
→ ingestion/ACK/live view continue

database recovers before queue exhaustion
→ worker catches up

prolonged outage / queue exhaustion
→ ingestion still continues
→ persistence loss is explicit and counted
```

Do not create an unbounded memory queue.

Do not add Kafka/Redis/disk spooling to turn this into a lossless ingestion system.

Track at least:

```text
storage queue depth
persisted packets
storage errors
storage drops
storage degraded/healthy state
```

Log storage failure in a rate-limited/useful way rather than logging every failed packet.

---

## 17. Persistence Guarantees — Be Explicit

Phase B provides durable packet storage during normal operation.

It does **not** turn the architecture into a transactional lossless recorder.

The global ACK semantics still mean:

```text
packet accepted into backend ingestion memory
```

not:

```text
packet committed to PostgreSQL
```

Therefore this window can exist:

```text
backend ACKs packet
    ↓
packet is queued for persistence
    ↓
backend process crashes before DB insert
    ↓
that packet may be absent from history
```

Similarly, a sufficiently long database outage can exhaust the bounded persistence queue.

Do not hide these limitations.

Closing those windows would require a different durability boundary or local write-ahead mechanism and is outside the current prototype scope.

---

## 18. PostgreSQL Availability Policy

At backend startup, PostgreSQL is now a required Phase-B dependency.

If the database cannot be reached or the required schema is unavailable:

```text
fail startup clearly
```

rather than pretending persistence is active.

During runtime:

```text
temporary packet-storage failure
→ do not break device ingestion
→ mark storage degraded
→ retain/retry bounded queued work where feasible
```

Session-control operations should surface database failures instead of silently creating inconsistent durable history.

No automatic fallback to a second persistence technology.

---

## 19. Live Clinician WebSocket

Provide one generic live endpoint:

```text
/ws/objective/live/:sessionId
```

This endpoint consumes the same `AcceptedPacketBus` stream.

It must not connect to the ESP32 directly.

The browser is a downstream subscriber only.

A small live protocol is sufficient.

Conceptually:

```json
{
  "type": "ready",
  "session_id": "..."
}
```

followed by:

```json
{
  "type": "packet",
  "packet": {
    "device_id": "...",
    "boot_id": "...",
    "session_id": "...",
    "received_at_ms": 0,
    "sequence_status": "normal",
    "gap_before": 0,
    "epoch_id": "...",
    "esp_anchor_us": 0,
    "backend_anchor_ms": 0,
    "plot_t0_ms": 0,
    "raw_packet": {}
  }
}
```

Exact field casing should remain consistent with the existing accepted object.

Do not create a second transformed sensor packet schema solely for the browser.

The browser can perform lightweight display conversion downstream.

---

## 20. Live Stream Semantics

The clinician live endpoint is **live only**.

On browser connection:

```text
receive packets accepted from that point forward
```

Do not automatically replay the full database history into a live socket.

On browser reconnect:

```text
resume current live updates
```

Historical backfill/replay belongs to Phase C.

The live endpoint may be opened for a known session, but only actively accepted packets for that `session_id` are broadcast through it.

---

## 21. Slow Live Client Policy

A slow or paused browser must never slow device ingestion.

Do not maintain an unbounded queue per browser.

Use the WebSocket client's buffered-send state or an equivalent bounded policy.

Conceptually:

```text
client healthy
→ send current accepted packet

client falling behind
→ drop stale live display updates for that client
→ increment live-drop counter
→ continue ingestion

client unusably slow for prolonged period
→ optionally close it cleanly
```

Historical completeness belongs to PostgreSQL, not the live browser socket.

No device ACK may wait for browser delivery.

---

## 22. Runtime / Health API

Expose a small runtime status endpoint suitable for the clinician dashboard.

A canonical direction:

```text
GET /api/objective/status
```

At minimum expose useful non-secret information such as:

```text
configured device_id
device connected/authenticated state
current session/status
accepted packet activity
sequence gaps
invalid packets
duplicates
ACK activity
live-client count / live drops
storage health
storage queue depth
storage errors/drops
```

Do not expose:

```text
device token
Wi-Fi credentials
database credentials
```

This endpoint is a prototype operational view, not a full observability platform.

---

## 23. Persistent Session-History API

Extend the current session API with a persistent history listing.

Canonical direction:

```text
GET /api/objective/sessions
```

Return recent persisted sessions, newest first.

At minimum include:

```text
session_id
device_id
status
created_at_ms
completed_at_ms when available
```

Useful cheap summary fields such as:

```text
packet_count
gap_count
first/last packet receive time
```

may be included if implementation remains simple.

Do not build historical raw-packet replay endpoints yet merely because the table now exists.

Phase C will define replay/query semantics.

---

## 24. Existing Session API Must Remain Compatible

Preserve the current conceptual API:

```text
POST /api/objective/sessions
GET  /api/objective/sessions/:sessionId
POST /api/objective/sessions/:sessionId/stop
```

Phase B may change their internals from purely in-memory to durable storage, but should not gratuitously rename the endpoints or change the device protocol.

Existing:

```text
START:<session_id>
STOP:<session_id>
```

remains unchanged.

---

## 25. Clinician Dashboard Scope

Serve a small browser dashboard from the same backend process.

Canonical route:

```text
/clinician/objective
```

The dashboard is for the objective-monitoring prototype/demo.

It should provide:

### Session/device control

```text
device connection indicator
current session status
start/create monitoring session
stop monitoring session
```

### Live sensor visualization

```text
ECG waveform
PPG RED and IR
GSR trend
IMU / motion
skin/local temperature
```

### Health visibility

```text
packet rate
gap state/count
invalid/duplicate state
device/reconnect state
storage status
```

### Persistent history

```text
recent monitoring sessions
status
created/completed timing
```

Historical waveform replay is not part of this phase.

---

## 26. Dashboard Technology Boundary

Do not introduce a full SPA framework/build system solely for this dashboard unless implementation evidence shows a real benefit.

Given the current repository, prefer a small same-process frontend:

```text
plain HTML
CSS
browser JavaScript
small plotting dependency only if genuinely useful
```

A lightweight plotting library is acceptable because visualization is a major product/demo output.

The exact plotting library is an implementation detail and should be selected during the dashboard commit.

Avoid making core dashboard behavior depend on a public CDN if a small local dependency can reasonably provide the same result.

Do not add Next.js/React/Vite merely for architectural fashion.

---

## 27. Live Plot Time Model

Use the timing metadata already established by Phase A.

For each sensor sample:

```text
sample_esp_us =
raw_packet.t0_us + dt_us
```

For the current boot epoch, the accepted object already provides:

```text
plot_t0_ms
epoch_id
```

A live client may plot sample time approximately as:

```text
sample_plot_ms =
plot_t0_ms + dt_us / 1000
```

Do not replace this with browser receive time for cross-sensor alignment.

Browser wall-clock time may be shown separately for human context.

---

## 28. Gaps and Reboots in Live Charts

Do not draw misleading continuous lines across missing data.

### Forward packet gap

When:

```text
gap_before > 0
```

or:

```text
sequence_status == "gap"
```

the live chart must create a visible discontinuity/break before the new data.

Do not interpolate/fabricate missing samples.

### ESP32 reboot / boot epoch change

When:

```text
epoch_id changes
```

the live display must treat it as a new timing epoch.

For Phase B, the simplest acceptable behavior is:

```text
mark/clear the rolling chart
start a new visible segment
show reboot/epoch change in health state
```

Do not connect a line from the previous boot to a new epoch whose relative plot time resets.

More sophisticated multi-epoch historical alignment belongs to replay work.

---

## 29. Rolling Live Windows

Keep browser memory bounded.

Reasonable initial rolling windows are approximately:

```text
ECG              10 seconds
PPG RED / IR     10 seconds
GSR              30 seconds
IMU / motion     10 seconds
temperature      60 seconds
```

These are phase-level defaults, not clinical standards.

Adjust slightly during implementation if the plotting library/layout benefits.

Do not accumulate an entire monitoring session in browser memory.

---

## 30. Display Representation

Phase B visualization is allowed to perform simple display-only conversions.

### ECG

Display:

```text
raw ADC waveform
lead-off status
```

Do not interpret ECG clinically.

### PPG

Display:

```text
RED raw waveform
IR raw waveform
```

Do not add SpO2 or heart-rate claims unless separately implemented and validated later.

### GSR / EDA

Display:

```text
raw TinyGSR/TLA2022 trend
```

Do not label the raw trend as stress/arousal level.

### IMU

A simple motion representation is acceptable.

Given the configured MPU6050 ranges, display conversion such as:

```text
accelerometer raw / 16384 → g
gyro raw / 131 → degrees/s
```

is acceptable.

A simple acceleration magnitude may be used for the main motion plot if this produces a clearer clinician view.

Raw packet values remain unchanged in persistence.

### Temperature

Given the TMP117 representation used by the current firmware, display conversion:

```text
raw * 0.0078125 → °C
```

is acceptable.

Again, this is a display operation only.

---

## 31. Dashboard Interpretation Boundary

The clinician dashboard must not display unsupported physiological conclusions such as:

```text
stress detected
intoxicated
impaired
relapse likely
high-risk physiology
diagnosis
```

Phase B visualizes measured signals and stream/storage health.

Any derived physiological feature or impairment-corroboration logic requires a separately justified processing layer.

---

## 32. Backend HTTP Routing

The current backend uses the native Node HTTP server and a small session-route handler.

Phase B will add:

```text
status API
session-history API
static clinician dashboard routes
```

Keep routing small.

A lightweight route-composition approach is preferred.

Do not introduce Express/Fastify/Nest merely because the number of routes increased modestly.

If native routing becomes materially harder to maintain during implementation, reassess based on actual evidence rather than preemptively adding a framework.

---

## 33. Suggested Internal Structure

The exact tree is not locked, but a reasonable Phase-B direction is:

```text
src/
  objective/
    acceptedPacketBus.ts
    deviceGateway.ts
    deviceRegistry.ts
    packetValidator.ts
    sequenceTracker.ts
    sessionManager.ts
    sessionRoutes.ts
    timeMapper.ts

    persistence/
      database.ts
      sessionRepository.ts
      packetStore.ts

    live/
      liveGateway.ts
      liveStatus.ts

    dashboard/
      dashboardRoutes.ts

public/
  objective/
    index.html
    objective.js
    objective.css

db/
  migrations/
    ...
```

If fewer files remain clearer, combine them.

Do not create abstractions solely to match this diagram.

---

## 34. Configuration

Expected configuration after Phase B:

```text
HOST
PORT

OBJECTIVE_DEVICE_ID
OBJECTIVE_DEVICE_TOKEN

DATABASE_URL
```

Do not add a general configuration framework for five environment variables.

A non-secret example environment file may be added if useful.

Real credentials must remain ignored/uncommitted.

---

## 35. Browser Authorization Boundary

The current repository is a standalone objective-monitoring prototype and does not yet contain the broader application's clinician-authentication system.

Do not invent a second production authentication model inside Phase B.

For local/prototype use:

```text
dashboard + session APIs + live endpoint
```

may remain within the trusted backend deployment boundary.

However:

- do not expose device/database secrets;
- keep the live endpoint session-scoped;
- structure the backend contract so application-level clinician authorization can be inserted later.

Do not describe the Phase-B dashboard as production-secure merely because device authentication exists.

Device authentication and clinician/user authentication are separate concerns.

---

## 36. Phase Observability

Preserve existing ingestion diagnostics.

Add only the new downstream health needed to prove Phase B:

```text
live clients
live packets delivered
live packets dropped for slow clients

storage queue depth
packets persisted
storage errors
storage drops
storage healthy/degraded

durable session recovery state
```

Avoid per-packet success logs.

The dashboard/status API may expose these counters.

No Prometheus stack is required.

---

## 37. End-to-End Validation Required

Phase B is not complete from unit tests alone.

Validate with:

```text
physical ESP32
real five-sensor stream
Node/TypeScript backend
real PostgreSQL
real browser dashboard
```

### A. Normal persistent live session

Run a real monitoring session for at least approximately one minute.

Expected:

```text
~10 accepted packets/sec
live charts update continuously
PostgreSQL packet count grows at approximately the accepted rate
zero unexplained invalid/duplicate/gap counts
no ACK regression
sensor acquisition remains healthy
storage queue remains bounded/near empty
```

### B. Raw persistence correctness

Inspect persisted rows.

Verify:

```text
session_id correct
boot_id correct
seq correct
accepted metadata present
raw Schema V1 packet present
sample arrays unchanged
```

No derived/display conversions should overwrite raw stored values.

### C. START / STOP + history

Verify:

```text
create session
→ durable row exists
→ device streams

stop session
→ durable status COMPLETED
→ device returns to connected idle

session remains listed after backend restart
```

### D. Backend restart with active persisted session

During a live session:

```text
restart Node backend
```

Expected Phase-B target:

```text
session identity recovered from PostgreSQL
ESP32 reconnects/authenticates
same monitoring session resumes
streaming continues
new packets persist under same session
```

If the ESP32 itself did not reboot:

```text
boot_id may remain unchanged
```

If it rebooted:

```text
new boot_id
new epoch
same session
```

### E. Explicitly stopped session must not resurrect

Stop a session, restart backend, reconnect device.

Expected:

```text
completed session stays completed
device remains idle
no START for old session
```

### F. Brief PostgreSQL interruption

While streaming, temporarily make packet persistence unavailable.

Expected:

```text
device ingestion continues
ACK remains healthy
live dashboard continues
storage status becomes degraded
bounded queue grows/retries
```

After short recovery within queue capacity:

```text
worker catches up
storage returns healthy
```

Do not claim lossless recovery if the queue was exhausted.

### G. Slow browser client

Throttle/pause a browser or otherwise create a slow live consumer.

Expected:

```text
device accepted packet rate stays healthy
ACK stays healthy
storage stays healthy
live-client drops may increase
backend memory remains bounded
```

### H. Gap / reboot visualization

Create or reuse a controlled gap/reboot scenario.

Expected:

```text
dashboard shows a discontinuity
no fabricated continuous line
epoch change is visible/handled
```

---

## 38. Phase-B Validation Record

When physical validation is complete, create:

```text
docs/OBJECTIVE_MONITORING_PHASE_B_VALIDATION.md
```

Keep it concise.

Record durable evidence such as:

```text
hardware/backend/database versions
live packet rate
persisted packet behavior
dashboard behavior
storage queue health
slow-client behavior
database interruption behavior
backend restart/session recovery
gap/reboot display behavior
known limitations
```

Do not paste large raw logs into the document.

---

## 39. Definition of Done

Phase B is complete when:

```text
✅ PostgreSQL is a required, reproducibly initialized backend dependency
✅ monitoring sessions persist across backend-process restarts
✅ non-completed session identity can recover safely after backend restart
✅ explicitly completed sessions never resurrect
✅ accepted raw packets persist at ~100 ms packet granularity
✅ raw Schema V1 values remain unchanged in storage
✅ duplicate packet identity is protected at the DB boundary
✅ persistence is asynchronous relative to device ACK
✅ slow/unavailable PostgreSQL does not directly block device ingestion
✅ persistence buffering is bounded and loss/degradation is observable
✅ /ws/objective/live/:sessionId provides generic live fan-out
✅ slow clinician clients cannot create device backpressure
✅ live endpoint and persistence both consume AcceptedPacketBus
✅ existing device WebSocket/session/ACK contract remains intact
✅ persistent session history is queryable
✅ /clinician/objective provides a usable live clinician dashboard
✅ ECG is visualized live
✅ PPG RED/IR are visualized live
✅ GSR is visualized live
✅ IMU/motion is visualized live
✅ temperature is visualized live
✅ live health/storage state is visible
✅ gaps create chart discontinuities
✅ boot epochs do not create misleading continuous plots
✅ physical ESP32 + PostgreSQL + browser validation passes
✅ Phase-A acquisition health remains unchanged
```

Historical waveform replay is not required to close Phase B.

---

## 40. Commit Plan

Keep Phase B to roughly **four meaningful commits**.

This is a planning guardrail, not permission to skip repository inspection before each packet.

The exact packet must still be determined from the actual repository state after the preceding commit is accepted.

### Commit 1 — durable session + packet persistence

Expected direction:

```text
feat(objective-storage): persist sessions and accepted packets in postgres
```

Coherent scope:

```text
PostgreSQL configuration
migration/schema
session repository
persistent session lifecycle
backend-restart session hydration/recovery
bounded asynchronous accepted-packet storage
storage health counters
persistent session-history API
```

This commit should establish the durable side of the accepted-packet boundary before UI work.

### Commit 2 — generic live fan-out

Expected direction:

```text
feat(objective-live): add session-scoped clinician live streaming
```

Coherent scope:

```text
single-owner WebSocket upgrade routing
/ws/objective/device preserved
/ws/objective/live/:sessionId
AcceptedPacketBus live subscriber
slow-client drop/backpressure policy
runtime/status API
live health counters
```

Do not build the actual dashboard inside the transport commit unless the implementation is unexpectedly trivial and still coherent.

### Commit 3 — clinician live dashboard

Expected direction:

```text
feat(objective-dashboard): add live monitoring dashboard
```

Coherent scope:

```text
/clinician/objective
session controls
device/session/storage health
persistent session list
rolling live plots:
  ECG
  PPG RED/IR
  GSR
  IMU/motion
  temperature
gap/reboot discontinuities
simple display conversions only
```

Avoid adding historical replay here.

### Commit 4 — physical Phase-B validation

Expected direction:

```text
test(objective): validate live persistence and clinician monitoring
```

Scope:

```text
real ESP32
real PostgreSQL
real browser
backend restart recovery
storage interruption
slow live client
gap/reboot display
hardware-discovered fixes only
Phase-B validation record
```

If validation reveals defects, fix them inside this same commit packet before Phase B is accepted.

Avoid splitting trivial cleanup into extra commits.

---

## 41. What Immediately Follows Phase B

Only after Phase B is physically validated should the project enter Milestone C.

The next milestone may attach historical read/replay behavior to the durable packet rows:

```text
session history
    ↓
packet retrieval
    ↓
historical replay
    ↓
minimal justified display/processing improvements
```

Likely topics include:

```text
historical synchronized replay
multi-epoch timeline handling
display unit conversions
signal-quality presentation
only justified physiological features
```

Do not define the detailed Phase-C contract now.

Phase B should merely ensure its database and live contracts do not make replay unnecessarily difficult.

---

## 42. Phase Principle

The main Phase-B rule is:

> **The accepted-packet boundary is already validated. Attach useful consumers to it; do not redesign ingestion.**

In practical terms:

```text
ESP32 acquisition remains independent
device ingestion remains responsive
ACK remains an ingestion-memory acknowledgement
PostgreSQL becomes durable history
live WebSocket becomes disposable real-time delivery
browser slowness is isolated
storage slowness is isolated
raw packet data stays immutable
visualization stays descriptive rather than diagnostic
```

That is the smallest architecture that delivers the next visible product milestone without sacrificing replay or later processing.
