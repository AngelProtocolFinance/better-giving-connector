#!/usr/bin/env bash
# Read-only check: is the verification instance worth driving?
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"
verify_load

report="$EVIDENCE/doctor.txt"
: >"$report"
say() {
	printf '%s\n' "$1" | tee -a "$report"
}

fail() {
	say "doctor fail: $1"
	exit 1
}

if ! verify_tmux has-session -t "=$CONNECTOR_SESSION" 2>/dev/null; then
	fail "connector session ${CONNECTOR_SESSION} is not running"
fi
if ! verify_tmux has-session -t "=$FAKE_SESSION" 2>/dev/null; then
	fail "fake session ${FAKE_SESSION} is not running"
fi

listener="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
recorded="$(cat "$RUN_DIR/connector.pid" 2>/dev/null || true)"
if [[ -z "$listener" || "$listener" != "$recorded" ]]; then
	fail "port ${PORT} listener ${listener:-none} is not the launched connector pid ${recorded:-none}"
fi
cmd="$(ps -p "$listener" -o args=)"
case "$cmd" in
	*src/dev.ts*|*tsx*) ;;
	*) fail "port ${PORT} is pid ${listener} running: ${cmd}" ;;
esac
say "connector pid=${listener} port=${PORT}"

fake_pid="$(cat "$RUN_DIR/fake.pid" 2>/dev/null || true)"
if [[ -z "$fake_pid" ]] || ! sudo -n kill -0 "$fake_pid" 2>/dev/null; then
	fail "fake pid ${fake_pid:-none} is not running"
fi
say "fake pid=${fake_pid} origin=${FAKE_ORIGIN}"

docs="$(curl -sf "http://localhost:${PORT}/docs")"
if ! grep -q "Documentation — Better Giving Connector" <<<"$docs"; then
	fail "/docs did not serve the connector documentation page"
fi
say "docs=200 title=Documentation — Better Giving Connector"

hello="$(curl -sf --cacert "$CA_CERT" "${FAKE_ORIGIN}/connector/v1/hello")"
if ! grep -q '"service":"better-giving"' <<<"$hello"; then
	fail "fake /connector/v1/hello did not identify better-giving"
fi
if ! grep -q '"contract":1' <<<"$hello"; then
	fail "fake /connector/v1/hello contract was not 1"
fi
say "hello=200 service=better-giving contract=1"

resource="$(curl -sf "http://localhost:${PORT}/.well-known/oauth-protected-resource")"
if ! grep -q "\"resource\":\"${PUBLIC_URL}/mcp\"" <<<"$resource"; then
	fail "oauth protected resource is not ${PUBLIC_URL}/mcp"
fi
say "oauth-resource=${PUBLIC_URL}/mcp"

migrations="$(node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare("SELECT name FROM schema_migration ORDER BY name").all();
process.stdout.write(rows.map((row) => String(row.name)).join(","));
' "$RUN_DIR/local.db")"
if [[ "$migrations" != "0001_better_auth.sql,0002_connection.sql" ]]; then
	fail "schema_migration is ${migrations:-empty}"
fi
say "migrations=${migrations}"
say "node=$(node -v) package=better-giving-connector"
say "doctor ok"
