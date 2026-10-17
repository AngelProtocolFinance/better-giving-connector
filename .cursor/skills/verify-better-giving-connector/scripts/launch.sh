#!/usr/bin/env bash
# Start one local connector and the fake donation site from an empty database.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"
ROOT="$(verify_root)"
cd "$ROOT"

if [[ -f "$ACTIVE" ]]; then
	echo "a verification instance is already active; run scripts/cleanup.sh before launch.sh" >&2
	exit 1
fi

if [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
	echo "node $(node -v); this repo requires Node 24 from .nvmrc" >&2
	exit 1
fi
if [[ ! -x "$ROOT/node_modules/.bin/tsx" ]]; then
	echo "dependencies are missing; from the repo root run: pnpm install --frozen-lockfile" >&2
	exit 1
fi
if [[ -f "$ROOT/.env.local" ]] && grep -q '^VERCEL=' "$ROOT/.env.local"; then
	echo ".env.local sets VERCEL, and pnpm dev would refuse a file: database" >&2
	exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 3)"
RUN_DIR="/tmp/bgc-verify-${RUN_ID}"
EVIDENCE="$ROOT/verify-evidence/${RUN_ID}"
PUBLIC_URL="http://localhost:3000"
FAKE_ORIGIN="https://give.example.org"
CONNECTOR_SESSION="bgc-verify-connector-${RUN_ID}"
FAKE_SESSION="bgc-verify-fake-${RUN_ID}"
CA_CERT="$RUN_DIR/ca.pem"
PORT="3000"
HOSTS_ADDED="0"

mkdir -p "$RUN_DIR" "$EVIDENCE"
chmod 700 "$RUN_DIR"

write_env() {
	cat >"$RUN_DIR/run.env" <<EOF
RUN_ID=${RUN_ID}
RUN_DIR=${RUN_DIR}
EVIDENCE=${EVIDENCE}
PUBLIC_URL=${PUBLIC_URL}
FAKE_ORIGIN=${FAKE_ORIGIN}
FAKE_HOST=give.example.org
CONNECTOR_SESSION=${CONNECTOR_SESSION}
FAKE_SESSION=${FAKE_SESSION}
CA_CERT=${CA_CERT}
HOSTS_ADDED=${HOSTS_ADDED}
PORT=${PORT}
EOF
	printf '%s\n' "$RUN_DIR/run.env" >"$ACTIVE"
}

on_fail() {
	status=$?
	if [[ "$status" -ne 0 ]]; then
		echo "launch failed; cleaning up this attempt" >&2
		if verify_tmux has-session -t "=$CONNECTOR_SESSION" 2>/dev/null; then
			verify_tmux capture-pane -t "$CONNECTOR_SESSION" -p -S -80 >&2 || true
		fi
		if verify_tmux has-session -t "=$FAKE_SESSION" 2>/dev/null; then
			verify_tmux capture-pane -t "$FAKE_SESSION" -p -S -40 >&2 || true
		fi
		"$HERE/cleanup.sh" || true
	fi
	exit "$status"
}
trap on_fail EXIT

write_env

openssl req -x509 -newkey rsa:2048 -keyout "$RUN_DIR/ca.key" -out "$CA_CERT" -days 2 -nodes -subj "/CN=bgc-verify-ca" >/dev/null 2>&1
openssl req -newkey rsa:2048 -keyout "$RUN_DIR/server.key" -out "$RUN_DIR/server.csr" -nodes -subj "/CN=give.example.org" >/dev/null 2>&1
printf 'subjectAltName=DNS:give.example.org\nextendedKeyUsage=serverAuth\n' >"$RUN_DIR/san.cnf"
openssl x509 -req -in "$RUN_DIR/server.csr" -CA "$CA_CERT" -CAkey "$RUN_DIR/ca.key" -CAcreateserial -out "$RUN_DIR/server.crt" -days 2 -extfile "$RUN_DIR/san.cnf" >/dev/null 2>&1
chmod 600 "$RUN_DIR/ca.key" "$RUN_DIR/server.key"
chmod 644 "$CA_CERT" "$RUN_DIR/server.crt"

if grep -qE '(^|[[:space:]])give\.example\.org([[:space:]]|$)' /etc/hosts; then
	HOSTS_ADDED="0"
else
	echo "127.0.0.1 give.example.org # bgc-verify-${RUN_ID}" | sudo -n tee -a /etc/hosts >/dev/null
	HOSTS_ADDED="1"
fi
write_env

if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
	echo "port 3000 is already in use; leave that process alone and free the port before launching" >&2
	exit 1
fi
if sudo -n lsof -nP -iTCP:443 -sTCP:LISTEN >/dev/null 2>&1; then
	echo "port 443 is already in use; leave that process alone and free the port before launching" >&2
	exit 1
fi

NODE="$(readlink -f "$(command -v node)")"
verify_tmux new-session -d -s "$FAKE_SESSION" -c "$ROOT" -- \
	sudo -n -E env PATH="$PATH" VERIFY_RUN="$RUN_DIR" \
	"$NODE" --import "$ROOT/node_modules/tsx/dist/esm/index.mjs" \
	"$HERE/fake-server.ts"

BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
CONNECTION_KEY_SECRET="$(openssl rand -base64 32)"
CRON_SECRET="$(openssl rand -base64 32)"
verify_tmux new-session -d -s "$CONNECTOR_SESSION" -c "$ROOT" -- \
	env \
	PUBLIC_URL="$PUBLIC_URL" \
	TURSO_DATABASE_URL="file:${RUN_DIR}/local.db" \
	BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
	CONNECTION_KEY_SECRET="$CONNECTION_KEY_SECRET" \
	CRON_SECRET="$CRON_SECRET" \
	NODE_EXTRA_CA_CERTS="$CA_CERT" \
	pnpm dev

ready=0
for _ in $(seq 1 200); do
	docs=0
	hello=0
	docs_body="$(curl -sf "http://localhost:${PORT}/docs" || true)"
	hello_body="$(curl -sf --cacert "$CA_CERT" "${FAKE_ORIGIN}/connector/v1/hello" || true)"
	if grep -q "Documentation — Better Giving Connector" <<<"$docs_body"; then
		docs=1
	fi
	if grep -q '"service":"better-giving"' <<<"$hello_body"; then
		hello=1
	fi
	if [[ "$docs" -eq 1 && "$hello" -eq 1 ]]; then
		ready=1
		break
	fi
	sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
	echo "connector or fake donation site did not become ready (docs ${#docs_body} bytes, hello ${#hello_body} bytes)" >&2
	curl -sv "http://localhost:${PORT}/docs" >&2 || true
	curl -sv --cacert "$CA_CERT" "${FAKE_ORIGIN}/connector/v1/hello" >&2 || true
	exit 1
fi

listener="$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t | head -n 1 || true)"
printf '%s\n' "$listener" >"$RUN_DIR/connector.pid"
if [[ -z "$listener" ]]; then
	echo "docs answered but nothing is listening on port ${PORT}" >&2
	exit 1
fi

migrations="$(node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare("SELECT name FROM schema_migration ORDER BY name").all();
process.stdout.write(rows.map((row) => String(row.name)).join(","));
' "$RUN_DIR/local.db")"
if [[ "$migrations" != "0001_better_auth.sql,0002_connection.sql" ]]; then
	echo "migrations were ${migrations:-missing}; expected 0001_better_auth.sql,0002_connection.sql" >&2
	exit 1
fi

cat >"$EVIDENCE/launch.txt" <<EOF
public=${PUBLIC_URL}
fake=${FAKE_ORIGIN}
docs=200 title=Documentation — Better Giving Connector
hello=200 service=better-giving
migrations=${migrations}
org=Hope Shelter
EOF

echo "ready public=${PUBLIC_URL} fake=${FAKE_ORIGIN} evidence=${EVIDENCE}"
trap - EXIT
