# Objective Monitoring — Phase D Validation

Validated on 2026-09-15 against the `analysis-2.0` objective-analysis pipeline. This document records the available real-stream evidence and the software checks required by the analysis specification. All outputs below are engineering observations and feature/quality states, not diagnoses or clinical conclusions.

## Real logged sensor-stream replay

No ESP32 or USB serial device was attached during this validation run, so no new live hardware session or live WebSocket acquisition was claimed. The existing persisted real ESP32 five-sensor recording was replayed through the repository's actual `AcceptedPacketBus` and `ObjectiveAnalysisPipeline`; no synthetic samples were generated.

Source session `59dfe47d-674f-4a92-906a-697e8f048796`, device `ESP32-0C2202BF138`:

- 1,055 persisted packets, one epoch, and one persisted sequence gap.
- 26,375 ECG, 10,580 PPG, 13,503 GSR, 10,550 IMU, and 211 temperature samples expanded onto the canonical ESP timestamp domain.
- The new scheduler produced 10 complete non-overlapping 10-second windows (`0–10` through `90–100` seconds), not the former 96 overlapping windows on a one-second grid.
- Session stop drained all completed window work before final synthesis. The real stream ended at `105,598.897 ms`, so final synthesis recorded the incomplete `100,000–105,598.897 ms` tail (`5,598.897 ms`) and no missing windows.
- The paced replay produced zero analysis queue drops, zero processing failures, and an empty queue before stop. Final runtime analysis state was `complete`.

The rounded 10-window/5-second-tail contract is also covered by the automated window-engine and stop/finalization tests. The packet callback now performs bounded raw collection and metadata tracking; expansion, feature extraction, quality evaluation, baseline updates, rules, and multimodal evaluation run once per completed window in the serialized analysis worker.

Observed pipeline behavior for this recording:

- ECG lead-off was asserted in the raw samples, producing `unavailable` ECG quality, zero detected beats, and the deterministic `ECG-02` rule output. No ECG millivolt conversion was attempted.
- The recording produced no valid PPG pulse intervals, so PPG pulse/rate/amplitude features remained unavailable. A clean stationary PPG run is still required before approving physical pulse-detector behavior.
- GSR raw values were saturated at 2047 with zero slope, producing `limited` quality. No absolute legacy-TinyGSR conductance was reported.
- IMU conversion and movement features were exercised; the observed movement levels were `low`/`moderate` and quality was `good`/`limited` across windows.
- TMP117 conversion produced approximately 23.66–23.73 °C and exercised the temperature feature/quality path.
- Baseline collection reached completion for the recording; ready modality baselines were IMU and temperature. Overall baseline readiness remained false because the other modalities did not provide eligible evidence.
- Deterministic rule output included `MM-07`; it is preserved as an engineering pattern identifier only.
- Requesting session stop after the queue drained left zero queued packets and no processing failures. The stopped session state was released as specified.

This replay validates raw sample expansion, canonical timestamps, epoch coordinates, gap propagation, feature calculation, quality classification, baseline state, rule evaluation, final synthesis ordering, and sensor-specific engineering observations against real logged data. As before, it does not establish live hardware timing or sensor-specific physical calibration; asynchronous database persistence and API behavior are covered by the automated tests.

## Automated validation

The repository objective suite passed: **71 tests, 0 failures**. Coverage includes conversions, timestamp/window boundaries, non-overlapping 10-second windows and incomplete tails, gaps and out-of-order samples, ECG/PPG detector state, GSR/IMU/temperature features, quality precedence, baseline readiness, modality and multimodal rules, rule persistence/reset, completed-window queue ordering/drops, epoch transitions, session stop/final synthesis ordering, asynchronous window/final-analysis persistence and idempotency, live `analysis_update`, collection progress, delivery telemetry, bounded historical retrieval, REVIEW synchronization, and analysis failure isolation.

Also passed:

- `npm run build`
- `node --check public/objective/objective.js`
- `git diff --check`

The automated integration tests cover live delivery, persistence, historical retrieval, final-analysis API state, and dashboard behavior using deterministic fixtures. The conversion, feature, quality, baseline, and rule algorithms remain unchanged; the production changes are limited to completed-window scheduling, final synthesis/persistence, status/API/UI integration, and the associated version contract.

## Physical validation still unavailable

The following require a connected and observed hardware run and were not re-run in this environment:

- live ESP32 ingestion/ACK and live `analysis_update` observation;
- AD8232 variant/lead-off verification, observed ECG rate/jitter, and visual confirmation of beat/RR/heart-rate detections on a stationary waveform;
- MAX30101 configuration/rate verification, stationary pulse/rate/amplitude confirmation, and deterministic motion-quality interaction;
- legacy TinyGSR board/library/rate verification, known-resistor response, and response-direction check;
- IMU principal-orientation 1 g checks, gyro bias, axis/sign verification, and observed rate;
- TMP117 raw-code/rate verification, placement, self-heating, and multi-minute trend observation;
- live physical persistence, historical REVIEW inspection after that live session, and live epoch-transition/failure-isolation observation.

No SpO2, absolute ECG mV, or absolute legacy-TinyGSR µS result was introduced.

## Observer-facing analysis flow

LIVE mode now exposes the analysis lifecycle directly: the dashboard shows the currently collecting 10-second window and progress, the latest completed window, baseline readiness, worker queue/drop state, delivery counts, runtime/storage health, and the most recent sample time. Completed `analysis_update` results are retained as a bounded chronological list; selecting an older row changes only the detailed analysis panel and does not redraw the raw signal charts.

The detailed window view includes the analysis version, window/epoch identity, explanation, supporting and contradicting evidence, source continuity, per-modality quality/features/baseline relations, and fired plus non-fired rule evaluations. After STOP, the final panel remains explicitly pending until persisted final synthesis is available. REVIEW mode loads the same final-analysis endpoint independently from replay packets and provides a bounded list of loaded historical analysis windows, with stale session responses ignored.

## Replay coordinate invariant

For a single epoch, raw and analysis history use the same session-relative canonical coordinate. Raw packet samples use `backend_anchor_ms + (packet_t0_us - esp_anchor_us) / 1000 - session_origin_ms`; completed analysis windows use `backend_anchor_ms + (window_start_us - esp_anchor_us) / 1000 - session_origin_ms` (and the corresponding end time). The window engine derives completed boundaries from that canonical timeline, so no clipping or coordinate-semantic change was introduced while adding the observer UI. Repository inspection and the existing replay/history tests did not reproduce a timestamp mismatch or establish a code defect; no speculative timestamp fix was made.
