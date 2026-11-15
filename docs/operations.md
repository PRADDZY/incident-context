# Deployment and recovery

This is a single-host demonstration: a self-hosted HydraDB 0.4.0 engine and authenticated Node backend on Linux, an outbound Cloudflare Quick Tunnel, and a stable Cloudflare Worker serving the UI and Workers AI orchestration. The host must stay running. A small VPS and a temporary Quick Tunnel are operational dependencies; this setup makes no production availability guarantee.

The application is [MIT licensed](../LICENSE). HydraDB is a separate dependency under Elastic License 2.0, as identified by its upstream `LICENSE`; the application's MIT license does not relicense the engine. Keep upstream notices with any engine distribution and review its license for your intended use.

## Prerequisites and boundaries

Use a Linux host with Docker Engine, Docker Compose V2, Python 3, curl, and a checkout containing `package-lock.json`. Docker must be usable by the current operator. The optional services use Linux host networking. These commands assume the checkout is `/data/workspace/hydradb/incident-context` and persistent data is `/data/workspace/hydradb/data`; change both deliberately for another host.

```sh
cd /data/workspace/hydradb/incident-context
docker version
docker compose version
docker info >/dev/null
python3 --version
curl --version
test -f package-lock.json
docker run --rm node:22-slim node --version
```

The Node image supplies Node 22 and npm; no host Node installation is needed for the container workflow. Keep dev dependencies: `tsx` runs the TypeScript backend at runtime. `npm ci --omit=dev` cannot start it. The engine has a 3 GiB container memory limit and two-CPU cap, and the backend a 512 MiB limit; leave additional host memory for Docker and the tunnel. These limits are configuration, not a measured capacity claim. Do not run this stack alongside another service already listening on 8443, 9090 or 8788.

| Boundary | Configuration |
| --- | --- |
| HydraDB query / admin | Loopback `127.0.0.1:8443` / `127.0.0.1:9090`; bearer token on queries |
| Backend | Loopback `127.0.0.1:8788`; every route requires a separate backend bearer token |
| Persistent graph | Host `HYDRA_DATA_DIR`, container `/data`; store, cache and engine token |
| Persistent app state | Host `API_DATA_DIR`, container `/state`; backend `DATA_DIR=/state` |
| Published evaluation | Backend `EVALUATION_FILE=/app/evaluation/results.json` |
| Worker | `BACKEND_ORIGIN` variable, `BACKEND_TOKEN` secret, `AI` Workers AI binding |

The backend reads `DATA_DIR` for its state directory. `API_DATA_DIR` supplies that directory's host path to Compose. `HYDRA_URL`, `HYDRA_NAMESPACE` and `HYDRA_CELL_ID` default to `http://127.0.0.1:8443`, `default` and `cell-0`. Inline `HYDRA_TOKEN` / `BACKEND_TOKEN` override their respective `_FILE` settings; prefer files and keep those inline variables unset.

## Prepare storage, secrets and dependencies

Run the following as the account that will own persistent files, in the same shell as subsequent steps. The commands preserve existing tokens and state. Do not put credentials, host login details, runtime files or dependencies in git.

```sh
export APP_SOURCE_DIR="$PWD"
export RUNTIME_DIR=/data/workspace/hydradb/data
export HYDRA_DATA_DIR="$RUNTIME_DIR/engine"
export API_DATA_DIR="$RUNTIME_DIR/api"
export BACKEND_TOKEN_FILE="$RUNTIME_DIR/backend-token"
export HYDRA_UID="$(id -u)"
export HYDRA_GID="$(id -g)"

umask 077
install -d -m 700 "$RUNTIME_DIR" "$HYDRA_DATA_DIR" "$API_DATA_DIR"
install -d -m 700 "$HYDRA_DATA_DIR/store" "$HYDRA_DATA_DIR/cache"
test -O "$HYDRA_DATA_DIR" && test -w "$HYDRA_DATA_DIR"
test -O "$API_DATA_DIR" && test -w "$API_DATA_DIR"
python3 - <<'PY'
import os
import secrets
from pathlib import Path
for path in (Path(os.environ['HYDRA_DATA_DIR']) / 'auth-token', Path(os.environ['BACKEND_TOKEN_FILE'])):
    try:
        with path.open('x', encoding='utf-8') as out:
            out.write(secrets.token_hex(32) + '\n')
    except FileExistsError:
        pass
    path.chmod(0o600)
    if not path.read_text(encoding='utf-8').strip():
        raise SystemExit(f'Empty token file: {path}')
keys = ('HYDRA_UID', 'HYDRA_GID', 'HYDRA_DATA_DIR', 'API_DATA_DIR', 'BACKEND_TOKEN_FILE', 'APP_SOURCE_DIR')
Path('ops/.env').write_text(''.join(f'{key}={os.environ[key]}\n' for key in keys), encoding='utf-8')
Path('ops/.env').chmod(0o600)
PY

docker run --rm --user "$HYDRA_UID:$HYDRA_GID" \
  --env npm_config_cache=/tmp/npm-cache \
  --mount "type=bind,source=$APP_SOURCE_DIR,target=/app" --workdir /app \
  node:22-slim npm ci
```

Install Linux dependencies on the Linux host; do not bind Windows `node_modules` into the Linux backend. Existing storage owned by a different UID needs an intentional ownership repair by its administrator. Do not solve a permission error by making token or state files world writable.

`ops/compose.yaml` runs only the engine. [compose.app.yaml](../ops/compose.app.yaml) adds the optional backend and tunnel. It mounts source/dependencies read-only and state separately. Define a helper that always uses the same files and project name:

```sh
dc() {
  docker compose --project-name incident-context --env-file ops/.env \
    -f ops/compose.yaml -f ops/compose.app.yaml "$@"
}
dc config --quiet
dc up -d hydradb
curl --fail --retry 30 --retry-connrefused --retry-delay 1 \
  http://127.0.0.1:9090/readyz
dc up -d backend
dc logs --tail 40 backend
python3 ops/backend-request.py /api/health --token-file "$BACKEND_TOKEN_FILE"
python3 ops/backend-request.py '/api/bootstrap?sessionId=operator-smoke' \
  --token-file "$BACKEND_TOKEN_FILE"
python3 ops/backend-request.py /api/plan --token-file "$BACKEND_TOKEN_FILE" \
  --json '{"task":"checkout deployment regression rollback","sessionId":"operator-smoke","mode":"graph"}'
```

The backend seeds the actual engine before listening. Bootstrap should show 12 tools, four services and three skills; a plan includes real Cypher receipts and a schema-byte count. Health alone checks engine reachability, not a complete query/model workflow. Startup also attempts to resolve the real Cloudflare Workers component from its public directory. If that lookup fails, provider plans abstain; inspect network access and restart the backend when the directory is reachable. The deployment fixture remains usable. Engine startup is not synchronized by Compose readiness; wait for `/readyz` before starting the backend. If started too early, its restart policy retries startup.

Without the optional Compose file, start the backend from the checkout with Node 22 and `npm ci` already completed:

```sh
HYDRA_URL=http://127.0.0.1:8443 \
HYDRA_TOKEN_FILE="$HYDRA_DATA_DIR/auth-token" \
BACKEND_TOKEN_FILE="$BACKEND_TOKEN_FILE" DATA_DIR="$API_DATA_DIR" \
EVALUATION_FILE="$APP_SOURCE_DIR/evaluation/results.json" \
HOST=127.0.0.1 PORT=8788 npm run server
```

## Expose the backend and deploy the Worker

```sh
dc up -d tunnel
dc logs --tail 60 tunnel
```

Find the `https://…trycloudflare.com` URL in the tunnel logs. It exposes the authenticated backend through HTTPS; unauthenticated backend requests should return 401. Keep both engine ports and the backend port bound to loopback. The Worker forwards only its explicit public API allowlist; internal execution, model-reservation and protection routes require the backend credential and are not public Worker routes.

On a deployment workstation with Node 22/npm, the checkout and access to the matching backend-token file, run `npm ci`, then authenticate Wrangler to your existing Cloudflare account. Keep credentials out of source and shell history. `wrangler login` uses an interactive browser; an existing deployment token may instead be supplied through the standard `CLOUDFLARE_API_TOKEN` environment variable. Do not enable paid services for this demo.

```sh
node --version
npm ci
npx wrangler login
npx wrangler whoami
export BACKEND_TOKEN_FILE=/absolute/private/path/backend-token
npx wrangler secret put BACKEND_TOKEN < "$BACKEND_TOKEN_FILE"
export HYDRA_BACKEND_ORIGIN=https://YOUR-CURRENT-TUNNEL.trycloudflare.com
npm run build
npx wrangler deploy --var "BACKEND_ORIGIN:$HYDRA_BACKEND_ORIGIN"
```

`HYDRA_BACKEND_ORIGIN` here is a shell variable; the binding consumed by `src/worker/index.ts` is `BACKEND_ORIGIN`. Supply the current origin on **every** deployment so an old value in a local config cannot replace it. `wrangler.jsonc` binds `AI` to Workers AI and publishes `dist/client` with SPA routing. The chosen model is `@cf/meta/llama-3.1-8b-instruct-fp8-fast`. No model credential belongs on the Linux backend. Cloudflare authentication and Workers AI availability are account prerequisites, not verified by building the UI.

Use the Worker URL returned by Wrangler:

```sh
export PUBLIC_URL=https://YOUR-WORKER.workers.dev
curl --fail "$PUBLIC_URL/api/health"
curl --fail "$PUBLIC_URL/api/bootstrap?sessionId=operator-smoke"
curl --fail -X POST "$PUBLIC_URL/api/plan" -H 'Content-Type: application/json' \
  --data '{"task":"checkout deployment regression rollback","sessionId":"operator-smoke","mode":"graph"}'
```

These checks use no model calls. A deliberate `/api/run` request exercises the model and consumes a persisted attempt; preserve evaluation headroom before doing that. Public sessions share the daily application quota. A successful static page does not prove its origin, graph or model is available.

## Local UI and Worker

Use Node 22/npm on the workstation. Build the UI and run Wrangler from the repository root. Vite's `npm run dev` serves UI assets only; it does not proxy `/api` to the backend.

Create ignored `.dev.vars` with mode 0600, using a backend token the local Worker can reach. This example reads the token file without printing it:

```sh
export BACKEND_TOKEN_FILE=/absolute/private/path/backend-token
export HYDRA_BACKEND_ORIGIN=http://127.0.0.1:8788
umask 077
python3 - <<'PY'
import json
import os
from pathlib import Path
token = Path(os.environ['BACKEND_TOKEN_FILE']).read_text(encoding='utf-8').strip()
if not token:
    raise SystemExit('Backend token file is empty')
Path('.dev.vars').write_text(
    f'BACKEND_ORIGIN={json.dumps(os.environ["HYDRA_BACKEND_ORIGIN"])}\n'
    f'BACKEND_TOKEN={json.dumps(token)}\n', encoding='utf-8')
Path('.dev.vars').chmod(0o600)
PY
npm run build
npx wrangler dev
```

For a remote backend use its current tunnel HTTPS origin instead of loopback. Loopback means the workstation running Wrangler. Local Workers AI requests use Cloudflare's remote model binding/account and can consume quota; the local UI is not an offline model substitute. The backend's model counter is shared if local and deployed Workers target the same state directory.

## Validation and benchmark reproduction

The following helper runs repository commands on the Linux host through Node 22, using the Linux dependencies installed above. It mounts runtime files at their existing absolute paths so token-file settings work. Run it from the configured checkout and shell; it intentionally allows evaluation commands to write new output files. A host Node 22/npm installation can run the same commands without the `appnode` prefix.

```sh
appnode() {
  docker run --rm --network host --user "$HYDRA_UID:$HYDRA_GID" \
    --env npm_config_cache=/tmp/npm-cache \
    --env HYDRA_URL --env HYDRA_TOKEN_FILE --env BACKEND_URL --env BACKEND_TOKEN_FILE \
    --env PUBLIC_URL --env OUTFILE --env DETAIL_OUTFILE \
    --env BENCHMARK_DETAIL_FILE --env REPORT_FILE --env LIVE_INTERVAL_MS \
    --mount "type=bind,source=$APP_SOURCE_DIR,target=/app" \
    --mount "type=bind,source=$RUNTIME_DIR,target=$RUNTIME_DIR" \
    --workdir /app node:22-slim "$@"
}
```

Run the normal checks. `cf:types` generates ignored `worker-env.d.ts`:

```sh
appnode npm run cf:types
appnode npm run typecheck
appnode npm run typecheck:worker
appnode npm test
appnode npm run build
```

Without `HYDRA_URL`, the real-engine integration test is skipped. Its authenticated engine run temporarily removes/restores alias and prerequisite edges and writes session learning. Use a separate test engine/data directory or a maintenance window with public traffic and evaluations stopped; it is not a read-only health probe.

```sh
HYDRA_URL=http://127.0.0.1:8443 HYDRA_TOKEN_FILE="$HYDRA_DATA_DIR/auth-token" \
  appnode npx tsx --test src/server/graph.integration.test.ts
```

The locked [evaluation protocol](evaluation.md) explains the 40 training tasks, 20 held-out tasks and fixed workflow policy. Reproduce the full deterministic run to **new** files; it makes no model calls but does execute real backend tools, including live provider-status reads. Do not alter locked dataset files, train on held-out outcomes, replace failed cases or silently overwrite published evidence. Keep other graph writes out of measured passes because they invalidate graph-version freezes.

```sh
export RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export REPORT_FILE="output/evaluation/$RUN_ID/results.json"
export DETAIL_FILE="output/evaluation/$RUN_ID/resultsdetail.json"
BACKEND_URL=http://127.0.0.1:8788 BACKEND_TOKEN_FILE="$BACKEND_TOKEN_FILE" \
OUTFILE="$REPORT_FILE" DETAIL_OUTFILE="$DETAIL_FILE" appnode npm run evaluate
```

The runner creates a fresh session and refuses existing output files. Keep partial evidence when a run fails. The served report remains `/app/evaluation/results.json`; reproductions under ignored `output/` do not automatically replace it.

For a new paired live experiment, use that completed deterministic detail/report and a new live output. Reserve at least 30 of the 60 daily attempts before starting; the preflight enforces this and the protocol makes up to 30 actual Worker/model requests. Do not issue exploratory model requests or public traffic concurrently. `evaluate:live` updates the new report in place after a complete comparison, so use the reproduction report rather than an existing published report.

```sh
PUBLIC_URL="$PUBLIC_URL" BACKEND_URL=http://127.0.0.1:8788 \
BACKEND_TOKEN_FILE="$BACKEND_TOKEN_FILE" BENCHMARK_DETAIL_FILE="$DETAIL_FILE" \
REPORT_FILE="$REPORT_FILE" OUTFILE="output/evaluation/$RUN_ID/live-results.json" \
LIVE_INTERVAL_MS=1000 appnode npm run evaluate:live
```

After all training and any live comparison, protect the trained session **before** publishing raw receipts. The protection persists in `state.json` and rejects later feedback with 403. It must not be enabled before training, which needs feedback. Read the session ID from the detail you just produced:

```sh
export DETAIL_FILE
python3 - <<'PY' > "$RUNTIME_DIR/protect-session.json"
import json
import os
from pathlib import Path
detail = json.loads(Path(os.environ['DETAIL_FILE']).read_text(encoding='utf-8'))
if detail['status'] != 'complete':
    raise SystemExit('Refusing to publish an incomplete benchmark')
print(json.dumps({'sessionId': detail['sessionId']}))
PY
python3 ops/backend-request.py /internal/protect-session \
  --token-file "$BACKEND_TOKEN_FILE" --json-file "$RUNTIME_DIR/protect-session.json"
```

Protection locks that session, not the global graph. Other sessions can still write memories and feedback. Preserve all successes, failures and usage nulls. A reproduction is a separate experiment, not permission to select a more favorable reported result.

## Quotas and failure behavior

The application reserves a maximum of 60 model attempts per UTC day in persistent `state.json` before inference. Reservation remains charged if inference or execution fails. Exhaustion returns 429; wait for the next UTC day instead of deleting state or raising limits. The prompt limit is 16 KiB, completion limit 256 tokens, schema budget 4096 UTF-8 bytes and execution cap four calls. Workers AI/account limits are additional constraints; the app counter is not a billing estimate or a spending guarantee.

Hydra queries time out after five seconds; engine health after three seconds; individual tool execution after five seconds, with provider HTTP reads capped at four seconds. The Worker caps each backend fetch at 20 seconds, and the backend request timeout is 30 seconds. There is no explicit model-call timeout in this version. These are bounded operations within a serial workflow, not an end-to-end availability or latency guarantee. The graph has no in-memory fallback. Network failure is shown as an error or failed observation.

## Restart, backup and recovery

Keep both the engine directory and app state directory. HydraDB contains session memories, Beta weights, applied feedback IDs and graph versions. App `state.json` contains plans/runs, ownership, duplicate-feedback acknowledgements, protected session IDs and daily model reservations, as well as a weight mirror. Deleting only one side does not create a clean, consistent reset. Run a single backend writer against one state directory; the file queue is process-local.

| Failure | Check and recovery |
| --- | --- |
| Engine unavailable | `dc ps`, `dc logs --tail 60 hydradb`, disk space and data ownership; `dc restart hydradb`, then wait for `/readyz`. Keep the same bind path and engine token. Verify authenticated bootstrap/plan afterward. |
| Backend stopped or starts repeatedly | `dc logs --tail 60 backend`; verify engine readiness, token-file mounts, Linux `node_modules`, write access to `/state` and free space. `dc restart backend` reruns idempotent catalog seeding and reads existing state. |
| Tunnel disconnected | `dc logs --tail 60 tunnel`, then `dc restart tunnel`. Read the latest hostname from fresh logs. Quick Tunnel hostnames can change on restart/recreation. |
| Worker points at an old tunnel | Set `HYDRA_BACKEND_ORIGIN` to the new HTTPS hostname and redeploy with `npx wrangler deploy --var "BACKEND_ORIGIN:$HYDRA_BACKEND_ORIGIN"`. The Worker URL remains stable; its origin setting does not update itself. |
| Backend authentication fails | Verify the local token file matches the mounted backend token; set the Worker secret again from that file and restart/recreate the backend if its token changed. Do not print tokens while debugging. |
| Provider plans abstain | Check outbound access to Cloudflare's fixed component directory, restart backend to resolve the Workers component, then verify a provider plan. Do not invent a component identity. |
| Model unavailable or quota reached | Check the returned error, persisted budget in bootstrap and Cloudflare account/model availability. Retain failed attempt evidence. Do not clear the quota to retry. |
| State parse error or lost data | Stop writes. Preserve the damaged files for diagnosis. Restore a matching engine/app backup; fail visibly rather than start with an empty directory. |

Restart services without deleting their bind-mounted data:

```sh
dc restart hydradb
curl --fail --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:9090/readyz
dc restart backend
python3 ops/backend-request.py /api/health --token-file "$BACKEND_TOKEN_FILE"
```

Before a planned restart, save authenticated bootstrap responses for the protected benchmark session and an ordinary trained session. Afterward compare their complete weights and graph version, check the UTC budget's day/calls, and verify protected-session feedback is still rejected with 403. Use existing run IDs from that session when testing rejection; never submit new feedback merely to test persistence. Bootstrap for existing sessions and health do not reserve model calls. Do not compare counters across a UTC-day boundary as if they were the same day's budget.

For a consistent backup, pause public traffic and stop all graph/state writers, then stop the stack. Store the complete runtime directory, token files and relevant evaluation artifacts together in a private location. This copies credentials; never upload the archive to the public repository.

```sh
export BACKUP_DIR=/absolute/private/backup-directory
export BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$BACKUP_DIR"
dc stop tunnel backend hydradb
umask 077
tar -C "$RUNTIME_DIR" -czf "$BACKUP_DIR/runtime-$BACKUP_ID.tgz" .
tar -C "$APP_SOURCE_DIR" -czf "$BACKUP_DIR/evaluation-$BACKUP_ID.tgz" evaluation
git rev-parse HEAD > "$BACKUP_DIR/source-$BACKUP_ID.txt"
dc up -d hydradb
curl --fail --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:9090/readyz
dc up -d backend tunnel
```

After restore or migration, verify UID/GID, restrictive token permissions, both persistent bind paths and the Worker token. Restarting the tunnel can require the origin redeployment above. Restore into an intentionally selected empty destination with the stack stopped; do not merge a backup over a live graph. `dc down` removes containers but these bind mounts survive; `docker system prune`, deleting data or regenerating tokens is not a recovery step.

The optional Compose stack and this runbook describe the repository's configuration. Source checks, local regression tests, real-engine integration, public browser behavior, concurrency, origin loss and persistence recovery are different evidence. Report only the checks actually performed in your environment; successful YAML parsing or a UI build is not a deployment or recovery test.
