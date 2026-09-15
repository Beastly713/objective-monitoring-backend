# Objective monitoring simulated demonstration

The simulated demonstration is a small mentor-facing teaching harness at
`/clinician/objective/demo`. It has its own HTML, CSS, JavaScript, in-memory
buses, and `ObjectiveAnalysisPipeline`. It is not a second clinician monitor.

The production page at `/clinician/objective` remains a production-only
application. Synthetic packets never enter the production accepted-packet bus,
session manager, device registry, device gateway, packet store, analysis store,
database, history routes, or production live WebSocket.

## Purpose and warning

The page permanently displays:

> SIMULATED DEMONSTRATION — Deterministic synthetic sensor data. Not live hardware data and not patient data.

The demonstration shows raw synthetic ECG, PPG, GSR/EDA, IMU, and temperature
streams flowing through Schema V1 validation and the existing deterministic
analysis pipeline. Its outputs are engineering observations only, not
diagnoses, impairment decisions, or emergency decisions.

## Scenarios

Exactly five scenarios are available:

| Scenario | Expected pipeline contract |
| --- | --- |
| Stable physiological baseline | `No material change from session baseline observed`, `MM-08`, moderate evidence |
| Isolated cardiovascular change at rest | `Isolated cardiovascular change observed`, `ECG-01`, `PPG-01`, `MM-03`, limited evidence; no `PPG-02` |
| Isolated electrodermal change | `Isolated electrodermal change observed`, `GSR-01`, `MM-04`, limited evidence |
| Isolated local skin-temperature change | `Isolated local skin-temperature change observed`, `TEMP-01`, `MM-05`, limited evidence |
| Corroborated multimodal physiological change | `Multi-modality physiological change observed`, `ECG-01`, `PPG-01`, `GSR-01`, `MM-02`, corroborated evidence; ECG/PPG/GSR support |

The catalog expectations validate actual pipeline output. They never replace,
edit, or hide an `AnalysisResult`.

## Timing and analysis

Each run has a hidden 60-second baseline and scenario-specific hidden priming:

* stable baseline: 0 seconds
* cardiovascular change: 10 seconds
* electrodermal change: 10 seconds
* temperature change: 20 seconds
* multimodal change: 30 seconds

Hidden packets enter only the isolated analysis pipeline. They are not sent to
the browser and do not become visible analysis windows. The visible phase is
exactly 30 seconds with the real completed-window boundaries:

* W1: `[0 s, 10 s)`
* W2: `[10 s, 20 s)`
* W3: `[20 s, 30 s)`

An internal exact-boundary packet closes W3; it is analysis-only and is not
shown as an extra graph packet. The final synthesis is generated with
`synthesizeFinalSessionAnalysis` from only those three rebased visible results,
with a 30,000 ms visible epoch coverage and no missing windows or incomplete
tail.

Packets are deterministic and validated as Schema V1 at nominal rates of ECG
250 Hz, PPG 100 Hz, GSR 128 Hz, IMU 100 Hz, and temperature 2 Hz. The browser
uses uPlot and appends the received raw points on a fixed scenario-relative
0–30 second axis without interpolation or filtering.

## One-click flow

1. The mentor selects **Run scenario** on a scenario card.
2. `POST /api/objective/demo/start` prepares the hidden baseline and priming,
   drains the isolated pipeline, verifies all five baseline modalities, and
   returns `READY` without publishing a visible packet.
3. The browser connects to `/ws/objective/demo/live/:sessionId` and installs
   packet and analysis handlers. The gateway sends its `ready` message.
4. The browser automatically calls `POST /api/objective/demo/run`.
5. Only then does the runtime publish the visible 30-second stream and actual
   completed-window analysis updates.

The two-stage handshake prevents the first visible packet from racing the
browser WebSocket connection. The demo WebSocket emits only `ready`, `packet`,
and `analysis_update` messages.

## Endpoints and storage

* `GET /api/objective/demo/scenarios`
* `POST /api/objective/demo/start` with `{ "scenario_id": "..." }`
* `POST /api/objective/demo/run` with `{ "session_id": "..." }`
* `POST /api/objective/demo/abort` with `{ "session_id": "..." }` for automatic failed-handshake cleanup
* `GET /api/objective/demo/status`
* `GET /api/objective/demo/result` for the current run
* `GET /ws/objective/demo/live/:sessionId`

Only the current run is retained in process memory. There is no demo database
write, persisted history, historical replay, session browser, hardware
interaction, device/ACK simulation, or production-shaped status response.

Set `OBJECTIVE_DEMO_ENABLED=false` (also `0`, `off`, or `no`) to disable the
demo page, HTTP routes, and WebSocket route while leaving production monitoring
available.

## Validation

From the repository root:

```text
npm test
npm run build
node --check public/objective/objective.js
node --check public/objective/demo.js
git diff --check
```
