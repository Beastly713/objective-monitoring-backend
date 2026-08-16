#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DB_CONTAINER="${OBJECTIVE_DB_CONTAINER:-objective-phase-b-physical-validation}"
readonly DEVICE_ID="${OBJECTIVE_DEVICE_ID:-ESP32-0C2202BF1388}"
readonly SECRETS_FILE="${SCRIPT_DIR}/firmware/secrets.h"

fail() {
  printf 'start-local.sh: %s\n' "$*" >&2
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

check_backend_port() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen({ host: "127.0.0.1", port: 8080, exclusive: true }, () => {
      server.close((error) => process.exit(error ? 1 : 0));
    });
  '
}

[[ "$DB_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || fail "OBJECTIVE_DB_CONTAINER is not a valid exact container name."
[[ -n "$DEVICE_ID" ]] || fail "OBJECTIVE_DEVICE_ID must not be empty."
if [[ -v PORT && "$PORT" != "8080" ]]; then
  fail "PORT must be unset or exactly 8080 for this local lifecycle helper."
fi

require_command docker
require_command node
require_command npm
[[ -f "$SECRETS_FILE" ]] \
  || fail "missing ignored firmware/secrets.h; configure the device token locally first."
[[ -f "${SCRIPT_DIR}/package.json" ]] || fail "package.json is missing from ${SCRIPT_DIR}."
[[ -x "${SCRIPT_DIR}/node_modules/.bin/tsx" ]] \
  || fail "local dependencies are unavailable; install them explicitly before using this helper."

docker inspect --type container "$DB_CONTAINER" >/dev/null 2>&1 \
  || fail "Docker container '$DB_CONTAINER' does not exist; this helper will not create it."

device_token="$(node - "$SECRETS_FILE" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const match = source.match(/\bOBJECTIVE_DEVICE_TOKEN\b[^\r\n"]*"([^"\r\n]*)"/);
if (!match || !match[1].trim()) {
  console.error("start-local.sh: OBJECTIVE_DEVICE_TOKEN is missing or empty in firmware/secrets.h.");
  process.exit(1);
}
if (/change|replace|placeholder|your[-_ ]?token|todo/i.test(match[1])) {
  console.error("start-local.sh: OBJECTIVE_DEVICE_TOKEN still appears to be a placeholder.");
  process.exit(1);
}
process.stdout.write(match[1]);
NODE
)" || exit 1

db_user="$(container_env_value POSTGRES_USER)" \
  || fail "could not inspect PostgreSQL configuration in '$DB_CONTAINER'."
db_name="$(container_env_value POSTGRES_DB)" \
  || fail "could not inspect PostgreSQL configuration in '$DB_CONTAINER'."
db_password="$(container_env_value POSTGRES_PASSWORD)" \
  || fail "could not inspect PostgreSQL configuration in '$DB_CONTAINER'."
db_user="${db_user:-postgres}"
[[ -n "$db_name" ]] || fail "POSTGRES_DB is missing in '$DB_CONTAINER'; refusing to guess a database name."
[[ -n "$db_password" ]] \
  || fail "POSTGRES_PASSWORD is missing in '$DB_CONTAINER'; refusing to start without known credentials."

check_backend_port \
  || fail "port 8080 is already occupied or unavailable; stop the existing service yourself and retry."

container_status="$(docker inspect --format '{{.State.Status}}' "$DB_CONTAINER")" \
  || fail "could not determine the state of '$DB_CONTAINER'."
case "$container_status" in
  running)
    printf 'Reusing running PostgreSQL container %s.\n' "$DB_CONTAINER"
    ;;
  exited)
    printf 'Starting existing PostgreSQL container %s.\n' "$DB_CONTAINER"
    if ! docker start "$DB_CONTAINER" >/dev/null; then
      fail "could not start '$DB_CONTAINER'; resolve any reported Docker or port conflict manually."
    fi
    ;;
  *)
    fail "container '$DB_CONTAINER' is '$container_status', not safely running or stopped; no action taken."
    ;;
esac

printf 'Waiting up to 30 seconds for PostgreSQL readiness.\n'
readonly READY_DEADLINE=$((SECONDS + 30))
until docker exec "$DB_CONTAINER" pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1; do
  current_status="$(docker inspect --format '{{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || true)"
  [[ "$current_status" == "running" ]] \
    || fail "PostgreSQL container stopped before becoming ready; it was not recreated."
  (( SECONDS < READY_DEADLINE )) \
    || fail "PostgreSQL did not become ready within 30 seconds; it was not recreated or modified."
  sleep 1
done

binding_json="$(docker inspect --format '{{json (index .NetworkSettings.Ports "5432/tcp")}}' "$DB_CONTAINER")" \
  || fail "could not inspect the PostgreSQL host-port mapping."
db_endpoint="$(printf '%s' "$binding_json" | node -e '
  const fs = require("node:fs");
  const bindings = JSON.parse(fs.readFileSync(0, "utf8") || "null");
  if (!Array.isArray(bindings) || bindings.length === 0) process.exit(1);
  const ports = new Set();
  const hosts = new Set();
  for (const binding of bindings) {
    const port = Number(binding.HostPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
    ports.add(String(port));
    const configuredHost = String(binding.HostIp || "").trim();
    hosts.add(["", "0.0.0.0", "::"].includes(configuredHost) ? "127.0.0.1" : configuredHost);
  }
  if (ports.size !== 1) process.exit(1);
  let host;
  if (hosts.has("127.0.0.1")) host = "127.0.0.1";
  else if (hosts.size === 1) host = [...hosts][0];
  else process.exit(1);
  if (!host) process.exit(1);
  process.stdout.write(`${host}\t${[...ports][0]}`);
')" || fail "no single usable host mapping exists for PostgreSQL 5432/tcp; refusing to guess."
IFS=$'\t' read -r db_host db_port <<< "$db_endpoint"
[[ -n "$db_host" && -n "$db_port" ]] \
  || fail "the PostgreSQL host-port mapping was incomplete."

DATABASE_URL="$(
  OBJECTIVE_DB_USER_VALUE="$db_user" \
  OBJECTIVE_DB_PASSWORD_VALUE="$db_password" \
  OBJECTIVE_DB_NAME_VALUE="$db_name" \
  OBJECTIVE_DB_HOST_VALUE="$db_host" \
  OBJECTIVE_DB_PORT_VALUE="$db_port" \
  node -e '
    const encode = encodeURIComponent;
    const hostValue = process.env.OBJECTIVE_DB_HOST_VALUE;
    const host = hostValue.includes(":") ? `[${hostValue}]` : hostValue;
    process.stdout.write(
      `postgresql://${encode(process.env.OBJECTIVE_DB_USER_VALUE)}:` +
      `${encode(process.env.OBJECTIVE_DB_PASSWORD_VALUE)}@${host}:` +
      `${process.env.OBJECTIVE_DB_PORT_VALUE}/${encode(process.env.OBJECTIVE_DB_NAME_VALUE)}`,
    );
  '
)" || fail "could not construct the local PostgreSQL connection URL."

export DATABASE_URL
export OBJECTIVE_DEVICE_ID="$DEVICE_ID"
export OBJECTIVE_DEVICE_TOKEN="$device_token"
unset db_password device_token

printf 'PostgreSQL is ready at %s:%s.\n' "$db_host" "$db_port"
printf 'Starting the backend for device %s in the foreground. Press Ctrl+C to stop it.\n' "$OBJECTIVE_DEVICE_ID"
cd -- "$SCRIPT_DIR"
exec npm run dev
