The backend runs on the existing Linux execution host. It requires a reachable HydraDB 0.4.0 engine and a separate bearer token for the Worker-to-backend connection. It does not call a model or hold Cloudflare credentials.

```sh
HYDRA_URL=http://127.0.0.1:8443 \
HYDRA_TOKEN_FILE=/data/workspace/hydradb/data/engine/auth-token \
BACKEND_TOKEN_FILE=/data/workspace/hydradb/data/backend-token \
DATA_DIR=/data/workspace/hydradb/data/app \
EVALUATION_FILE=/data/workspace/hydradb/incident-context/evaluation/results.json \
HOST=127.0.0.1 PORT=8788 npm run server
```

`HYDRA_NAMESPACE` defaults to `default`; `HYDRA_CELL_ID` defaults to `cell-0`. `HYDRA_TOKEN` and `BACKEND_TOKEN` are alternatives to their respective token files. Runtime state and token files belong outside the source repository.

Every route requires `Authorization: Bearer <backend token>`. The public Worker owns `/api/run`. The backend implements bootstrap, plan, feedback, evaluation and health, plus `/internal/reserve-model` and `/internal/execute`. The execute body is `{planId, sessionId, calls, usage, requestedModel, returnedModel}`. Calls contain `{name, arguments}` and are capped at four. Invalid selected-tool arguments produce failed observations; the runner never repairs a model's calls.

Startup seeds graph entities and edges idempotently, then resolves the actual Cloudflare `Workers` component from the fixed public directory into service/resource metadata. Provider plans abstain when that identity is unavailable. Service metrics, logs, deployment history, runbooks, owners and dependency data are explicitly simulated fixtures. Provider tools read only fixed Cloudflare status URLs and describe provider reports without diagnosing this application's infrastructure.

`graph.ts` reads catalog metadata, aliases and supporting edges from HydraDB. `planner.ts` uses bounded resolution and prerequisite queries. `sessions.ts` stores hashed session nodes, remembered service edges, Beta counts, applied feedback IDs and graph versions in HydraDB. Frozen planning uses initial 1/1 counts. Session feedback writes the graph before the durable local acknowledgement; graph-applied run IDs make retries idempotent. `state.ts` serializes atomic JSON writes for plan/run ownership, duplicate rejection and the 60-attempt UTC daily counter.

Run `npx tsx --test src/server/*.test.ts` for local checks. Set `HYDRA_URL` and `HYDRA_TOKEN_FILE` to enable the real-engine test. That test verifies reseeding, bounded query receipts, bundle budgets, persisted session learning, alias/prerequisite edge ablations, authenticated HTTP execution, graph-backed feedback and duplicate rejection. Provider unit tests use an explicitly injected fixture; production handlers use the live public status endpoints.
