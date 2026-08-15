# Objective Monitoring — Next Phase Specification
## Phase A: Session-Aware Backend Ingestion

> **Purpose of this file**
>
> This document defines only the next implementation phase.
> It is intentionally more specific than the global specification, but it still avoids premature details that are better decided while coding.
>
> Goal: replace the diagnostic WebSocket receiver with the smallest real backend ingestion boundary without disturbing the validated ESP32 acquisition system.

---

## 1. Phase Goal

At the end of this phase, the system should be:

```text
ESP32
  ↓
WebSocket
  ↓
real Node/TypeScript backend
  ↓
authenticated/session-bound connection
  ↓
packet validation
  ↓
sequence + timing metadata
  ↓
accepted-packet handoff
  ↓
ACK
```

This phase should establish a stable backend boundary that the following phase can connect to:

```text
live clinician fan-out
persistence
dashboard
```

without redesigning ingestion.

---

## 2. What We Start With

Known-good firmware:

```text
esp32_v5_2_websocket.ino
```

Known-good diagnostic receiver:

```text
objective_ws_receiver_v2.mjs
```

The receiver already proves the basic behavior we need to preserve:

```text
WebSocket connection
JSON parsing
schema validation
sequence tracking
ACK:<seq>
~10 packets/sec
reconnect behavior
```

V5.2 acquisition/network separation must remain intact.

---

## 3. Phase Scope

Implement:

1. Node.js + TypeScript backend skeleton.
2. Device WebSocket endpoint.
3. Small device registry.
4. Device authentication handshake.
5. Backend monitoring-session model.
6. Stable `device_id`.
7. Per-boot `boot_id`.
8. Backend-issued `session_id`.
9. Packet/session association.
10. Stronger packet validation.
11. Sequence/gap/duplicate handling.
12. Basic backend time envelope.
13. Accepted-packet internal handoff.
14. Existing application ACK behavior.
15. Minimal ESP32 transport/session changes required to support the contract.
16. End-to-end validation against the actual ESP32.

---

## 4. Explicitly Out of Scope

Do **not** add during this phase:

```text
PostgreSQL persistence
database schema
browser dashboard
mobile UI
historical replay
Redis
Kafka
microservices
signal filtering
feature extraction
ML
physiological interpretation
binary transport
offline store-and-forward
```

The accepted-packet handoff should make persistence/live fan-out easy to attach next, but neither is required to complete this phase.

---

## 5. Phase Architecture

```text
                         Node / TypeScript Backend

ESP32
  │
  │ WebSocket
  ▼
Device Gateway
  │
  ├── connection registry
  ├── HELLO/authentication
  ├── session binding
  │
  ▼
Packet Validator
  │
  ▼
Sequence / Time Handler
  │
  ▼
Accepted Packet Boundary
  │
  └── temporary in-process consumer/logging for this phase
  │
  ▼
ACK:<seq>
```

All components may live inside one backend process.

No distributed queue is needed.

---

## 6. Identity Contract

### `device_id`

Stable identifier for the physical ESP32.

It survives:

```text
reboot
reconnect
different monitoring sessions
```

### `boot_id`

Created once per ESP32 boot.

The current V5.2 locally generated pseudo-session identifier can be reused conceptually as the boot identity.

A changed `boot_id` means the ESP32 restarted.

### `session_id`

Created by the backend for an objective monitoring session.

It must not be confused with an ESP32 boot.

### `patient_id`

Application/backend concern only.

The ESP32 does not need to know it.

For this phase, the backend only needs enough session metadata to bind:

```text
session_id
device_id
status
```

Full patient/database modeling is deferred.

---

## 7. Device Authentication

Keep authentication intentionally small.

Provision the ESP32 with:

```text
device_id
device_token
```

The device sends a first application message after WebSocket connection:

```json
{
  "type": "hello",
  "protocol": 1,
  "device_id": "ESP32-...",
  "boot_id": "...",
  "firmware": "5.3",
  "token": "..."
}
```

Backend behavior:

```text
unknown device/token
→ reject connection

valid device/token
→ register connection
→ mark device ready
```

Do not log the secret token.

For the prototype, credentials may come from backend environment/config rather than a database.

---

## 8. One Active Connection Per Device

Backend maintains approximately:

```text
device_id → active WebSocket
```

If a second authenticated connection appears for the same `device_id`:

```text
new connection wins
old connection closes
```

This prevents stale duplicate connections from producing conflicting streams.

---

## 9. Session Lifecycle for This Phase

Minimal useful lifecycle:

```text
WAITING
   │
   │ device connected + session activated
   ▼
LIVE
   │
   ├── temporary disconnect
   │       ↓
   │   DISCONNECTED
   │       │
   │       └── reconnect → LIVE
   │
   └── explicit stop → COMPLETED
```

A network disconnect must not automatically create a new monitoring session.

Backend session identity remains the same across normal reconnects.

---

## 10. Minimal Session Control

The backend may use simple text commands:

```text
START:<session_id>
STOP:<session_id>
```

The ESP32 does not need a full JSON parser for backend control messages.

During this phase:

```text
sessionActive == true
→ send sensor packets

sessionActive == false
→ stay connected but do not transmit sensor batches
```

The acquisition system may continue operating independently.

The application ACK watchdog must apply only while active sensor streaming is expected.

---

## 11. Sensor Packet Contract

Do not redesign the sensor packet.

Keep schema V1:

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

The only semantic change is that `session_id` should represent the backend-issued monitoring session rather than a locally invented boot/session identity.

Raw sensor arrays remain unchanged.

---

## 12. Validation Required in This Phase

Start from the existing receiver V2 validator and strengthen it only where cheap and useful.

Validate:

```text
schema == 1
session_id exists and matches bound session
seq is a valid integer
timebase == "esp_timer_us"

created_us / t0_us / t1_us valid
t0_us <= t1_us <= created_us
packet span <= 150 ms

truncated is 0/1

n has five entries
n entries match array lengths

arrays exist:
ecg
ppg
gsr
imu
temp
```

Also validate sample shapes and basic numeric types:

```text
ECG  [dt_us, adc, loPlus, loMinus]
PPG  [dt_us, red, ir]
GSR  [dt_us, raw]
IMU  [dt_us, ax, ay, az, gx, gy, gz]
TEMP [dt_us, raw]
```

For every sample:

```text
dt_us >= 0
dt_us <= packet span
timestamps within each sensor stream do not go backwards
```

Respect firmware batch maxima:

```text
ECG  <= 64
PPG  <= 32
GSR  <= 32
IMU  <= 32
TEMP <= 4
```

Do not add expensive validation beyond what is useful for protecting the ingestion boundary.

---

## 13. `truncated` Handling

A packet with:

```text
truncated = 1
```

is not automatically invalid.

Behavior:

```text
accept
mark metadata as truncated
continue
ACK
```

The flag represents a valid but incomplete batch.

---

## 14. Sequence Handling

Track sequence state per:

```text
(session_id, boot_id)
```

Classification:

```text
first packet
→ establish sequence baseline

seq == previous + 1
→ normal

seq > previous + 1
→ forward gap

seq <= previous
→ duplicate/stale/non-forward
```

### Forward gap

```text
record gap_before
accept packet
continue
ACK packet
```

Do not invent missing data.

### Duplicate/stale

```text
ACK packet
do not emit it through the accepted-packet boundary again
```

This protects later storage and charts from duplicate points.

### Reboot

A changed `boot_id` starts a new sequence epoch.

Do not treat a valid sequence restart after reboot as ordinary packet corruption.

---

## 15. ACK Contract

Keep the existing wire format:

```text
ACK:<seq>
```

ACK only after the packet has:

```text
passed authentication/session checks
parsed
validated
sequence-classified
been accepted into the backend ingestion path
```

ACK does not wait for future database or browser work.

Invalid packets are not ACKed.

---

## 16. Invalid / Protocol Error Behavior

### Isolated malformed packet

```text
increment invalid count
do not ACK
keep connection alive
```

### Repeated malformed traffic

The backend may close the connection after a small consecutive-failure threshold if implementation testing shows this is useful.

Do not over-design a NACK protocol in this phase.

### Authentication or session mismatch

Examples:

```text
invalid device token
packet session_id != bound session
```

Reject/close the connection.

These are protocol-boundary failures rather than ordinary packet corruption.

---

## 17. Time Envelope

Do not modify the raw ESP32 timestamps.

For every accepted packet, add backend metadata such as:

```text
received_at_ms
boot/session epoch
gap_before
```

For later visualization, preserve enough information to derive:

```text
sample_esp_us = packet.t0_us + dt_us
```

and relative plot time.

For this phase, a simple first-packet anchor is enough:

```text
esp_anchor_us
backend_anchor_ms
```

This may later support approximate wall-clock mapping.

Do not implement precision clock synchronization now.

---

## 18. Accepted Packet Boundary

The internal object should conceptually contain:

```text
device_id
boot_id
session_id

received_at_ms

sequence_status
gap_before

raw_packet
```

The raw packet must remain unchanged.

For this phase, the accepted packet may simply be handed to an in-process callback/event emitter and counted/logged.

The next phase will attach:

```text
live fan-out
persistence
```

to this exact boundary.

---

## 19. Backend Structure

Keep the initial codebase small.

A reasonable structure is:

```text
src/
  objective/
    deviceGateway.ts
    packetValidator.ts
    sessionManager.ts
    sequenceTracker.ts
    timeMapper.ts
    acceptedPacketBus.ts
```

This is organization inside **one process**, not separate services.

If fewer files are cleaner during implementation, combine them.

Do not create abstractions purely to match this diagram.

---

## 20. Minimal ESP32 Delta

Create the next firmware version from V5.2 rather than rewriting the network layer.

Target delta only:

```text
stable device_id
boot_id
backend-issued session_id storage
HELLO on connection
START:<session_id>
STOP:<session_id>
sessionActive state
ACK watchdog active only when streaming
send batches only when sessionActive
```

Preserve:

```text
sensor task/core placement
sensor sampling rates
PPG timestamp logic
ring buffers
100 ms packetizer
raw sample schema
network queue
network task
WebSocket heartbeat
send failure recovery
application ACK watchdog
reconnect behavior
```

V5.2 remains the known-good rollback/reference point.

---

## 21. Development Compatibility

During backend development, do not destroy the working receiver.

Keep:

```text
objective_ws_receiver_v2.mjs
```

as the transport reference/debug tool.

Build the new backend separately.

Once the real backend passes the same health/recovery checks, it becomes the primary receiver.

---

## 22. Phase Observability

We need only enough logs/counters to prove correctness.

Track approximately:

```text
connected devices
accepted packets/sec
bytes/sec
latest sequence
sequence gaps
duplicates/non-forward packets
invalid packets
reconnects
active session
ACK activity
```

Do not build a full observability platform.

These counters will later feed dashboard health cards.

---

## 23. End-to-End Tests Required

### A. Normal streaming

Expected:

```text
~10 packets/sec
valid packets
ACK follows sequence
no unexpected gaps
ESP32 acquisition health unchanged
```

### B. Reconnect and backend restart

```text
Device/WebSocket reconnect while backend remains running:
same monitoring session survives
device reauthenticates
existing session resumes

Full backend-process restart in Phase A:
in-memory sessions are lost by design
device reconnects and reauthenticates safely
device remains idle
a new monitoring session must be created
```

Durable backend-session recovery belongs to the persistence phase.

### C. Duplicate/stale handling

Inject/replay a duplicate test packet and verify:

```text
ACK returned
packet not emitted twice through accepted-packet boundary
```

### D. Sequence gap

Inject a controlled missing sequence and verify:

```text
gap recorded
new packet accepted
stream continues
```

### E. Invalid packet

Verify:

```text
rejected
not ACKed
connection remains usable for isolated failure
```

### F. Session mismatch

Verify:

```text
rejected / connection closed
```

### G. ESP32 reboot

Verify:

```text
new boot_id
new sequence epoch
not misclassified as ordinary backward sequence
```

---

## 24. Definition of Done

This phase is complete when:

```text
✅ real Node/TypeScript backend replaces receiver for normal ingestion
✅ device authenticates
✅ backend knows device_id and boot_id
✅ backend-issued monitoring session is bound to the connection
✅ existing sensor schema is accepted unchanged
✅ packet validation passes healthy traffic
✅ sequence gaps are detected without killing stream
✅ duplicates are not emitted twice
✅ boot epochs are distinguished
✅ time metadata is attached without altering raw timestamps
✅ ACK:<seq> behavior remains healthy
✅ device reconnect resumes the existing in-memory session
✅ backend-process restart fails safely to authenticated idle
✅ ESP32 acquisition health remains unchanged
✅ accepted-packet boundary exists for next-phase live/storage consumers
```

No database or clinician UI is required for this phase to be complete.

---

## 25. Commit Plan

Keep this phase to roughly four meaningful commits.

### Commit 1 — backend foundation

```text
feat(objective-backend): add session-aware ingestion skeleton
```

Includes:

```text
Node/TypeScript service
WebSocket device gateway
ported V2 packet validator
basic health logging
```

### Commit 2 — identity/session ingestion contract

```text
feat(objective-backend): add device auth session binding and stream tracking
```

Includes:

```text
HELLO auth
device registry
session manager
sequence/gap handling
time envelope
accepted-packet boundary
ACK behavior
```

### Commit 3 — minimal ESP32 session protocol

```text
feat(objective-firmware): add backend session control on top of v5.2
```

Includes only the minimal V5.3 transport/session delta.

### Commit 4 — end-to-end validation

```text
test(objective): validate session-aware ingestion and recovery
```

Includes fixes required by real ESP32 testing and records the final healthy behavior.

Avoid splitting trivial refactors into extra milestone commits.

---

## 26. What Immediately Follows This Phase

Only one broad phase should follow before we have a visually useful, persistent system:

```text
accepted-packet boundary
        │
        ├── live browser/mobile fan-out
        └── PostgreSQL packet persistence
```

Then build the synchronized clinician dashboard and history/replay on top.

Do not divert into ML, elaborate signal processing, new sensors, distributed streaming infrastructure, or unrelated backend abstractions before the live + stored end-to-end path is finished.
