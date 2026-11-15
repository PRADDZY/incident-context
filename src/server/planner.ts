import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Family, GraphReceipt, Plan, PlanRequest, ToolDefinition } from '../shared/contracts.ts';
import { schemaBytes } from './catalog.ts';
import { GraphRepository } from './graph.ts';
import { StateStore } from './state.ts';
import { ApiError } from './errors.ts';
import { GraphSessions, initialWeights } from './sessions.ts';

const words = (value: string) => new Set(value.toLowerCase().replaceAll('_', ' ').match(/[a-z0-9]+/g) ?? []);
export function lexicalScore(task: string, description: string): number {
  const query = words(task), document = words(description);
  const common = [...query].filter(word => document.has(word)).length;
  return common / Math.max(1, Math.sqrt(query.size * document.size));
}
export function taskFamily(task: string): Family {
  if (/cloudflare|provider/i.test(task)) return 'provider';
  if (/deploy|rollout|release|rollback|regression/i.test(task)) return 'deployment';
  return /upstream|component|outage|status/i.test(task) ? 'provider' : 'deployment';
}

export class Planner {
  public sessions: GraphSessions;
  constructor(public graph: GraphRepository, public state: StateStore, sessions?: GraphSessions) { this.sessions = sessions ?? new GraphSessions(graph.engine); }

  async plan(request: PlanRequest): Promise<Plan> {
    if (Buffer.byteLength(request.task, 'utf8') > 16 * 1024 || !request.task.trim()) throw new ApiError(400, 'Task must contain 1–16384 UTF-8 bytes');
    const start = performance.now();
    const mode = request.mode ?? 'graph';
    const budget = Math.min(4096, request.budget ?? 4096);
    const family = taskFamily(request.task);
    const snapshot = await this.graph.snapshot();
    if (!snapshot.tools.length || !snapshot.skills.length) throw new ApiError(503, 'HydraDB catalog is not seeded');
    const resolved = await this.graph.resolve(request.task, snapshot);
    const memory = await this.sessions.remember(request.sessionId, resolved.service, snapshot.skills);
    const queries = [...snapshot.queries, ...resolved.queries, ...memory.queries];
    const weights = mode === 'frozen' ? initialWeights(snapshot.skills) : memory.weights;
    const ranked = snapshot.skills.map(skill => ({ skill, score: lexicalScore(request.task, `${skill.name} ${skill.description}`) + (weights.find(w => w.family === family && w.skillId === skill.id)?.usefulness ?? 0.5) }))
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
    let tools: ToolDefinition[] = [];
    let skill: Plan['skill'] = null;
    let reason: string | null = null;
    const nodeIds = new Set(resolved.nodes.map(n => n.id));
    memory.edges.filter(e => e.type === 'HAS_SESSION').forEach(e => nodeIds.add(e.from));
    if (mode === 'all') tools = snapshot.tools;
    else if (mode === 'lexical') {
      const candidates = [...snapshot.tools].sort((a, b) => lexicalScore(request.task, `${b.name} ${b.description}`) - lexicalScore(request.task, `${a.name} ${a.description}`) || a.id.localeCompare(b.id));
      for (const tool of candidates) if (schemaBytes([...tools, tool]) <= budget) tools.push(tool);
      if (!tools.length) reason = 'No complete tool schema fits the lexical budget';
    } else {
      skill = ranked[0].skill;
      const bundle = await this.graph.bundle(skill, snapshot);
      queries.push(...bundle.queries);
      bundle.nodeIds.forEach(id => nodeIds.add(id));
      if (!bundle.complete) reason = 'Selected skill prerequisite or server edges are incomplete in HydraDB';
      else if (schemaBytes(bundle.tools) > budget) reason = 'Selected complete skill bundle exceeds the schema budget';
      else if (family === 'provider' && !resolved.service.providerComponentId) reason = 'Live provider directory component could not be resolved into the graph';
      else tools = bundle.tools;
    }
    tools.forEach(t => {
      const node = snapshot.nodes.find(n => n.kind === 'tool' && n.key === t.id);
      if (node) nodeIds.add(node.id);
    });
    snapshot.edges.filter(e => nodeIds.has(e.from) && e.type === 'HOSTED_BY').forEach(e => nodeIds.add(e.to));
    const receipt: GraphReceipt = { engine: 'HydraDB', engineVersion: '0.4.0', queries, nodes: [...snapshot.nodes.filter(n => nodeIds.has(n.id)), ...memory.nodes.filter(n => !snapshot.nodes.some(existing => existing.id === n.id && nodeIds.has(n.id)))], edges: [...snapshot.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to)), ...memory.edges], durationMs: Math.round((performance.now() - start) * 100) / 100, graphVersion: memory.graphVersion };
    const fullSchemaBytes = schemaBytes(snapshot.tools), selectedBytes = schemaBytes(tools);
    const plan: Plan = {
      id: randomUUID(), sessionId: request.sessionId, task: request.task, mode, family, service: resolved.service, skill, tools,
      schemaBytes: selectedBytes, fullSchemaBytes, savedPercent: Math.round((1 - selectedBytes / fullSchemaBytes) * 1000) / 10,
      resolvedEntities: [{ alias: resolved.alias.label, canonicalId: resolved.service.id, resourceId: resolved.service.resourceId }], receipt,
      abstained: tools.length === 0, reason,
    };
    await this.state.savePlan(plan);
    return plan;
  }
}
