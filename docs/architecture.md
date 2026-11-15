# Incident Context

An incident-response agent context layer on self-hosted HydraDB. The public interface and inference run on Cloudflare Workers; a small authenticated Linux backend owns graph operations and bounded tool execution. Tool receipts distinguish simulated incidents from live provider status.

## Boundaries

- `src/shared/contracts.ts`: stable public wire types. Add optional fields if necessary; coordinate before incompatible changes.
- `src/server`: catalog, real HydraDB HTTP adapter, graph planner, tool runner, persistent session weights/model budget, HTTP API. No Cloudflare or model credentials on the host.
- `src/worker`: public API proxy and Workers AI call. Uses generated Env from Wrangler. BACKEND_ORIGIN is config; BACKEND_TOKEN is a Wrangler secret. Never expose a raw Cypher proxy.
- `src/ui`: React workbench, graph evidence, run result and measurement views.
- `evaluation`: independently authored locked task expectations and benchmark runner. Never feed held-out outcomes into training.

## API contract

GET /api/bootstrap?sessionId=... returns Bootstrap.
POST /api/plan accepts PlanRequest and returns Plan. Modes: all catalog, lexical budget, frozen graph, learned graph.
POST /api/run accepts PlanRequest, invokes the model with that plan's context/tools, then returns AgentRun. Four tool calls maximum. The answer may be rendered deterministically from verified tool observations; identify it as an observed diagnosis.
POST /api/feedback accepts Feedback and returns FeedbackResult. Update only the run owner's session, reject duplicate feedback, never mutate benchmark weights.
GET /api/evaluation returns EvaluationReport (explicit pending state until results exist).
GET /api/health reports origin and actual engine readiness.

The backend implements these same public routes except /api/run orchestration, plus authenticated POST /internal/reserve-model (reserve one daily model call), POST /internal/execute (plan ID, session, validated model calls, usage, requested/returned model -> AgentRun). All backend routes require the backend bearer token. The Worker invokes /api/plan, reserves a model call, calls AI.run once, then calls /internal/execute. Invalid model calls are failed observations, not silently corrected or retried.

## Graph and learning

Use HydraDB 0.4.0 over HTTP /v1/graphs/default/query with scalar parameters and X-Graph-Namespace. Integer vertex IDs; serialize tool schemas as string properties. Directed bounded traversals resolve alias -> service -> resource and skill -> tools -> prerequisites/server. Read actual supporting edges for receipts. No fake success or in-memory traversal fallback. HydraDB supports edge-pattern writes, narrow RETURN projections, and bounded single-type variable-length paths; do not assume full Neo4j syntax.

Scope: 12 tool schemas, three skills, four services, two incident families (deployment and provider). Live provider tools read only constant Cloudflare status API URLs; service metrics/logs/deployments are labelled sandbox fixtures. Request-resolved service and resource IDs come from the graph before model invocation.

Beta counts per family/skill start at 1/1. Score = normalized lexical relevance + successes/(successes+failures); stable-ID ties. Select a whole prerequisite bundle that fits 4096 UTF-8 schema bytes, otherwise abstain. Persist session counts and version updates; frozen ignores learned weights. The daily model counter is durable, capped at 60 attempts per UTC day. Max prompt 16 KiB, completion 256 tokens.

## Evaluation

40 training tasks, 20 locked held-out tasks, independently authored expected observations. Same families, different incident instances, service identities, aliases and wording between splits. Deterministic all/lexical/frozen/graph comparisons and training checkpoints 0/10/20/40. Train from actual sandbox execution outcomes only. Actual agent comparison: 10 fixed held-out tasks, full/frozen/learned once, fixed model parameters. Preserve all failures.

Measure observation-based success, prerequisite completeness, irrelevant schemas, UTF-8 schema bytes, actual model tokens/neurons and latency separately. Show engine queries and graph version. Alias/prerequisite edge ablation should change results. No fabricated improvement curve, customer traction or load claims.

Public repo contains this application's MIT-licensed source. The external HydraDB image is governed by its own license.
