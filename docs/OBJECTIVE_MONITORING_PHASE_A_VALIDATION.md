# Objective Monitoring Phase A Validation

Validated on 2026-08-16 with a physical ESP32-D0WD-V3 running V5.3 on Arduino ESP32 core 3.3.11 and the Node/TypeScript backend based on commit `10a1dd3` plus the integration fixes recorded in this commit.

- HELLO authentication, READY idle, backend-issued START/STOP, and UUID session binding were exercised against `/ws/objective/device` with real five-sensor packets.
- A healthy continuous run exceeded 60 seconds at approximately 10 packets/s and 13.9 KB/s. During that interval, invalid, duplicate, and gap counts remained zero, and every accepted packet received an ACK.
- Observed acquisition rates were ECG 250/s, PPG 100–101/s, GSR 127–129/s, IMU 99–101/s, and TEMP 2/s. MISS, ORDER, OVF, FUTURE, SPANERR, PPGFUT, I2CERR, TRUNC, SERERR, and BATCHMISS remained zero.
- STOP returned the device to `READY:1 STREAM:0` without disconnecting or stopping acquisition. Idle periods beyond the three-second ACK timeout remained stable. A new session on the same boot established a fresh sequence baseline, and stale in-flight frames from the completed session were neither published nor ACKed.
- Rebooting the ESP32 during an active session preserved its device ID, changed its boot ID, resumed the same backend session automatically, and established a new sequence/time epoch rather than a duplicate stream.
- Restarting the backend during an active session discarded the in-memory session by design. The ESP32 reauthenticated and remained idle until a new backend session was created, after which streaming resumed normally.
- A separate degraded-link interval produced forward gaps; the backend detected and recorded them without fabricating packets or terminating ingestion. It was not part of the healthy-run measurements above.
- No credential values were committed. `firmware/secrets.h` remained ignored.

Phase A physical ingestion validation is complete. Durable session and packet recovery across backend-process restarts remains work for the persistence phase.
