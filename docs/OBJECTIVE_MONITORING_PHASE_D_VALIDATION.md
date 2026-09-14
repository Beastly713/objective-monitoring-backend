# Objective Monitoring — Phase D Validation

Validated on 2026-09-14 against the completed objective-analysis pipeline. This document records the available real-stream evidence and the software checks required by the analysis specification. All outputs below are engineering observations and feature/quality states, not diagnoses or clinical conclusions.

## Real logged sensor-stream replay

No ESP32 or USB serial device was attached during this validation run, so no new live hardware session or live WebSocket acquisition was claimed. An existing persisted real ESP32 five-sensor recording was replayed through the repository's actual `AcceptedPacketBus` and `ObjectiveAnalysisPipeline`; no synthetic samples were generated.

Source session `59dfe47d-674f-4a92-906a-697e8f048796`, device `ESP32-0C2202BF138`:

- 1,055 persisted packets, one epoch, and one persisted sequence gap.
- 26,375 ECG, 10,580 PPG, 13,503 GSR, 10,550 IMU, and 211 temperature samples expanded onto the canonical ESP timestamp domain.
- 96 complete 10-second analysis windows on the one-second grid, covering replay time 0–105 seconds. The first and last windows retained their absolute sample timestamps.
- Paced delivery produced zero analysis queue drops, zero processing failures, and an empty queue before session stop.

Observed pipeline behavior for this recording:

- ECG lead-off was asserted in the raw samples, producing `unavailable` ECG quality, zero detected beats, and the deterministic `ECG-02` rule output. No ECG millivolt conversion was attempted.
- The recording produced no valid PPG pulse intervals, so PPG pulse/rate/amplitude features remained unavailable. A clean stationary PPG run is still required before approving physical pulse-detector behavior.
- GSR raw values were saturated at 2047 with zero slope, producing `limited` quality. No absolute legacy-TinyGSR conductance was reported.
- IMU conversion and movement features were exercised; the observed movement levels were `low`/`moderate` and quality was `good`/`limited` across windows.
- TMP117 conversion produced approximately 23.66–23.73 °C and exercised the temperature feature/quality path.
- Baseline collection reached completion for the recording; ready modality baselines were IMU and temperature. Overall baseline readiness remained false because the other modalities did not provide eligible evidence.
- Deterministic rule output included `MM-07`; it is preserved as an engineering pattern identifier only.
- Requesting session stop after the queue drained left zero queued packets and no processing failures. The stopped session state was released as specified.

This replay validates raw sample expansion, canonical timestamps, epoch/window coordinates, gap propagation, feature calculation, quality classification, baseline state, rule evaluation, serialized processing, and stop/drain behavior against real logged data. It does not establish live hardware timing or sensor-specific physical calibration.

## Automated validation

The repository objective suite passed: **65 tests, 0 failures**. Coverage includes conversions, timestamp/window boundaries, gaps and out-of-order samples, ECG/PPG detector state, GSR/IMU/temperature features, quality precedence, baseline readiness, modality and multimodal rules, rule persistence/reset, queue ordering/drops, epoch transitions, session stop/drain, asynchronous persistence and idempotency, live `analysis_update`, bounded historical retrieval, REVIEW synchronization, and analysis failure isolation.

Also passed:

- `npm run build`
- `node --check public/objective/objective.js`
- `git diff --check`

The automated integration tests cover live delivery, persistence, historical retrieval, and dashboard behavior using deterministic fixtures. No implementation defect was found, so no production code or specified algorithm was changed during this validation commit.

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
