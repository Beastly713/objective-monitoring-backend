# Objective Monitoring — Phase C Validation

Validated on 2026-08-16 against the Phase-C working tree based on commit `9093aed`, including the inspection correctness closure in this commit.

## Validation scope

Validation covered the PostgreSQL replay manifest and bounded packet-window APIs, the real Chrome clinician REVIEW workspace, synchronized five-signal playback, continuity annotations and inspection, and a short physical LIVE regression. The main historical record was physical session `579e1422-139b-4cbc-8400-e5acc9df55ae`; isolated temporary database fixtures exercised an empty persisted session and stored-history-only loss without altering a useful recording.

## Runtime / browser / database

- ESP32-D0WD-V3 device `ESP32-0C2202BF1388`, firmware 5.3, with the physical AD8232 ECG, TinyGSR, MAX30101 PPG, MPU6050 IMU, and TMP117 temperature sensors.
- Node.js 24.11.0 and the repository's locally served uPlot 1.6.32.
- PostgreSQL 16.14 in the isolated `objective_validation` database with migration 001.
- Google Chrome 150.0.7871.186 loaded `/clinician/objective` from the backend origin. Runtime exception collection remained empty.
- No database URL, device token, or Wi-Fi credential is recorded in this repository.

## Historical manifest

Independent SQL over `objective_sessions` and `objective_packets` matched the API manifest for session `579e1422-139b-4cbc-8400-e5acc9df55ae`: `COMPLETED`, 9,220 packets, origin `1786829277308`, duration approximately 1,045,490.825 ms, first/last receipt `1786829277308` / `1786830322687`, 22 ingestion-gap events covering 252 missing packets, zero stored-history gaps, zero truncated packets, three boots, and four epochs.

The manifest exposed one same-boot `time_epoch` boundary at T+02:14.191 and two `device_reboot` boundaries at T+14:54.066 and T+17:24.693. Chrome rendered 22 accessible `I` markers, one `E`, and two `R` markers with factual labels. The selected-session summary displayed the same packet, gap, truncation, boot, and epoch facts.

## Bounded packet retrieval

The initial 30-second request returned 296 packets with `capped=false`; it did not download the full 9,220-packet session. A direct seek near the end requested only the neighboring windows beginning at 960,000, 990,000, and 1,020,000 ms. The final window returned eight packets. This is consistent with the browser's fixed three-chunk cache and did not iterate from zero.

A representative API `raw_packet` was deep-compared with its PostgreSQL JSON value and was unchanged. The existing automated route coverage also exercised the 60-second request limit, 1,000-row hard cap, invalid windows, pagination-safe history gaps, and 503 persistence-failure mapping. The physical session did not naturally reach the cap; deterministic UI coverage confirms a capped response is disclosed as incomplete rather than treated as complete.

## Five-signal synchronized replay

The initial real window contained 7,400 ECG samples, 2,967 PPG RED samples, 2,967 PPG IR samples, 3,788 GSR samples, 2,960 IMU samples, and 60 temperature samples. Chrome displayed ECG, PPG RED/IR, GSR, IMU magnitude, and temperature on the common 30-second session-relative viewport. Historical coordinates remained packet `replay_t0_ms + dt_us / 1000`; IMU magnitude and temperature Celsius remained display-only conversions.

The shared cursor propagated across all five uPlot instances. Moving it to approximately T+20 while playback was at T+5 retained the T+20 label and showed `—` for every value with a factual not-yet-presented message. At the real ingestion boundary near T+26.899, a cursor before the next temperature sample showed `—` instead of carrying a pre-gap value across the boundary. No interpolation was used.

## Playback / seek behavior

Play and pause advanced the single replay clock using elapsed browser time. Approximately 650 ms of real playback advanced by about 317, 650, 1,300, and 2,533 ms at 0.5×, 1×, 2×, and 4× respectively. Restart returned to zero. Playback clamped at the recorded duration and changed to `Replay complete`.

Repeated local and near-end seeks completed without loading preceding history. Switching between the real session, the stored-history fixture, and the empty session reset selection predictably. Focusing ECG left the selected session and T+100.000 position unchanged; returning to All restored all five existing chart instances without reloading the session.

## Ingestion-gap replay

The physical session's 22 stored ingestion events produced `I` timeline markers and chart discontinuities. The first was five missing packets before sequence 66498 at T+26.899. The marker used ingestion-gap wording, no samples were fabricated, and inspection did not carry an older value across that known boundary.

## Stored-history-gap replay

Temporary isolated session `00000000-0000-4000-8000-00000000c121` contained persisted sequences 100 and 102 in one boot and epoch, both with `gap_before=0`. Independent SQL and the API both derived one stored-history-only missing packet at T+00:00.200. Chrome showed one `H` marker labelled `Stored-history gap`, while ingestion events and missing packets remained zero. The fixture was removed after validation.

Automated coverage separately retains same-boot/same-epoch inference, same-boot/new-epoch reset, boot reset, and a middle-window first packet carrying its already-derived `history_gap_before`.

## Multi-epoch / reboot replay

The real session demonstrated both boundary types. The same physical boot with a new backend/time epoch rendered `E` / `Time/backend epoch`; later boot changes rendered `R` / `Device reboot`. Historical traces break at both kinds of boundary, and the UI does not describe the same-boot epoch change as a reboot.

## Live regression

After REVIEW validation, Chrome returned to LIVE and started physical session `9f219ae4-70c9-4de3-a80e-66d050d56080`. During the observed interval, the browser showed live ECG lead state, PPG RED/IR, raw GSR, IMU magnitude, and temperature at approximately 10 packets/s. The session completed with 151 persisted packets over approximately 15.1 seconds, no ingestion gap, invalid, or duplicate packet, and no storage error or drop. STOP returned the device to authenticated idle and the completed session appeared in persistent history.

This confirms the presentation correction did not alter live-from-now delivery, ingestion, ACK, persistence, or session lifecycle behavior. ACK remains the process-memory acceptance boundary rather than a durable PostgreSQL-commit acknowledgement.

## UI/UX validation

The REVIEW workspace was inspected through Chrome screenshots and DOM geometry at 1366×768, 1440×900, and 1920×1080. LIVE and REVIEW headings, controls, and context were distinct; reviewed-session identity, summary, continuity legend, focus controls, warnings, and signal cards were visible and understandable. Document width equaled viewport width at all three sizes, so no normal-width horizontal page overflow occurred.

The known zero-packet fixture displayed a valid empty replay state. Unknown-session and invalid-window APIs returned 404 and 400. A blocked packet-window request produced the visible replay failure/banner, and unblocking it followed by session selection recovered REVIEW; returning to LIVE also recovered normal live operation. The no-session-list and cap-warning contracts remain covered by the lightweight dashboard tests rather than manufactured against the physical acquisition path.

## Known limitations

- ACK confirms backend process-memory acceptance, not a durable PostgreSQL commit.
- The bounded in-memory persistence queue can lose historical copies during a sufficiently long database outage.
- The ESP32 network queue is bounded and can produce factual transport gaps; there is no offline store-and-forward.
- Cross-epoch wall placement uses the available backend anchors and is approximate; there is no precision absolute clock synchronization.
- Replay intentionally uses bounded HTTP windows and does not preload the full session.
- The page presents raw signals, factual continuity, lead state, and display-only unit conversions. It provides no physiological or clinical inference.
- The prototype clinician trust/authentication boundary remains unchanged.

## Phase-C conclusion

Phase C is validated complete. Independent PostgreSQL evidence agrees with the replay manifest; packet retrieval and browser memory remain bounded; direct seek, all playback controls, synchronized five-signal plots, inspection, focus, ingestion/history gaps, time epochs, and device reboots behave factually; empty and failure states recover; and the physical LIVE path remains healthy after REVIEW use. Repository tests, TypeScript build, browser JavaScript syntax, real Chrome validation, and the physical regression all passed.
