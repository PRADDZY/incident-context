# Evaluation protocol

The deterministic benchmark measures context selection and completion of a **FIXED workflow policy** through the real executor. It does not measure LLM task accuracy. The separate paired live comparison measures actual Worker/model requests. Schema coverage, executor completion, independent observation grading, and model-path success are reported separately.

## Locked tasks and independent expectations

`evaluation/dataset.json` was authored before benchmark feedback. Its SHA-256 is `3c16994b42a6d3387b04cc6eb62eac0223a6722315d1d869cfdabee9b3c21076`, exported as `DATASET_SHA256` and recorded in `evaluation/dataset.sha256`. The CLI checks both before making requests. Git normalizes JSON to LF, preserving the locked bytes across platforms.

There are 40 ordered training tasks, balanced between deployment and provider investigations, and 20 held-out tasks, also balanced. Northstar Checkout (`checkout`, `payments`, `northstar`) and Cedar Dispatch (`dispatch`, `routing`, `cedar`) appear only in training. Juniper Search (`search`, `discovery`, `juniper`) and Harbor Ledger (`ledger`, `billing`, `harbor`) appear only in held-out tasks. Names, IDs and aliases are disjoint. Family semantics overlap and wording varies. No held-out result is submitted as feedback.

These are 60 task narratives over **four service fixtures**, not 60 distinct production incidents. The sandbox has one deployment incident per service. This supports a narrow check of service, alias and wording transfer within two known families. It cannot establish broad incident generalization, customer value or statistical significance.

Gold expectations are declared in the dataset and read only by independent grading. They are not generated from graph edges, selected skills, `tool.requires`, planner scores, or observed runs. The evaluation imports public wire types, never the server catalog, graph repository or skill definitions.

| Investigation | Independently required complete bundle | Required actual observations |
| --- | --- | --- |
| Deployment | `service_resolve`, `service_metrics`, `deployments_list`, `deployment_details` | Sandbox metrics for the expected service/resource show an error rate above baseline; the expected current deployment changed retry budget from 3 to 0 at the regression time, with the expected previous deployment as rollback candidate. |
| Provider | `provider_components`, `component_status`, `provider_incidents` | Timestamped live Cloudflare Workers component status from the fixed components endpoint, plus an unresolved-incident list from the fixed incidents endpoint. |

Provider gold deliberately specifies no availability value, outage, incident count, or error percentage. `operational`, a degraded state, and an empty incident list can all be valid observations. The sources must be `live`, include the expected fixed source URLs, and have observation timestamps. Provider reports do not establish application health or root cause. Component IDs are resolved from the real directory into graph metadata, never hardcoded in expected outcomes.

The fixed execution policy attempts deployment metrics, deployment list, and deployment details, in that order; the provider workflow attempts component directory, component status, and unresolved incidents. It uses only schemas selected by the arm and graph-resolved service/resource/deployment/component identifiers. Missing schemas or identifiers are never repaired from gold data, invented, or replaced with an extra tool context. It does not call a missing tool, and it does not choose calls from the selected skill. All arms use the identical policy and at most three calls. Prerequisite schema coverage remains separate from whether those three diagnostic observations succeed.

## Deterministic execution

Run on the existing Linux execution host after the backend and real HydraDB are ready:

```sh
BACKEND_URL=http://127.0.0.1:8788 \
BACKEND_TOKEN_FILE=/data/workspace/hydradb/data/backend-token \
OUTFILE=evaluation/results.json \
DETAIL_OUTFILE=evaluation/resultsdetail.json \
npx tsx evaluation/run.ts
```

The token is read from its file and used only as a backend Authorization header. It is never printed or included in result artifacts. Output files must be new: the CLI refuses to overwrite an existing artifact. Use separate named files for a new full experiment; preserve prior runs and explain why another run was necessary. Do not rerun individual failed cases.

Each experiment creates a fresh UUID session with untouched 1/1 priors. Four planning-only warmups resolve the four service memories before measurements; they execute no tools and submit no feedback. They prevent `REMEMBERS_SERVICE` writes from changing the global version inside a measured pass.

The sequence is fixed:

1. Evaluate all 20 held-out tasks in learned graph mode at checkpoint 0.
2. Train the next ordered tasks through `/api/plan` and `/internal/execute`, then submit `/api/feedback` using exactly `run.success === true`.
3. Evaluate the same 20 held-out tasks after 10, 20 and 40 training outcomes. Weights remain constant throughout each checkpoint evaluation.
4. Evaluate all catalog, lexical budget and frozen graph over the same 20 held-out tasks. The final graph arm reuses checkpoint 40 rather than rerunning it.

This makes 180 executor attempts: 40 training, 80 checkpoint cases, and 60 additional baseline cases. No Workers AI calls are made. The standard planner selects training skills; there is no forced exploration, altered prior, fabricated success/failure, or guaranteed improvement. A flat or worsening learning curve is a valid result.

Each measured pass records bootstrap graph versions and complete session weight vectors before and after, as well as every plan receipt version. A version or weight change invalidates the pass and prevents publication of a complete report. Training feedback receipts retain the actual graph writes. Concurrent benchmark-session feedback must be avoided. Real engine failure remains visible; there is no in-memory fallback.

HTTP failures are not retried. Failed held-out executions count as failures, with the error and available plan preserved. A training request that produces no actual run aborts the experiment rather than inventing feedback. Partial detailed evidence is saved; the summary remains pending until all required passes and audits complete.

## Report interpretation

`evaluation/results.json` follows the public `EvaluationReport` contract. `evaluation/resultsdetail.json` retains every task, calls, plan, run, actual observations, failures, training feedback receipt and freeze audit.

| Field | Meaning |
| --- | --- |
| `successes` | Count of actual deterministic executor results with `run.success === true`. This is explicitly not LLM accuracy. |
| `completePrerequisites` | Count of selected bundles containing the independent required tool set. A passing coverage check alone never counts as success. |
| `irrelevantTools` | Total schemas selected outside the independent useful set across the arm. Thus full catalog's extra schemas are counted even though the policy executes only relevant tools. |
| `meanSchemaBytes` | Mean actual UTF-8 bytes of the exact model tool array `[{name,description,parameters}]`. Internal metadata such as source, server and requires is excluded. The independently measured value must equal the backend value. |
| `p50Ms`, `p95Ms` | Nearest-rank median and 95th percentile HTTP `/api/plan` round-trip times, including origin and graph work, excluding tool execution. |
| `observationSuccess` in detail | Independently expected observation facts and correct service/resource resolution, checked separately from server success. Any grader disagreement is retained. |
| `usage` | Null prompt/completion tokens and neurons for deterministic runs. No token savings or model accuracy is inferred from schema bytes. |

Failed plan requests have null byte and irrelevant-schema measurements in detail. Summary byte means use only plans actually received; task and failure counts still include every case. Irrelevant-schema totals include only received plans. Provider timing and state can change between serial passes, so execution differences may reflect network conditions as well as selection.

## Paired live model comparison

The ten cases were selected and locked before feedback: `heldout-d01`, `heldout-p01`, `heldout-d02`, `heldout-p02`, `heldout-d03`, `heldout-p03`, `heldout-d04`, `heldout-p04`, `heldout-d05`, `heldout-p05`. There are five deployment and five provider tasks. No case is replaced after outcomes are known.

Only run this after the public Worker/model preflight is complete. It makes up to 30 actual model requests and requires at least 30 slots available in the persisted daily application quota of 60. The two preflight calls, if used, are separate and remain charged to that quota.

```sh
PUBLIC_URL=https://YOUR-WORKER.workers.dev \
BACKEND_URL=http://127.0.0.1:8788 \
BACKEND_TOKEN_FILE=/data/workspace/hydradb/data/backend-token \
BENCHMARK_DETAIL_FILE=evaluation/resultsdetail.json \
REPORT_FILE=evaluation/results.json \
OUTFILE=evaluation/live-results.json \
LIVE_INTERVAL_MS=1000 \
npx tsx evaluation/live.ts
```

The completed deterministic detail identifies the trained session; its weights are checked before the live experiment. Each selected task is submitted once to `/api/run` for all catalog, frozen graph and learned graph. Arm order rotates deterministically by task index to spread serial timing effects. Requests remain serial, with a one-second default interval and no retries. The public client sends no backend credentials. The Worker uses its one fixed model endpoint, temperature 0, a 256-token completion limit and the same four-call cap for every arm. Exact requested and returned model identifiers, usage including missing values, calls, observations and HTTP failures are preserved.

No held-out feedback is sent. Version and weight freeze checks cover the complete live comparison. Requests that abstain before inference or fail after quota reservation remain failed cases; before/after persistent budget counters distinguish reserved inference attempts from HTTP request counts. A successful complete experiment appends the contract's `live` rows to `results.json`, while retaining all 30 paired cases in `live-results.json`. The CLI refuses an already populated live report or an existing live output file.

Live `successes` are the actual executor outcomes returned through the model path, and independent observation grades remain separate in case evidence. The final answer is the backend's observed diagnosis assembled from verified tools; the model is evaluated on choosing valid useful calls and arguments, not on unrestricted narrative generation. Publish all successes and failures, usage nulls, and the actual improvement or plateau. No significance claim is warranted from ten paired tasks.

## Validation and scope

```sh
npx tsx --test evaluation/*.test.ts
npx tsc --noEmit
```

Regression coverage includes missing prerequisites, incorrect service/resource and deployment facts, provider identity/source boundaries, UTF-8 measurements, train/held-out separation, honest flat curves, exactly 40 training feedback records, frozen versions/weights, preserved HTTP failures, fixed live membership and quota preflight. Protocol unit tests use explicitly labelled test doubles; they are not benchmark results or real HydraDB evidence. Runtime artifacts are produced only by the actual authenticated backend and public Worker commands above.

Topology ablation, concurrency, origin loss and restart recovery are separate checks managed by the application owner. This runner does not mutate production topology or manufacture those claims.
