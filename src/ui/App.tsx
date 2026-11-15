import { useEffect, useId, useRef, useState } from 'react';
import { Activity, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Database, FileCode2, GitBranch, Layers3, LoaderCircle, Network, Play, RefreshCw, Terminal, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import type { AgentRun, Bootstrap, EvaluationReport, FeedbackResult, GraphNode, GraphReceipt, Mode, Plan, ToolDefinition, Weight } from '../shared/contracts';

type View = 'workbench' | 'evidence' | 'catalog';
type ApiFailure = Error & { plan?: Plan };
const modes: { id: Mode; label: string; short: string; description: string }[] = [
  { id: 'graph', label: 'Learned graph', short: 'Learned', description: 'Select a complete prerequisite bundle using this session’s feedback.' },
  { id: 'frozen', label: 'Frozen graph', short: 'Frozen', description: 'Use the same graph with its initial weights.' },
  { id: 'all', label: 'Full catalog', short: 'Full catalog', description: 'Supply every available tool schema.' },
  { id: 'lexical', label: 'Keyword baseline', short: 'Keyword', description: 'Rank individual schemas by lexical relevance within the byte budget.' },
];
const modeName = (mode: Mode) => modes.find(m => m.id === mode)?.label ?? mode;
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 1 });
const duration = (value: number) => value >= 1000 ? `${number(value / 1000)} s` : `${number(value)} ms`;
const clockTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const stringify = (value: unknown) => JSON.stringify(value, null, 2);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const failure: ApiFailure = new Error(data?.error ?? `Request failed (${response.status})`);
    if (data?.plan) failure.plan = data.plan;
    throw failure;
  }
  if (!data || typeof data !== 'object') throw new Error('The API returned an unreadable response.');
  return data as T;
}

function sessionKey() {
  const key = 'incident-context.session';
  try {
    const existing = localStorage.getItem(key);
    if (existing && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(existing)) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch { return crypto.randomUUID(); }
}

function Mark() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h6l4 6h6M4 18h6l4-6M10 6v12" stroke="currentColor" strokeWidth="1.5" /><circle cx="4" cy="6" r="2" fill="var(--ground)" stroke="currentColor" /><circle cx="4" cy="18" r="2" fill="var(--ground)" stroke="currentColor" /><circle cx="20" cy="12" r="2" fill="var(--ground)" stroke="currentColor" /></svg>;
}

function SourceTag({ source }: { source: string }) { return <span className={`source-tag ${source === 'live' ? 'live' : ''}`}><span className="source-dot" />{source === 'live' ? 'Live provider' : 'Sandbox'}</span>; }
function Pending({ children }: { children: React.ReactNode }) { return <div className="empty-state"><span className="empty-symbol"><Network size={20} strokeWidth={1.25} /></span><p>{children}</p></div>; }

function Receipt({ receipt, title = 'Query receipt' }: { receipt: GraphReceipt; title?: string }) {
  return <details className="receipt">
    <summary><span><Terminal size={14} />{title}</span><span className="receipt-meta"><span className="num">{receipt.queries.length}</span> queries <ChevronDown size={14} /></span></summary>
    <div className="receipt-body"><div className="receipt-source"><span>{receipt.engine} {receipt.engineVersion}</span><span>Graph <span className="num">v{receipt.graphVersion}</span> · engine <span className="num">{duration(receipt.durationMs)}</span></span></div>
      {receipt.queries.map((query, index) => <div className="query" key={`${index}-${query.cypher}`}><div className="query-caption"><span>Query <span className="num">{index + 1}</span></span><span className="num">{query.rows} rows · {duration(query.durationMs)}</span></div><pre><code>{query.cypher}</code></pre>{Object.keys(query.parameters).length > 0 && <pre className="query-parameters"><code>{stringify(query.parameters)}</code></pre>}</div>)}
    </div>
  </details>;
}

function DependencyGraph({ plan, selected, onSelect }: { plan: Plan; selected: GraphNode | null; onSelect: (node: GraphNode) => void }) {
  const marker = useId().replaceAll(':', '');
  const kinds: GraphNode['kind'][] = ['alias', 'service', 'resource', 'skill', 'tool', 'server'];
  const selectedKeys = new Set([plan.service.id, plan.service.resourceId, plan.skill?.id, ...plan.resolvedEntities.map(entity => `alias:${entity.alias}`), ...plan.tools.flatMap(tool => [tool.id, tool.server])]);
  const nodes = plan.receipt.nodes.filter(node => kinds.includes(node.kind) && selectedKeys.has(node.key));
  const edges = plan.receipt.edges.filter(edge => nodes.some(node => node.id === edge.from) && nodes.some(node => node.id === edge.to));
  const maximum = Math.max(1, ...kinds.map(kind => nodes.filter(node => node.kind === kind).length));
  const height = Math.max(220, maximum * 42 + 46);
  const positions = new Map(nodes.map(node => {
    const column = kinds.indexOf(node.kind);
    const siblings = nodes.filter(item => item.kind === node.kind);
    return [node.id, { x: 18 + column * 166, y: 45 + (height - 66 - siblings.length * 42) / 2 + siblings.indexOf(node) * 42 }];
  }));
  return <div className="graph-scroll" tabIndex={0} aria-label="Selected dependency graph. Scroll to explore and tab to inspect each node.">
    <svg className="dependency-graph" width="1008" height={height} viewBox={`0 0 1008 ${height}`} role="group" aria-label="Actual identity resolution and selected tool dependencies from the HydraDB query receipt">
      <defs><marker id={marker} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M1 1l4 2-4 2" fill="none" stroke="currentColor" strokeWidth="1" /></marker></defs>
      {kinds.map((kind, index) => <text key={kind} x={18 + index * 166} y="24" className="graph-column-label">{kind === 'server' ? 'MCP server' : kind.charAt(0).toUpperCase() + kind.slice(1)}</text>)}
      {edges.map((edge, index) => {
        const from = positions.get(edge.from)!, to = positions.get(edge.to)!;
        const sameColumn = from.x === to.x;
        const active = selected?.id === edge.from || selected?.id === edge.to;
        const d = sameColumn ? `M${from.x + 126} ${from.y + 17} C${from.x + 154} ${from.y + 17},${to.x + 154} ${to.y + 17},${to.x + 126} ${to.y + 17}` : `M${from.x + 126} ${from.y + 17} C${from.x + 149} ${from.y + 17},${to.x - 24} ${to.y + 17},${to.x} ${to.y + 17}`;
        return <g key={`${edge.from}-${edge.to}-${index}`} className={active ? 'graph-edge selected-edge' : 'graph-edge'}><path d={d} markerEnd={`url(#${marker})`} /><title>{edge.type}: {nodes.find(node => node.id === edge.from)?.label} → {nodes.find(node => node.id === edge.to)?.label}</title></g>;
      })}
      {nodes.map(node => {
        const point = positions.get(node.id)!;
        return <g key={node.id} transform={`translate(${point.x} ${point.y})`} className={`graph-node ${selected?.id === node.id ? 'is-selected' : ''}`} role="button" tabIndex={0} aria-label={`Inspect ${node.kind}: ${node.label}`} aria-pressed={selected?.id === node.id} onClick={() => onSelect(node)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node); } }}><title>{node.label} · {node.key}</title><rect width="126" height="34" rx="4" /><line x1="0" x2="126" y1="33.5" y2="33.5" className="node-selection-line" /><text x="11" y="13" className="node-kind">{node.kind === 'tool' ? 'ƒ tool' : node.kind}</text><text x="11" y="27" className="node-label">{node.label.length > 17 ? `${node.label.slice(0, 16)}…` : node.label}</text></g>;
      })}
    </svg>
  </div>;
}

function IdentityDetail({ node, plan }: { node: GraphNode | null; plan: Plan }) {
  const tool = plan.tools.find(item => item.id === node?.key);
  if (!node) return <p className="graph-hint"><CircleHelp size={14} />Select a graph node to inspect its resolved identity or exact schema.</p>;
  return <div className="node-detail"><div><span className="muted">Selected {node.kind}</span><strong>{node.label}</strong></div><code>{node.key}</code>{tool ? <details><summary>View tool schema <ChevronDown size={13} /></summary><pre><code>{stringify(tool.parameters)}</code></pre></details> : node.kind === 'service' || node.kind === 'resource' ? <dl className="identity-values"><div><dt>Canonical service</dt><dd><code>{plan.service.id}</code></dd></div><div><dt>Resource</dt><dd><code>{plan.service.resourceId}</code></dd></div>{plan.service.providerComponentId && <div><dt>Provider component</dt><dd><code>{plan.service.providerComponentId}</code></dd></div>}</dl> : <span className="muted node-evidence">Verified node <span className="num">{node.id}</span> in this plan’s graph receipt.</span>}</div>;
}

function ToolBundle({ plan, selectedTool, onSelect }: { plan: Plan | null; selectedTool?: string; onSelect: (tool: ToolDefinition) => void }) {
  const complete = plan ? plan.tools.every(tool => tool.requires.every(name => plan.tools.some(item => item.name === name))) : false;
  return <section className="panel bundle-panel" aria-labelledby="bundle-heading"><div className="panel-heading"><h2 id="bundle-heading">Tool bundle</h2><span className="muted num">{plan ? `${plan.tools.length} schemas` : '—'}</span></div>
    {plan ? <><div className="bundle-summary"><span>{plan.skill?.name ?? modeName(plan.mode)}</span><span className="bundle-completeness">{complete && !plan.abstained ? <Check size={13} /> : <X size={13} />}{plan.abstained ? 'Abstained' : complete ? 'Prerequisites complete' : 'Prerequisites missing'}</span></div><div className="tool-list">{plan.tools.map(tool => <details key={tool.id} className={`tool-entry ${selectedTool === tool.id ? 'tool-selected' : ''}`}><summary onClick={() => onSelect(tool)}><div><code>{tool.name}</code><span className="tool-server">{tool.server}</span></div><ChevronDown size={14} /></summary><div className="tool-content"><SourceTag source={tool.source} /><p>{tool.description}</p><p className="requires"><span>Requires</span> {tool.requires.length ? tool.requires.join(', ') : 'No prerequisites'}</p><details className="schema-detail"><summary>JSON schema <FileCode2 size={13} /></summary><pre><code>{stringify(tool.parameters)}</code></pre></details></div></details>)}</div>{plan.abstained && <p className="inline-note">{plan.reason ?? 'No complete tool bundle selected.'}</p>}<div className="bundle-footer"><Layers3 size={14} /><span>Exact schemas, source boundaries and server metadata travel together.</span></div></> : <Pending>A compiled context will show its complete tool bundle here.</Pending>}
  </section>;
}

function ObservationPanel({ run, running, error }: { run: AgentRun | null; running: boolean; error: string | null }) {
  return <section className="panel observations-panel" aria-labelledby="observations-heading"><div className="panel-heading"><h2 id="observations-heading">Agent observations</h2><span className="muted">{running ? <span className="loading-label"><LoaderCircle size={13} className="spin" />Running agent</span> : run ? `${run.observations.length} returned` : 'Awaiting run'}</span></div>
    {error && <div className="block-error" role="alert"><X size={15} /><p>{error}</p></div>}
    {run ? <><div className="diagnosis"><div className="diagnosis-label"><span>Observed diagnosis</span><span className={`run-status ${run.success === false ? 'failed' : ''}`}>{run.success === null ? 'Outcome unverified' : run.success ? 'Verified outcome' : 'Incomplete outcome'}</span></div><p>{run.answer || 'The run returned no diagnosis.'}</p>{run.reason && <p className="muted">{run.reason}</p>}</div><div className="observations-list">{run.observations.map((observation, index) => <details key={`${observation.tool}-${index}`} className="observation"><summary><span className="observation-main">{observation.ok ? <Check size={14} /> : <X size={14} />}<code>{observation.tool}</code><SourceTag source={observation.source} /></span><span className="observation-timing"><span className="num">{duration(observation.durationMs)}</span><ChevronDown size={13} /></span></summary><div className="observation-content"><div className="observation-stamp">Observed {new Date(observation.observedAt).toLocaleString()} · {observation.ok ? 'Tool returned' : 'Tool failed'}</div>{observation.error && <p className="observation-error">{observation.error}</p>}<pre><code>{stringify(observation.result)}</code></pre></div></details>)}</div><div className="usage-strip"><span>Model usage</span><span><span className="num">{run.usage.promptTokens === null ? '—' : number(run.usage.promptTokens)}</span> input tokens</span><span><span className="num">{run.usage.completionTokens === null ? '—' : number(run.usage.completionTokens)}</span> output tokens</span><span><span className="num">{run.usage.neurons === null ? '—' : number(run.usage.neurons)}</span> neurons</span><span className="num">{duration(run.totalDurationMs ?? run.durationMs)} {run.totalDurationMs === undefined ? 'tool execution' : 'total'}</span></div><details className="run-metadata"><summary>Run metadata <ChevronDown size={13} /></summary><dl><div><dt>Run ID</dt><dd><code>{run.id}</code></dd></div><div><dt>Requested model</dt><dd><code>{run.requestedModel}</code></dd></div><div><dt>Returned model</dt><dd><code>{run.returnedModel}</code></dd></div><div><dt>Created</dt><dd>{new Date(run.createdAt).toLocaleString()}</dd></div></dl><p className="muted">Missing usage is unreported by the model provider. Sandbox observations describe simulated incidents; live provider status does not establish the cause of a service outage.</p><pre><code>{stringify(run.calls)}</code></pre></details></> : <div className="awaiting-run"><Activity size={19} strokeWidth={1.4} /><div><p>{running ? 'Waiting for the model and bounded tool execution.' : 'Context is ready before the agent runs.'}</p><span>{running ? 'Actual tool results will appear here as one completed run.' : 'Run the agent to inspect its tool calls, observations and diagnosis.'}</span></div></div>}
  </section>;
}

function LearningPanel({ weights, plan, run, feedback, feedbackError, submitting, rated, onFeedback }: { weights: Weight[]; plan: Plan | null; run: AgentRun | null; feedback: FeedbackResult | null; feedbackError: string | null; submitting: boolean; rated: boolean; onFeedback: (correct: boolean) => void }) {
  const weight = weights.find(item => item.family === plan?.family && item.skillId === plan?.skill?.id);
  return <section className="panel learning-panel" aria-labelledby="learning-heading"><div className="panel-heading"><h2 id="learning-heading">Session learning</h2><GitBranch size={15} className="muted" /></div><div className="learning-content"><p>Was this tool context useful?</p><span className="muted">Feedback adjusts this session’s skill weight.</span><div className="feedback-actions"><button onClick={() => onFeedback(true)} disabled={!run || submitting || rated}><ThumbsUp size={14} />Correct</button><button onClick={() => onFeedback(false)} disabled={!run || submitting || rated}><ThumbsDown size={14} />Incorrect</button></div>{!run && <p className="feedback-hint">Available after an agent run.</p>}{rated && <p className="feedback-hint"><Check size={13} />Feedback recorded for this run.</p>}{feedbackError && <p className="feedback-error" role="alert">{feedbackError}</p>}<div className="weight-detail"><span>{plan?.skill?.name ?? 'Selected skill'}</span><div><span className="num">{weight ? `${weight.successes} / ${weight.failures}` : '—'}</span><span className="muted">success / failure counts</span></div></div>{weight && <p className="weight-caption">Beta prior <span className="num">1 / 1</span> · usefulness <span className="num">{number(weight.usefulness)}</span></p>}{feedback && <><p className="feedback-stamp">Saved {clockTime(feedback.recordedAt)} · graph <span className="num">v{feedback.graphVersion}</span></p>{feedback.receipt && <Receipt receipt={feedback.receipt} title="Feedback receipt" />}</>}</div></section>;
}

function EvaluationView({ report, loading, error, onRefresh }: { report: EvaluationReport | null; loading: boolean; error: string | null; onRefresh: () => void }) {
  const checkpoints = report?.curve ?? [];
  const chartWidth = 680, chartHeight = 210, pad = { left: 45, right: 22, top: 22, bottom: 38 };
  const xMax = Math.max(40, ...checkpoints.map(point => point.checkpoint));
  const position = (point: (typeof checkpoints)[number]) => ({ x: pad.left + point.checkpoint / xMax * (chartWidth - pad.left - pad.right), y: pad.top + (1 - (point.tasks ? point.successes / point.tasks : 0)) * (chartHeight - pad.top - pad.bottom) });
  return <><div className="page-title"><div><h1>Evaluation evidence</h1><p>Fixed held-out tasks. Measured outcomes, context bytes and execution time.</p></div><button onClick={onRefresh} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} />Refresh</button></div>{error && <div className="block-error" role="alert"><X size={15} /><p>{error}</p></div>}{!report ? <section className="panel"><Pending>{loading ? 'Reading the benchmark report.' : 'The evaluation report is unavailable. Refresh to retry.'}</Pending></section> : <>
    <div className="report-scope"><span>{report.status === 'pending' ? 'Benchmark pending' : `Generated ${report.generatedAt ? new Date(report.generatedAt).toLocaleString() : '—'}`}</span><span><span className="num">{report.trainingTasks}</span> training tasks / <span className="num">{report.heldoutTasks}</span> held-out tasks</span><span>Graph <span className="num">v{report.graphVersion}</span></span></div>
    <section className="panel benchmark-panel"><div className="panel-heading"><h2>Context strategy comparison</h2><span className="muted">Deterministic tool execution</span></div>{report.rows.length ? <div className="table-scroll"><table><thead><tr><th>Selection strategy</th><th>Observed success</th><th>Complete prerequisites</th><th>Mean schema bytes</th><th>Irrelevant tools</th><th>p50 / p95</th></tr></thead><tbody>{report.rows.map(row => <tr key={row.mode}><td>{modeName(row.mode)}</td><td className="num">{row.successes} / {row.tasks}</td><td className="num">{row.completePrerequisites} / {row.tasks}</td><td className="num">{number(row.meanSchemaBytes)} B</td><td className="num">{number(row.irrelevantTools)}</td><td className="num">{duration(row.p50Ms)} / {duration(row.p95Ms)}</td></tr>)}</tbody></table></div> : <Pending>The benchmark has not produced measured comparisons yet. No improvement is claimed.</Pending>}</section>
    <div className="evidence-grid"><section className="panel curve-panel"><div className="panel-heading"><h2>Learning checkpoints</h2><span className="muted">Held-out workflow completion</span></div>{checkpoints.length ? <><div className="curve-scroll"><svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Observed held-out success rate at each measured training checkpoint">{[0, .25, .5, .75, 1].map(tick => { const y = pad.top + (1 - tick) * (chartHeight - pad.top - pad.bottom); return <g key={tick}><line x1={pad.left} x2={chartWidth - pad.right} y1={y} y2={y} className="curve-grid" /><text x={pad.left - 10} y={y + 4} textAnchor="end">{tick * 100}%</text></g>; })}<polyline points={checkpoints.map(point => { const p = position(point); return `${p.x},${p.y}`; }).join(' ')} className="curve-line" />{checkpoints.map(point => { const p = position(point); return <g key={point.checkpoint}><circle cx={p.x} cy={p.y} r="3" className="curve-point"><title>{point.checkpoint} training tasks: {point.successes}/{point.tasks} successes; {number(point.meanSchemaBytes)} schema bytes</title></circle><text x={p.x} y={chartHeight - 14} textAnchor="middle">{point.checkpoint}</text></g>; })}</svg></div><p className="chart-caption">Training tasks completed</p><div className="checkpoint-values">{checkpoints.map(point => <div key={point.checkpoint}><span>After <span className="num">{point.checkpoint}</span> tasks</span><strong className="num">{point.successes} / {point.tasks}</strong><span className="muted num">{number(point.meanSchemaBytes)} B</span></div>)}</div></> : <Pending>Checkpoints will appear after training is executed against real tool outcomes.</Pending>}</section>
    <section className="panel methodology-panel"><div className="panel-heading"><h2>Measurement notes</h2><FileCode2 size={15} className="muted" /></div><div className="methodology-content">{report.notes.map((note, index) => <p key={index}>{note}</p>)}{!report.notes.length && <p>Training feedback and held-out evaluation remain separate. Engine time and model usage are measured independently.</p>}<dl><div><dt>Dataset hash</dt><dd><code>{report.datasetHash ?? 'Not generated'}</code></dd></div><div><dt>Report status</dt><dd>{report.status}</dd></div></dl></div></section></div>
    <section className="panel live-comparison"><div className="panel-heading"><h2>Actual agent comparison</h2><span className="muted">One model call per run</span></div>{report.live ? <div className="table-scroll"><table><thead><tr><th>Selection strategy</th><th>Observed success</th><th>Recorded run IDs</th></tr></thead><tbody>{report.live.rows.map(row => <tr key={row.mode}><td>{modeName(row.mode)}</td><td className="num">{row.successes} / {report.live!.tasks}</td><td><details><summary>{row.runIds.length} recorded runs <ChevronDown size={13} /></summary><pre><code>{row.runIds.join('\n')}</code></pre></details></td></tr>)}</tbody></table></div> : <Pending>Model comparisons are pending. Deterministic tool outcomes do not stand in for model results.</Pending>}</section>
  </>}</>;
}

function CatalogView({ bootstrap }: { bootstrap: Bootstrap | null }) {
  const [search, setSearch] = useState('');
  const tools = bootstrap?.tools.filter(tool => `${tool.name} ${tool.description} ${tool.server}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <><div className="page-title"><div><h1>Tool catalog</h1><p>Actual tool definitions available to the incident agent.</p></div><span className="muted"><span className="num">{bootstrap?.tools.length ?? '—'}</span> schemas</span></div><div className="catalog-toolbar"><label htmlFor="catalog-search">Find a tool</label><input id="catalog-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, server or capability" /></div><section className="panel catalog-panel"><div className="catalog-header"><span>Tool / capability</span><span>Source / MCP server</span><span>Prerequisites</span></div>{tools.map(tool => <details className="catalog-tool" key={tool.id}><summary><div><code>{tool.name}</code><p>{tool.description}</p></div><div><SourceTag source={tool.source} /><span className="tool-server">{tool.server}</span></div><div className="catalog-requires">{tool.requires.length ? tool.requires.map(name => <code key={name}>{name}</code>) : <span className="muted">None</span>}<ChevronDown size={14} /></div></summary><div className="catalog-schema"><pre><code>{stringify(tool.parameters)}</code></pre></div></details>)}{!tools.length && <Pending>{bootstrap ? 'No tools match this search.' : 'The tool catalog is unavailable until the graph connects.'}</Pending>}</section></>;
}

export default function App() {
  const [sessionId] = useState(sessionKey);
  const [view, setView] = useState<View>(() => location.hash === '#evidence' ? 'evidence' : location.hash === '#catalog' ? 'catalog' : 'workbench');
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [task, setTask] = useState('');
  const [scenario, setScenario] = useState('');
  const [mode, setMode] = useState<Mode>('graph');
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackResult | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [ratedRuns, setRatedRuns] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(`incident-context.rated.${sessionId}`) ?? '[]'); } catch { return []; } });
  const planSequence = useRef(0);
  const busy = planning || running || loading;
  const dirty = !!plan && (plan.task !== task || plan.mode !== mode);

  function acceptPlan(next: Plan) { setPlan(next); setSelectedNode(next.receipt.nodes.find(node => node.kind === 'alias') ?? null); setBootstrap(current => current ? { ...current, graphVersion: next.receipt.graphVersion } : current); }
  async function compile(nextTask = task, nextMode = mode) {
    if (!nextTask.trim()) return;
    const sequence = ++planSequence.current;
    setPlanning(true); setPlanError(null); setRun(null); setRunError(null); setFeedback(null);
    try { const next = await api<Plan>('/api/plan', { task: nextTask, sessionId, mode: nextMode, budget: 4096 }); if (sequence === planSequence.current) acceptPlan(next); }
    catch (error) { if (sequence === planSequence.current) setPlanError((error as Error).message); }
    finally { if (sequence === planSequence.current) setPlanning(false); }
  }
  async function load() {
    setLoading(true); setLoadError(null);
    try {
      const data = await api<Bootstrap>(`/api/bootstrap?sessionId=${encodeURIComponent(sessionId)}`);
      setBootstrap(data);
      if (data.engine.status !== 'ready') { setLoadError('HydraDB is unavailable. Retry when the graph engine is ready.'); return; }
      const initial = data.scenarios[0];
      if (initial) { setTask(initial.task); setScenario(initial.id); await compile(initial.task, 'graph'); }
    } catch (error) { setLoadError((error as Error).message); }
    finally { setLoading(false); }
  }
  async function loadReport() {
    setReportLoading(true); setReportError(null);
    try { setReport(await api<EvaluationReport>('/api/evaluation')); }
    catch (error) { setReportError((error as Error).message); }
    finally { setReportLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (view === 'evidence' && !report && !reportLoading) void loadReport(); }, [view]);
  useEffect(() => { const update = () => setView(location.hash === '#evidence' ? 'evidence' : location.hash === '#catalog' ? 'catalog' : 'workbench'); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  function navigate(next: View) { setView(next); location.hash = next === 'workbench' ? '' : next; }
  async function runAgent(event: React.SubmitEvent) {
    event.preventDefault();
    if (!task.trim() || busy) return;
    setRunning(true); setRunError(null); setRun(null); setFeedback(null); setFeedbackError(null);
    try { const next = await api<AgentRun>('/api/run', { task, sessionId, mode, budget: 4096 }); setRun(next); acceptPlan(next.plan); }
    catch (error) { const failure = error as ApiFailure; setRunError(failure.message); if (failure.plan) acceptPlan(failure.plan); }
    finally { setRunning(false); void api<Bootstrap>(`/api/bootstrap?sessionId=${encodeURIComponent(sessionId)}`).then(setBootstrap).catch(() => {}); }
  }
  async function recordFeedback(correct: boolean) {
    if (!run || submittingFeedback || ratedRuns.includes(run.id)) return;
    setSubmittingFeedback(true); setFeedbackError(null);
    try { const result = await api<FeedbackResult>('/api/feedback', { runId: run.id, sessionId, correct }); setFeedback(result); setBootstrap(current => current ? { ...current, graphVersion: result.graphVersion, weights: current.weights.map(weight => weight.family === result.after.family && weight.skillId === result.after.skillId ? result.after : weight) } : current); const next = [...ratedRuns, run.id]; setRatedRuns(next); try { localStorage.setItem(`incident-context.rated.${sessionId}`, JSON.stringify(next)); } catch {} }
    catch (error) { setFeedbackError((error as Error).message); }
    finally { setSubmittingFeedback(false); }
  }
  function chooseTool(tool: ToolDefinition) { const node = plan?.receipt.nodes.find(item => item.kind === 'tool' && item.key === tool.id); if (node) setSelectedNode(node); }
  const budget = bootstrap?.budget;
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to workbench</a><aside className="icon-rail"><div className="rail-mark"><Mark /></div><nav aria-label="Primary"><button title="Context workbench" aria-label="Context workbench" aria-current={view === 'workbench' ? 'page' : undefined} onClick={() => navigate('workbench')}><Network size={19} /><span>Context</span></button><button title="Evaluation evidence" aria-label="Evaluation evidence" aria-current={view === 'evidence' ? 'page' : undefined} onClick={() => navigate('evidence')}><Activity size={19} /><span>Evidence</span></button><button title="Tool catalog" aria-label="Tool catalog" aria-current={view === 'catalog' ? 'page' : undefined} onClick={() => navigate('catalog')}><Layers3 size={19} /><span>Catalog</span></button></nav><div className="rail-bottom"><span title={`Session ${sessionId}`} aria-label={`Session ${sessionId}`}><Database size={17} /></span></div></aside>
    <div className="app-body"><header className="top-bar"><div className="product-name"><span className="mobile-mark"><Mark /></span><strong>Incident Context</strong><span className="top-divider" /><span className="workspace">Sandbox / live provider</span></div><div className="engine-status"><span className={`engine-dot ${bootstrap?.engine.status === 'ready' ? 'ready' : ''}`} /><span>{loading ? 'Connecting to HydraDB' : bootstrap?.engine.status === 'ready' ? `HydraDB ${bootstrap.engine.version}` : 'Graph unavailable'}</span>{bootstrap && <span className="version num">v{bootstrap.graphVersion}</span>}</div></header>
    <main id="main-content" className="canvas">{view === 'workbench' ? <><div className="page-title"><div><h1>Context workbench</h1><p>{plan ? `${plan.service.name} · ${plan.skill?.name ?? modeName(plan.mode)}` : 'Complete tool context, with the graph evidence behind it.'}</p></div><div className="session-scope"><span>Session <code>{sessionId.slice(0, 8)}</code></span><span>{budget ? <><span className="num">{budget.calls} / {budget.limit}</span> daily model calls</> : 'Model budget unavailable'}</span></div></div>
      <form className="request-panel" onSubmit={runAgent}><div className="request-heading"><label htmlFor="incident-task">Incident request</label><div className="scenario-select"><label className="sr-only" htmlFor="scenario">Choose an incident scenario</label><select id="scenario" value={scenario} disabled={!bootstrap || busy} onChange={event => { const next = bootstrap?.scenarios.find(item => item.id === event.target.value); setScenario(event.target.value); setRun(null); setRunError(null); setFeedback(null); if (next) { setTask(next.task); void compile(next.task); } }}><option value="">Custom investigation</option>{bootstrap?.scenarios.map(item => <option key={item.id} value={item.id}>{item.title} · {item.source === 'live' ? 'Live provider' : 'Sandbox'}</option>)}</select><ChevronDown size={13} /></div></div><div className="request-main"><textarea id="incident-task" value={task} placeholder="Describe a service incident and the evidence you need…" maxLength={16384} disabled={running} onChange={event => { setTask(event.target.value); setScenario(''); }} aria-describedby="request-help" /><button className="run-button" type="submit" disabled={!task.trim() || busy || !bootstrap || bootstrap.engine.status !== 'ready'}>{running ? <LoaderCircle className="spin" size={16} /> : <Play size={15} />}<span>{running ? 'Running…' : 'Run agent'}</span><ArrowUpRight size={14} /></button></div><div className="request-footer"><div className="mode-tabs" role="group" aria-label="Context selection strategy">{modes.map(item => <button key={item.id} type="button" title={item.description} aria-pressed={mode === item.id} className={mode === item.id ? 'selected' : ''} disabled={busy} onClick={() => { setMode(item.id); setRun(null); setRunError(null); setFeedback(null); void compile(task, item.id); }}>{item.label}</button>)}</div><button type="button" className="compile-button" onClick={() => void compile()} disabled={!task.trim() || busy || !bootstrap}><RefreshCw size={13} className={planning ? 'spin' : ''} />{planning ? 'Compiling…' : 'Compile context'}</button></div><p id="request-help" className="request-help sr-only">Compiling queries the graph. Running uses one model call and up to four diagnostic tools.</p></form>
      {loadError && <div className="block-error connection-error" role="alert"><Database size={16} /><div><strong>Graph connection unavailable</strong><p>{loadError}</p></div><button onClick={() => void load()} disabled={loading}><RefreshCw size={14} />Retry</button></div>}
      {planError && <div className="block-error" role="alert"><X size={15} /><p>{planError}</p><button onClick={() => void compile()} disabled={busy}>Retry compile</button></div>}
      <div className="workbench-grid"><section className="panel graph-panel" aria-labelledby="graph-heading"><div className="panel-heading"><div><h2 id="graph-heading">Selection path</h2><span className="muted graph-subtitle">Identity resolution & tool dependencies</span></div><span className="graph-state">{planning ? <><LoaderCircle size={13} className="spin" />Compiling</> : dirty ? 'Request changed · compile to update' : plan ? <><Check size={13} />{plan.abstained ? 'Abstained' : 'Graph verified'}</> : loading ? 'Connecting' : 'No compiled plan'}</span></div>{plan ? <><div className="context-measure"><div><strong className="num">{number(plan.schemaBytes)}<span> B</span></strong><span>selected schema ? {plan.savedPercent}% smaller</span></div><ArrowRight size={16} className="measure-arrow" /><div><strong className="num">{number(plan.fullSchemaBytes)}<span> B</span></strong><span>full catalog</span></div><div className="measure-note"><span className="num">{number(4096)} B budget</span><span>UTF-8 · exact serialized schemas</span></div></div><DependencyGraph plan={plan} selected={selectedNode} onSelect={setSelectedNode} /><IdentityDetail node={selectedNode} plan={plan} /><div className="graph-footer"><span><span className="num">{plan.receipt.nodes.length}</span> receipt nodes · <span className="num">{plan.receipt.edges.length}</span> edges</span><span>Graph <span className="num">v{plan.receipt.graphVersion}</span> · engine <span className="num">{duration(plan.receipt.durationMs)}</span></span></div><Receipt receipt={plan.receipt} /></> : <Pending>{loading ? 'Connecting to the real graph and compiling the first incident context.' : 'Compile an incident request to inspect its actual graph paths.'}</Pending>}</section><ToolBundle plan={plan} selectedTool={selectedNode?.kind === 'tool' ? selectedNode.key : undefined} onSelect={chooseTool} />
      <ObservationPanel run={run} running={running} error={runError} /><LearningPanel weights={bootstrap?.weights ?? []} plan={plan} run={run} feedback={feedback} feedbackError={feedbackError} submitting={submittingFeedback} rated={!!run && ratedRuns.includes(run.id)} onFeedback={correct => void recordFeedback(correct)} /></div>
      <footer className="workspace-footer"><span>Sandbox incidents are simulated. Live observations come from the provider’s public status API.</span><button onClick={() => navigate('evidence')}>Inspect evaluation evidence <ArrowRight size={13} /></button></footer>
    </> : view === 'evidence' ? <EvaluationView report={report} loading={reportLoading} error={reportError} onRefresh={() => void loadReport()} /> : <CatalogView bootstrap={bootstrap} />}</main></div>
  </div>;
}
