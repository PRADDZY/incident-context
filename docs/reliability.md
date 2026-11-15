# Runtime verification

These checks use the actual pinned HydraDB 0.4.0 engine and TypeScript backend on the existing Linux execution host. They are a small deployment check, not a production capacity or availability guarantee. [Raw runtime evidence](../evaluation/load-results.json) and [probe source](../evaluation/reliability.py) are included. No model calls were made by the load/recovery probe.

## Five concurrent sessions

Twenty loopback HTTP planning requests ran through a five-worker pool after warming four service identities in each of five sessions. All used learned graph selection, a 4,096-byte schema budget and the 12-tool catalog.

| Measurement | Observed |
| --- | ---: |
| Requests / maximum concurrency | 20 / 5 |
| HTTP or incomplete-bundle failures | 0 |
| HTTP planning round-trip p50 | 579.36 ms |
| HTTP planning round-trip p95 | 687.83 ms |
| Batch wall time | 2,543.64 ms |

Weights, graph version and model reservations were unchanged during the measured burst. These are nearest-rank quantiles from 20 requests; they include the backend's serialized persistence work and graph queries. This does not measure public Internet latency, model inference, cold identity writes, sustained throughput, a large graph or a larger tool catalog. Run only one backend process against a state directory: the file-mutation queue is process-local.

## Failure and persistence checks

| Check | Observed result |
| --- | --- |
| Backend request without its bearer token | HTTP 401 |
| Invalid empty-task plan | HTTP 400 |
| Unknown backend API route | HTTP 404 |
| Engine stopped: authenticated health | HTTP 503 |
| Engine stopped: planning | HTTP 503; no fabricated graph fallback |
| Engine started with the same persistent data | Ready after 507.27 ms of polling after `docker start` returned |
| Backend restarted with the same graph and state | Ready after 2,508.98 ms of polling after `docker restart` returned |
| Session learning, graph version and UTC-day model budget | Preserved across both restarts |
| Feedback for both published benchmark sessions | HTTP 403 before and after restarts; weights unchanged |
| Repeated feedback for an ordinary executed run | HTTP 409 before and after restart |

The probe creates one real fixed-policy sandbox execution and applies its actual successful outcome to an ordinary test session. It never trains a published benchmark session. The model counter remained 32/60 on the same UTC day. Recovery timings exclude Docker command duration and are not total downtime estimates. A Quick Tunnel was kept running during this test; a restarted/recreated tunnel can change its hostname and requires a Worker origin update.

## Recovery defect found and fixed

The first recovery attempt failed: after restarting HydraDB, backend catalog seeding received HTTP 409 `mutation_conflict` and the backend restarted repeatedly. The engine's default `http-query-N` sequence resets with its process, while mutation receipts persist and use the query ID as their default identity. Reuse for a different query was rejected.

The [Hydra adapter](../src/server/hydra.ts) now supplies a fresh explicit UUID `query_id` for every request. There are no automatic query retries in this adapter. The [regression](../src/server/hydra.test.ts) failed with the former adapter and passes with explicit identities; the entire live engine/backend restart check above then passed. No engine data, feedback, quota or benchmark artifact was deleted to recover. The accuracy studies predate this transport fix and were not rerun or replaced.

## Other checks and scope

The real-engine integration check verifies idempotent catalog seeding, actual directed traversal receipts, schema-budget abstention, persistent session feedback, duplicate feedback and alias/prerequisite edge ablation. Unit checks cover typed null decoding, malformed engine responses, bounded tool arguments, ownership, protected sessions, quota reservation, provider timeouts and malformed model calls. A local unit run without `HYDRA_URL` skips the real-engine check; report that skip separately.

The Worker validates its explicit route allowlist, prompt and body limits, call normalization, quota reservation, origin failures and usage nulls. Backend fetches time out after 20 seconds, Hydra queries after five seconds, and provider HTTP reads after four seconds. There is no explicit model-inference timeout; the whole workflow is not covered by a single latency bound.

Desktop, tablet and mobile browser checks exercise actual graph planning, strategy changes, node/schema inspection, catalog filtering, evaluation and feedback controls. Final live browser verification and build/CI status are recorded in the repository's completion commit; screenshots are evidence of the displayed state, not a substitute for the raw measurements. Only a walkthrough script is prepared. No video was recorded.

## Reproduce

Use the [operations guide](operations.md) for tokens, persistent paths and the actual API. From the configured backend host, with public traffic paused, use a **new output path**:

```sh
BACKEND_TOKEN_FILE=/absolute/private/backend-token \
OUTFILE=output/runtime-check.json python3 evaluation/reliability.py
```

The optional `--restarts` deliberately stops/starts the engine and restarts the backend containers, interrupting the demo. It requires Linux Docker access; defaults are `incident-context-hydra` and `incident-context-api`, overridable through `ENGINE_CONTAINER` and `API_CONTAINER`. The committed raw benchmark detail files identify protected sessions to verify. Run this only in a maintenance window, with the proper containers explicitly selected and the same persistent mounts. The script refuses to overwrite an existing result. The portable Compose examples are statically checked; this deployment was started using equivalent Docker commands, not a tested Compose rollout.
