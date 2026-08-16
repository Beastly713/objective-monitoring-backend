#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DB_CONTAINER="${OBJECTIVE_DB_CONTAINER:-objective-phase-b-physical-validation}"

fail() {
  printf 'stop-local.sh: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' was not found in PATH."
}

container_env_value() {
  local key="$1"
  local environment_json
  environment_json="$(docker inspect --format '{{json .Config.Env}}' "$DB_CONTAINER")" || return 1
  printf '%s' "$environment_json" | OBJECTIVE_ENV_KEY="$key" node -e '
    const fs = require("node:fs");
    const key = process.env.OBJECTIVE_ENV_KEY;
    const values = JSON.parse(fs.readFileSync(0, "utf8") || "[]");
    let result = "";
    for (const value of values) {
      if (value.startsWith(`${key}=`)) result = value.slice(key.length + 1);
    }
    process.stdout.write(result);
  '
}

backend_port_state() {
  node -e '
    const net = require("node:net");

    function probe(options, unsupportedIsSafe = false) {
      return new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", (error) => {
          if (error.code === "EADDRINUSE") resolve("occupied");
          else if (
            unsupportedIsSafe &&
            ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)
          ) resolve("unsupported");
          else resolve("ambiguous");
        });
        server.listen(options, () => {
          server.close((error) => resolve(error ? "ambiguous" : "available"));
        });
      });
    }

    (async () => {
      const ipv4 = await probe({
        host: "0.0.0.0",
        port: 8080,
        exclusive: true,
      });
      if (ipv4 === "occupied") process.exit(10);
      if (ipv4 !== "available") process.exit(12);

      const ipv6 = await probe({
        host: "::",
        port: 8080,
        exclusive: true,
        ipv6Only: true,
      }, true);
      if (ipv6 === "occupied") process.exit(10);
      if (!["available", "unsupported"].includes(ipv6)) process.exit(12);
      process.exit(0);
    })().catch(() => process.exit(12));
  '
}

[[ "$DB_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || fail "OBJECTIVE_DB_CONTAINER is not a valid exact container name."
require_command docker
require_command node
cd -- "$SCRIPT_DIR"

docker inspect --type container "$DB_CONTAINER" >/dev/null 2>&1 \
  || fail "Docker container '$DB_CONTAINER' does not exist; no action taken."

container_status="$(docker inspect --format '{{.State.Status}}' "$DB_CONTAINER")" \
  || fail "could not determine the state of '$DB_CONTAINER'."
case "$container_status" in
  exited)
    printf 'PostgreSQL container %s is already stopped.\n' "$DB_CONTAINER"
    exit 0
    ;;
  running)
    ;;
  *)
    fail "container '$DB_CONTAINER' is '$container_status', not safely running or stopped; no action taken."
    ;;
esac

if backend_port_state; then
  :
else
  port_state=$?
  case "$port_state" in
    10)
      fail "port 8080 is still listening on a local interface. Stop npm run dev with Ctrl+C before stopping PostgreSQL."
      ;;
    *)
      fail "could not safely determine whether port 8080 is inactive; PostgreSQL remains running."
      ;;
  esac
fi

db_user="$(container_env_value POSTGRES_USER)" \
  || fail "could not inspect PostgreSQL configuration; PostgreSQL remains running."
db_name="$(container_env_value POSTGRES_DB)" \
  || fail "could not inspect PostgreSQL configuration; PostgreSQL remains running."
db_password="$(container_env_value POSTGRES_PASSWORD)" \
  || fail "could not inspect PostgreSQL configuration; PostgreSQL remains running."
db_user="${db_user:-postgres}"
[[ -n "$db_name" ]] \
  || fail "POSTGRES_DB is missing; session safety cannot be verified and PostgreSQL remains running."
[[ -n "$db_password" ]] \
  || fail "POSTGRES_PASSWORD is missing; session safety cannot be verified and PostgreSQL remains running."

if ! incomplete_result="$(
  PGPASSWORD="$db_password" docker exec -e PGPASSWORD "$DB_CONTAINER" \
    psql --no-psqlrc --username "$db_user" --dbname "$db_name" \
    --no-align --tuples-only --set ON_ERROR_STOP=1 \
    --command "SELECT count(*) FROM objective_sessions WHERE status <> 'COMPLETED';" \
    2>/dev/null
)"; then
  fail "could not verify objective_sessions safely; PostgreSQL remains running."
fi
unset db_password

incomplete_count="${incomplete_result//[[:space:]]/}"
[[ "$incomplete_count" =~ ^[0-9]+$ ]] \
  || fail "the session safety query returned an unexpected result; PostgreSQL remains running."
if (( incomplete_count > 0 )); then
  fail "refusing to stop PostgreSQL because a non-completed objective session exists. Return to the clinician UI/backend and complete the monitoring session first."
fi

printf 'Session safety check passed; all persisted objective sessions are COMPLETED.\n'
if ! docker stop --time 30 "$DB_CONTAINER" >/dev/null; then
  fail "Docker could not stop '$DB_CONTAINER' gracefully; inspect it manually."
fi
printf 'PostgreSQL container %s stopped successfully.\n' "$DB_CONTAINER"
