# Objective monitoring simulated demonstration

The simulated demonstration is an intentionally separate teaching and validation
harness for the objective-monitoring dashboard. It is available at
`/clinician/objective/demo` and is labelled:

> SIMULATED DEMONSTRATION — Deterministic synthetic sensor data — not live hardware or patient data.

It has its own in-memory accepted-packet bus, analysis-result bus, objective
analysis pipeline, live gateway, bounded session history, and replay endpoints.
It does not publish to or write to the production accepted-packet bus, packet
store, analysis stores, session manager, device registry, device gateway,
firmware, database, or production live WebSocket path. The signal generator
creates and validates Schema V1 packets before accepting them, then sends those
packets through the existing `ObjectiveAnalysisPipeline`.

## Scenarios

Each card starts one scenario and automatically runs a 30-second visible phase.
The pipeline receives a hidden 60-second baseline and, where required, hidden
changed-window priming. Hidden packets and results are never broadcast or
included in the visible replay.

| Scenario | Expected visible interpretation |
| --- | --- |
| Stable physiological baseline | `MM-08`, moderate evidence |
| Isolated cardiovascular change at rest | `MM-03`; ECG/PPG change together and `PPG-02` does not fire |
| Isolated electrodermal change | `MM-04`; GSR change without `MM-07` |
| Isolated local skin-temperature change | `MM-05` after the three-window persistence requirement |
| Corroborated multimodal physiological change | `MM-02`, corroborated evidence, ECG/PPG/GSR support |

Packets are generated at a 100 ms wall-time cadence with nominal raw rates of
ECG 250 Hz, PPG 100 Hz, GSR 128 Hz, IMU 100 Hz, and temperature 2 Hz. The
final visible window is closed by an analysis-only packet at the exact next
boundary; that packet is not sent to the demo live gateway or retained in demo
history.

## Endpoints

The demo uses these isolated endpoints:

* `GET /api/objective/demo/scenarios`
* `POST /api/objective/demo/start` with `{ "scenario_id": "..." }`
* `POST /api/objective/demo/stop`
* `GET /api/objective/demo/status`
* `GET /api/objective/demo/sessions`
* `GET /api/objective/demo/sessions/:id/replay`
* `GET /api/objective/demo/sessions/:id/replay/packets`
* `GET /api/objective/demo/sessions/:id/analysis`
* `GET /api/objective/demo/sessions/:id/final-analysis`
* `GET /ws/objective/demo/live/:sessionId`

The same dashboard bundle is reused with a demo configuration. The live page
continues to use `/api/objective` and `/ws/objective/live`; the demo page never
mixes those paths with its own data.

## Configuration and verification

The demonstration is enabled by default so the navigation button is available.
Set `OBJECTIVE_DEMO_ENABLED=false` (also accepts `0`, `off`, or `no`) to disable
the demo page, HTTP, and WebSocket routes while leaving the real monitoring
paths unchanged.

Useful checks from the repository root:

```text
npm test
npm run build
node --check public/objective/objective.js
git diff --check
```

Demo history is bounded to five sessions and expires idle retained sessions
after 45 minutes. It is process memory only and is deliberately not durable
patient or hardware history.
