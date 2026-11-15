# Incident Context design

The screen answers one question: Which complete tool context does this incident agent need, and what real graph path justifies it?

The accepted direction is **Data terminal**, seed **1081354021**, with no redraw. Public Sans carries the workbench; IBM Plex Mono has one job: IDs, code and figures. Neutral ground `#171719`, darker surfaces `#131217`, and a single `#4a8ad6` selection line keep attention on the graph rather than chrome. The face is the product's actual dependency structure: alias → canonical service → resource, together with selected skill → diagnostic tools → prerequisites and MCP server. The UI draws only edges returned in a real query receipt; it does not fabricate a resource-to-skill relationship.

The 56px rail names three real views: Context, Evidence and Catalog. The top bar names Incident Context and its Sandbox / live provider scope. The most frequent action is Run agent. Compiling context is independent of the model budget and runs on initial load against the first actual bootstrap scenario.

At 1440px, the layout closes as 56px rail + 2 × 28px gutters + 1328px canvas. The canvas is 984px graph + 20px gap + 324px tools. The graph is the lead; tool metadata sits beside it. Observations and session learning occupy the second row. At tablet widths the tools and observations stack. At 390px the rail becomes bottom navigation; graph and benchmark overflow stay inside their own scrollable frames.

Every displayed number comes from an API response or its visible rows. Schema size is exact UTF-8 bytes, with the full catalog comparison and the 4096-byte selection budget. Graph engine duration and actual model tokens/neurons are separate. Unreported usage is a dash; an unknown result stays unverified. Provider status is explicitly provider-reported evidence, and sandbox tools are labelled simulated. Evaluation stays pending until the backend supplies measured rows; there is no sample curve.

Graph nodes support pointer, Enter and Space selection. Expandable exact JSON schemas and Cypher query receipts preserve provenance. Feedback is bound to the run's session, disabled after submission, and updates actual returned Beta counts; the backend remains authoritative on duplicates. Loading, unavailable graph, compile failures, agent failures, empty observations and pending evaluation keep their local frames and offer meaningful next actions.

## Verification

- `npm run build`: passed (Vite 8.3.8 production build).
- `npm run typecheck`: passed after the independently owned evaluation fixtures were corrected.
- Taste lint: 0 failures, one expected warning for the dealt figure/ID monospace.
- Real-browser inspector against local Wrangler and the actual authenticated backend: **0 failures at 1440, 768 and 390px**. All six final screenshots were opened. Artifacts are in the ignored `.taste-skill/ui-final/` directory.
- Playwright interactions against the actual backend: graph service selection displays its canonical service/resource; Frozen mode recompiles; Catalog displays the 12 actual tool definitions; Evidence displays the actual pending report. No model calls or feedback writes were made during these checks. The parent owns the live model/feedback integration verification.
- The final captured release context was **2,279 UTF-8 bytes** against a **6,560-byte** full catalog. These are the returned measurements at capture time, not hardcoded UI content.

## Screenshot critique

ROUND 1

Seen in one second: an incident operations workbench with an unavailable graph.

Idea (one sentence): put the context selection proof beside the agent action.

Live thing: honest API unavailable/retry state; no fallback graph.

Layout words by section: request=composer / graph=empty evidence frame / bundle=empty metadata frame / observations=waiting / learning=feedback.

Scores: design 6.8 · usability 7.6 · creativity 7.4 · content 7.8 → overall 7.3.

Caps applied: none; app-screen rules apply.

Top three problems (most visible first), each with the screenshot it shows in and the fix:

1. `ui-first/desktop-fold.jpg`: the unavailable graph creates too much empty height. Shorten the empty graph frame.
2. `ui-first/desktop-fold.jpg`: the lower work blocks only begin at the bottom edge. Remove the repeated composer help line and compress graph metadata.
3. `ui-first/mobile-fold.jpg`: 9–10px secondary text is too small. Raise every such label to the 11px minimum.

ROUND 2

Seen in one second: a real alias resolution and prerequisite graph with its selected tool bundle.

Idea (one sentence): identity and dependency evidence explain the precise schemas supplied to the agent.

Live thing: real HydraDB plan, clickable graph identities and expandable schemas/receipts.

Layout words by section: request=composer / graph=dependency lanes / bundle=tool list / observations=waiting / learning=session counts.

Scores: design 7.3 · usability 7.7 · creativity 8.0 · content 8.5 → overall 7.7.

Caps applied: none; metadata and figure monospace are explicit app-direction choices.

Top three problems (most visible first), each with the screenshot it shows in and the fix:

1. `ui-real/desktop-fold.jpg`: the observations and learning first content still sits below the 900px fold. Compress the graph/header and remove repeated selected-node prose.
2. `ui-real/desktop-fold.jpg`: bootstrap and plan show different graph versions after session resolution. Update the shell version from the accepted plan receipt.
3. `ui-real/tablet-fold.jpg`: the graph includes long-session context that can distract from the selected incident. Filter its visible region to actual selected keys while preserving every displayed receipt edge.

ROUND 3

Seen in one second: an incident request, exact schema selection and the graph that justifies it.

Idea (one sentence): the complete tool context is the working object, with provenance attached.

Live thing: actual initial plan, strategy changes, schema and query inspection, real catalog/evaluation views.

Layout words by section: request=composer / graph=dependency lanes / bundle=prerequisite list / observations=run evidence / learning=Beta feedback.

Scores: design 7.5 · usability 8.0 · creativity 8.0 · content 8.5 → overall 7.9.

Caps applied: none; app screens have no photography or entrance-motion requirement.

Top three remaining limitations (most visible first):

1. `ui-final/desktop-page-01.jpg`: the waiting observations block is shorter than the feedback block by 81px; actual run content naturally expands it. The inspector warns on this empty state.
2. `ui-final/desktop-fold.jpg`: 79% of detected text is under 13px. Most is graph labels, IDs, source/server metadata and query counts; request text is 14px and expanded tool content is 13px. This is the chosen dense monitoring treatment.
3. `ui-final/mobile-fold.jpg`: the actual graph keeps an internal horizontal scroll region to preserve readable node text. Keyboard node focus and node selection expose the complete identity; all surrounding content reflows without page overflow.

No sample data, photographs or simulated improvement figures were introduced in the frontend. Incident fixtures are provided and labelled by the backend.
