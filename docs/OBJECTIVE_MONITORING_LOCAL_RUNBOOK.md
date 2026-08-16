# Objective Monitoring — Local Runbook

These helpers operate only on the existing local objective PostgreSQL container and backend. Run them from any directory; they resolve the repository from their own location.

## Normal startup

1. Run `./start-local.sh`.
2. Wait for the backend listener.
3. Power or connect the ESP32.
4. Wait for device authentication.
5. Open <http://localhost:8080/clinician/objective>.
6. Click **Start monitoring**.

`start-local.sh` starts or reuses the exact configured PostgreSQL container, waits for readiness, derives its existing connection settings, loads the device token from ignored `firmware/secrets.h`, and runs `npm run dev` in the foreground. It does not install dependencies, run migrations, flash firmware, open a browser, or start a monitoring session.

## Normal shutdown

1. Click **Stop monitoring**.
2. Confirm the session is `COMPLETED`.
3. Power off or disconnect the ESP32.
4. Stop the backend with Ctrl+C.
5. Run `./stop-local.sh`.

`stop-local.sh` does not stop the backend or interact with the ESP32. It refuses to stop PostgreSQL if port 8080 is still listening on any local IPv4 or IPv6 interface, if it cannot verify the session table, or if any persisted session is not `COMPLETED`.

## Safety boundaries

- The scripts never create, recreate, remove, or prune Docker containers or volumes.
- Lifecycle automation never changes session rows or other database contents.
- Database migrations remain an explicit manual action when a schema change requires them.
- Firmware flashing remains explicit and manual.
- Database and device credentials remain in existing ignored local configuration and are not printed or copied into tracked files.
- Set `OBJECTIVE_DB_CONTAINER` or `OBJECTIVE_DEVICE_ID` only when intentionally targeting a different existing local configuration. Ambiguous or incomplete configuration fails closed.
