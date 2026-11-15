# Results and interpretation

All measurements below come from the committed raw artifacts. The original study, its flat learning curve, failed model requests, and the later supplement are retained separately. This prototype's strongest evidence is reduced tool context while preserving completion on a small, fixed workload.

## Original locked study

The [original corpus](../evaluation/dataset.json) was committed at `0a4aaac` before feedback. SHA-256: `3c16994b42a6d3387b04cc6eb62eac0223a6722315d1d869cfdabee9b3c21076`. Four simulated service fixtures underlie 40 training and 20 held-out request narratives, balanced across deployment and provider investigations. Training uses two services and held-out requests use the other two. These are repeated fixture investigations, not 60 independent incidents.

The [protocol](evaluation.md) executes one fixed workflow against the real backend and HydraDB: four 20-request graph checkpoints, 40 training requests, and three 20-request final baselines, totaling **180 attempts**. The workflow receives only the selected schemas and graph-resolved IDs. Missing tools and errors remain failures; expected IDs never repair a plan. No model is called in this study. The primary metric here is actual executor completion; independently graded observations are retained separately.

| Selector | Executor success | Complete prerequisites | Mean schema bytes | Irrelevant schemas, total | Planning p50 / p95, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full catalog | 20/20 | 20/20 | 6,560 | 170 | 105.40 / 120.96 |
| Keyword baseline | 19/20 | 19/20 | 3,882 | 76 | 121.45 / 137.58 |
| Frozen graph | 20/20 | 20/20 | 1,976 | 0 | 126.89 / 144.60 |
| Learned graph | 20/20 | 20/20 | 1,976 | 0 | 118.88 / 153.62 |

Both graph arms use **69.9% fewer mean schema bytes** than the full catalog. The learned curve is **20/20 at 0, 10, 20 and 40 training outcomes**. The initial prior already selects useful bundles for this explicit request corpus; no learning gain was measured. Latencies are nearest-rank loopback HTTP planning round trips, excluding execution and inference. Their differences do not establish a speed improvement.

Seven measured passes retain unchanged before/after graph versions and all six family/skill weight vectors. Held-out requests receive no feedback. Raw [summary](../evaluation/results.json) and [all cases, feedback, and freeze audits](../evaluation/resultsdetail.json) include failed cases and actual query receipts.

## Paired live model study

Ten preselected held-out tasks were each requested once through the deployed Worker in full, frozen and learned modes: **30 requests, no retries**. Arm order rotates by task. All use the same task, service context, backend, requested model `@cf/meta/llama-3.1-8b-instruct-fp8-fast`, temperature zero, 256-token completion cap and four-call cap. The reported returned model is `@cf/meta/llama-3.1-8b-fast-v2`. The model chooses calls; the backend validates them and produces the observed diagnosis from the resulting evidence.

| Selector | Executor / independently graded observation success | Returned runs with usage | Mean input tokens | Known neuron total |
| --- | ---: | ---: | ---: | ---: |
| Full catalog | 7/10 | 10 | 2,320.90 | 121.947789 |
| Frozen graph | 9/10 | 9 | 900.67 | 57.618205 |
| Learned graph | 10/10 | 10 | 912.40 | 65.681230 |

Learned graph uses **60.7% lower mean reported input tokens** than the full catalog. This is an input-token comparison, not a measured billing saving. The frozen arm's tenth request returned HTTP 502 because the model returned too many calls. Missing usage remains unknown; its nine-run total is not directly comparable to ten-run totals as complete cost.

All nine comparable frozen/learned pairs have **identical actual model input fields**: task, canonical service context, resolved entities and exact tool array. The 9/10 versus 10/10 outcome difference therefore cannot be attributed to learning. A single serial comparison at temperature zero can still vary; it is descriptive, not evidence of a statistically reliable accuracy gain. Three full-catalog runs lacked required observations. No calls or arguments were repaired to turn those failures into successes.

The persistent model reservation counter rose from 2 to 32: two earlier operator/preflight attempts plus these 30 requests. [Live evidence](../evaluation/live-results.json) retains run IDs, calls, observations, usage nulls, error status, arm order and the frozen-weight audit. No live held-out feedback was submitted.

## Separately registered goal-oriented supplement

After the original curve proved flat, a separate AI sub-agent authored more goal-oriented wording **without access to the planner, skills, tool catalog, original request corpus or previous results**. It was given the four service names/aliases and the two investigation goals. This is blind AI authorship, not external human validation. The [40-request corpus](../evaluation/ambiguity-dataset.json) and [protocol](ambiguity-protocol.md) were committed at `68a05a8` before any supplementary requests. SHA-256: `7f29df93c38efdf15d47fea66dbc958e5dfd5f26a5cc2257096f3b1f519da2f7`. The original results were preserved.

One execution used source `0f146e1`, a fresh session and the unchanged planner, skills, priors and fixed workflow. Twenty ordered training attempts produced **16 real feedback updates**; four requests had no trainable run/selected skill. Its metric is independently graded goal observations **plus correct service/resource resolution**, rather than the executor's inferred-family grading. Twenty held-out narratives receive no feedback. Four checkpoints, 20 training attempts, and three final baselines total **160 attempts**. There are no model calls in this supplement.

| Training attempts | Actual feedback updates | Held-out goal success | Mean schema bytes |
| ---: | ---: | ---: | ---: |
| 0 | 0 | 14/20 | 2,067 |
| 5 | 4 | 15/20 | 1,996 |
| 10 | 7 | 15/20 | 1,996 |
| 20 | 16 | 15/20 | 1,996 |

| Final selector | Goal success | Complete prerequisites | Mean schema bytes | Irrelevant schemas, total |
| --- | ---: | ---: | ---: | ---: |
| Full catalog | 15/20 | 15/20 | 6,560 | 127 |
| Keyword baseline | 11/20 | 10/20 | 3,925 | 64 |
| Frozen graph | 14/20 | 14/20 | 2,067 | 5 |
| Learned graph | 15/20 | 15/20 | 1,996 | 0 |

This measures **one additional held-out success**, then an early plateau. The changed case is `amb-heldout-p07`: “Before we settle on an explanation for billing, check whether upstream Cloudflare Workers has acknowledged any service trouble.” The frozen selector chose telemetry; after feedback, the selector chose the provider-investigation bundle and returned the expected live provider evidence. This explains the observed gain at the selection boundary; it is not an LLM learning result.

Five failures remain in every learned held-out pass: `amb-heldout-p03`, `amb-heldout-d05`, `amb-heldout-d06`, `amb-heldout-p06`, and `amb-heldout-p09`. Their requests use concatenated `HarborLedger` or `JuniperSearch` names that the strict alias resolver does not recognize. Each HTTP 422 stays in the 20-request success denominator; missing schema measurements remain null and are excluded only from byte means. No alias or corpus was changed after execution to remove these failures.

All seven measured passes preserve graph versions and weight vectors. The [supplement summary](../evaluation/ambiguity-results.json) and [all cases, segments, training outcomes and freeze audits](../evaluation/ambiguity-resultsdetail.json) remain separate from the initial artifacts. Both trained sessions reject further feedback with HTTP 403, including after restart.

## Graph contribution and limits

HydraDB stores alias-to-service and service-to-resource identity, skill-to-tool selection, recursive tool prerequisites, tool server metadata, session memories and Beta feedback counts. The planner reads directed, bounded traversals and returns actual Cypher/row/edge receipts. Removing a required `REQUIRES` edge causes abstention; removing a `RESOLVES_TO` edge prevents resolution. Both edges are restored in the [real-engine integration check](../src/server/graph.integration.test.ts).

Those ablations establish that the application depends on these graph relationships. They do not prove a graph database is uniquely capable: a plain store with equivalent explicit identity, closure and session logic could implement the same behavior. No alternative storage engine was benchmarked.

The two studies reuse four simulated service fixtures and only two incident families. Live provider data is a read-only snapshot of Cloudflare's public status, may change between arms, and establishes no causal connection to the sandbox outage. The catalog is small (12 schemas); generalization to new incidents, large catalogs, arbitrary MCP servers, production resolution time and customer demand remains unmeasured. [Reliability](reliability.md) reports the separate runtime checks. [Artifact hashes](../evaluation/artifacts.sha256) make the published measurements identifiable.
