# Objective Monitoring — Phase B Validation

Validated on 2026-08-16 against the final Phase-B working tree based on commit `03ce857`, including the browser delivery-gap hardening recorded in this commit.

## Validation scope

The physical path exercised was the five-sensor ESP32 stream through `/ws/objective/device`, synchronous accepted-packet fan-out to both PostgreSQL and `/ws/objective/live/:sessionId`, and the clinician page at `/clinician/objective`. Normal streaming, raw persistence, START/STOP/history, backend recovery, completed-session non-resurrection, PostgreSQL interruption, a stalled live client, browser reconnect loss, forward gaps, and ESP32 reboot epochs were exercised.

## Physical stack

- ESP32-D0WD-V3 running `firmware/esp32_v5_3_backend_session.ino` / firmware 5.3.
- AD8232 ECG, TinyGSR, MAX30101 PPG, MPU6050 IMU, and TMP117 temperature sensors.
- Device `ESP32-0C2202BF1388`, connected over Wi-Fi; observed RSSI was approximately -54 to -58 dBm.

## Software/runtime stack

- Node.js 24.11.0, `pg` 8.23.0, and local uPlot 1.6.32.
- PostgreSQL 16.14 in an isolated validation database with migration 001 applied.
- Google Chrome 150.0.7871.186 loading the dashboard from the backend origin.
- No database URL, device token, or Wi-Fi credential was recorded or committed.

## Normal live-session result

Session `e27ff592-af68-485f-82c1-6bdc17b4134a` ran for approximately 262.5 seconds and persisted 2,573 accepted packets. A dedicated later 70-second healthy interval remained continuous: firmware reported 10 packets/s, ACK sequence advanced by 690, and firmware queue-drop, recovery-drop, ACK-timeout, reconnect, sensor-overflow, ordering, truncation, serialization, and I2C-error counters did not change. Backend accepted, ACK, and persisted counters advanced together; invalid and duplicate counts remained zero and storage queue depth remained zero.

Observed acquisition rates during that interval were ECG 249–251/s, PPG 100–101/s, GSR 128/s, IMU 100/s, and temperature 2/s. The browser visibly updated raw ECG, PPG RED and IR, raw GSR, acceleration magnitude, and temperature. The displayed X axes used the ESP-relative rolling time model.

The longer session also contained one separately identified 52-packet transport gap before sequence 4267. Serial evidence attributed it to the firmware's bounded network queue during a Wi-Fi transport stall: acquisition and sensor-buffer health stayed normal, while the network-queue drop counter increased. It was excluded from the clean interval above and was rendered as a discontinuity rather than hidden or interpolated.

## Persistence result

The final session row existed before streaming and ended `COMPLETED`. Its 2,573 durable packet rows used the `(session_id, boot_id, seq)` identity and retained packet-level timing and sequence metadata.

A representative row at sequence 3599 contained `session_id`, `boot_id`, `received_at_ms`, `sequence_status`, `gap_before`, `epoch_id`, `esp_anchor_us`, `backend_anchor_ms`, and `plot_t0_ms`. Its unchanged Schema-V1 `raw_packet` contained `n=[25,10,13,10,1]` and all five raw arrays. For example, TMP117 remained raw value 3025 and IMU remained six raw axes; the database did not contain dashboard temperature, acceleration-magnitude, filtered ECG, or derived PPG substitutions.

## START/STOP/history result

Creating a session produced a durable UUID row and the ESP32 then streamed under that same UUID. STOP sent the physical device back to authenticated idle operation, awaited the durable completion update, removed the dashboard's active live stream, and left the completed session visible through both the detail and recent-history APIs. The five-second stopped-packet grace behavior remained in place.

## Backend-restart recovery

While session `579e1422-139b-4cbc-8400-e5acc9df55ae` was LIVE, only Node was restarted. Startup reported one recovered session and initially represented it as `DISCONNECTED`. The ESP32 reauthenticated with unchanged boot ID `BOOT-02BF1388-221B8676`; the same durable session returned to LIVE, received START again, and continued accepting, ACKing, displaying, and persisting packets under the unchanged session UUID.

## Completed-session non-resurrection

After that session was stopped and durably `COMPLETED`, another backend restart reported zero recovered sessions. The ESP32 authenticated and remained connected idle with zero accepted packets and ACKs in the new process, `/api/objective/status` returned no active session, and the completed row remained queryable in history. No START was issued for the completed UUID.

## PostgreSQL interruption

PostgreSQL was stopped briefly during the physical live stream. While unavailable, accepted packets, ACKs, and live delivery continued; storage became degraded, the observed queue depth reached 19, and storage errors reached 22 at the sampled degraded snapshot, with no storage drops. After PostgreSQL restarted, the queue drained to zero, persisted count caught accepted count, storage returned healthy, and the accumulated error count was 51.

The injected interval also coincided with physical Wi-Fi/network-queue loss, which the backend exposed as forward gaps. This does not change the tested persistence boundary: database failure did not synchronously block acceptance, ACK, or live fan-out. It also does not strengthen the durability claim—ACK still does not mean a PostgreSQL commit, and an outage long enough to fill the 1,000-packet queue can lose persistence copies.

## Slow-client isolation

A clinician WebSocket completed a real upgrade and then stopped reading. Once the operating-system send buffers filled, `live.dropped_packets` rose to 653. At the sampled physical state, accepted, ACK, and persisted counts were all 7,937, storage queue depth was zero, and storage drops were zero. The stalled client therefore did not slow device ingestion or PostgreSQL and did not create an application-level replay queue.

The browser live socket was also closed for four seconds while the same physical session continued. On reconnect the next normal backend packet was displayed as `Live delivery gap before seq 69262`, and the chart inserted a null discontinuity. This viewer-only loss was not mislabeled as an ESP32/backend ingestion gap.

## Gap/reboot visualization

Physical forward gaps increased the backend gap counter and produced `sequence_status="gap"` with positive `gap_before`; the dashboard reported the affected sequence and inserted chart breaks without fabricating samples.

The ESP32 was reset through its CP210x control lines during the active durable session. The session UUID stayed `579e1422-139b-4cbc-8400-e5acc9df55ae`, while boot ID changed from `BOOT-02BF1388-86464403` to `BOOT-02BF1388-03E97682` and epoch changed from `c135e8fd-...` to `4477e4f6-...`. The dashboard directly displayed `Epoch/device reboot changed`, cleared the old rolling traces, began the new plots near relative time zero, and resumed all five signals without joining the two epochs.

## Known limitations

- Live clinician sockets are live-from-now only; there is no replay or database backfill.
- PostgreSQL buffering is in memory and bounded. There is no disk spool, Redis, or Kafka.
- Physical Wi-Fi stalls can exhaust the firmware's bounded network queue; these losses are visible as gaps and are not reconstructed.
- IMU magnitude and temperature Celsius are display-only conversions. No filtering, physiological derivation, interpretation, or alerting was validated or added.

## Phase-B conclusion

Phase B is physically validated complete. The real five-sensor ESP32 path sustained a healthy live interval, preserved raw packet truth in PostgreSQL, kept ACK independent from database commit, isolated slow storage and live consumers, recovered active durable identity after backend restart, did not resurrect completed sessions, and made backend, viewer-only, and reboot/epoch discontinuities visible. Existing automated tests also passed: 14 tests, zero failures, followed by a successful TypeScript build and browser-JavaScript syntax check.
