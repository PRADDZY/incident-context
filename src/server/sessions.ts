import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Family, Feedback, FeedbackResult, GraphEdge, GraphNode, GraphReceipt, Plan, QueryReceipt, Service, Skill, Weight } from '../shared/contracts.ts';
import { HydraClient } from './hydra.ts';
import { ApiError } from './errors.ts';

const ROOT = 100700;
const identity = (session: string) => {
  const hash = createHash('sha256').update(session).digest('hex');
  return { id: Number.parseInt(hash.slice(0, 12), 16) + 1_000_000_000, key: `session:${hash}`, label: `Session ${hash.slice(0, 8)}` };
};
export const initialWeights = (skills: Pick<Skill, 'id'>[]): Weight[] => (['deployment', 'provider'] as Family[]).flatMap(family => skills.map(skill => ({ family, skillId: skill.id, successes: 1, failures: 1, usefulness: 0.5 })));
interface SessionData { weights: Weight[]; applied: Record<string, FeedbackResult> }
export interface GraphSession { weights: Weight[]; graphVersion: number; nodes: GraphNode[]; edges: GraphEdge[]; queries: QueryReceipt[]; data: SessionData }

export class GraphSessions {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private engine: HydraClient) {}
  private serialize<T>(operation: () => Promise<T>) {
    const work = this.queue.then(operation);
    this.queue = work.catch(() => undefined);
    return work;
  }

  async read(sessionId: string, skills: Pick<Skill, 'id'>[]): Promise<GraphSession> {
    const node = identity(sessionId);
    const found = await this.engine.query('MATCH (r:ICEntity {id:$root})-[:HAS_SESSION]->(s:ICSession {id:$id}) RETURN s.id AS id, s.key AS key, s.kind AS kind, s.label AS label, s.data AS data LIMIT 1', { root: ROOT, id: node.id });
    const version = await this.engine.query('MATCH (r:ICEntity {id:$root}) RETURN r.graphVersion AS version LIMIT 1', { root: ROOT });
    const graphVersion = Number(version.rows[0]?.version ?? 1);
    if (!found.rows.length) return { weights: initialWeights(skills), graphVersion, nodes: [], edges: [], queries: [found.receipt, version.receipt], data: { weights: initialWeights(skills), applied: {} } };
    if (found.rows[0].key !== node.key) throw new ApiError(503, 'Session graph identity collision');
    let data: SessionData;
    try { data = JSON.parse(String(found.rows[0].data)) as SessionData; }
    catch { throw new ApiError(503, 'Invalid session graph metadata'); }
    if (!data || !Array.isArray(data.weights) || !data.applied || data.weights.some(w => !Number.isInteger(w.successes) || !Number.isInteger(w.failures) || w.successes < 1 || w.failures < 1)) throw new ApiError(503, 'Invalid graph Beta counts');
    const memories = await this.engine.query('MATCH (s:ICSession {id:$id})-[:REMEMBERS_SERVICE]->(n:ICEntity) RETURN n.id AS id, n.key AS key, n.kind AS kind, n.label AS label LIMIT 20', { id: node.id });
    const nodes: GraphNode[] = [{ ...node, kind: 'session' }, ...memories.rows.map(r => ({ id: Number(r.id), key: String(r.key), kind: r.kind as GraphNode['kind'], label: String(r.label) }))];
    const edges: GraphEdge[] = [{ from: ROOT, to: node.id, type: 'HAS_SESSION', label: 'has session' }, ...memories.rows.map(r => ({ from: node.id, to: Number(r.id), type: 'REMEMBERS_SERVICE', label: 'remembers service' }))];
    return { weights: data.weights.map(w => ({ ...w, usefulness: w.successes / (w.successes + w.failures) })), graphVersion, nodes, edges, queries: [found.receipt, version.receipt, memories.receipt], data };
  }

  remember(sessionId: string, service: Service, skills: Pick<Skill, 'id'>[]): Promise<GraphSession> {
    return this.serialize(async () => {
      const existing = await this.read(sessionId, skills), node = identity(sessionId);
      const serviceQuery = await this.engine.query('MATCH (n:ICEntity {key:$key}) RETURN n.id AS id LIMIT 1', { key: service.id });
      if (serviceQuery.rows.length !== 1) throw new ApiError(503, 'Canonical service is absent from HydraDB');
      const serviceId = Number(serviceQuery.rows[0].id), writes: QueryReceipt[] = [];
      if (!existing.nodes.length) {
        writes.push((await this.engine.query('MERGE (r:ICEntity {id:$root})-[:HAS_SESSION]->(s:ICSession {id:$id})', { root: ROOT, id: node.id })).receipt);
        writes.push((await this.engine.query('MATCH (s:ICSession {id:$id}) SET s.key=$key, s.kind=$kind, s.label=$label, s.data=$data', { ...node, kind: 'session', data: JSON.stringify(existing.data) })).receipt);
      }
      if (!existing.edges.some(e => e.type === 'REMEMBERS_SERVICE' && e.to === serviceId)) {
        writes.push((await this.engine.query('MERGE (s:ICSession {id:$id})-[:REMEMBERS_SERVICE]->(n:ICEntity {id:$service})', { id: node.id, service: serviceId })).receipt);
        writes.push((await this.engine.query('MATCH (r:ICEntity {id:$root}) SET r.graphVersion=$version', { root: ROOT, version: existing.graphVersion + 1 })).receipt);
      }
      const verified = await this.read(sessionId, skills);
      verified.queries = [...existing.queries, serviceQuery.receipt, ...writes, ...verified.queries];
      return verified;
    });
  }

  feedback(input: Feedback, plan: Plan, skills: Pick<Skill, 'id'>[]): Promise<FeedbackResult> {
    return this.serialize(async () => {
      if (!plan.skill) throw new ApiError(422, 'Run has no selected skill');
      const start = performance.now(), current = await this.read(input.sessionId, skills);
      if (current.data.applied[input.runId]) {
        const applied = current.data.applied[input.runId];
        if (current.graphVersion < applied.graphVersion) await this.engine.query('MATCH (r:ICEntity {id:$root}) SET r.graphVersion=$version', { root: ROOT, version: applied.graphVersion });
        return applied;
      }
      if (!current.nodes.length) throw new ApiError(503, 'Session context must be stored in HydraDB before feedback');
      const weight = current.weights.find(w => w.skillId === plan.skill!.id && w.family === plan.family);
      if (!weight) throw new ApiError(503, 'Graph skill weight is missing');
      const before = structuredClone(weight);
      if (input.correct) weight.successes++; else weight.failures++;
      weight.usefulness = weight.successes / (weight.successes + weight.failures);
      const graphVersion = current.graphVersion + 1;
      const result: FeedbackResult = { before, after: structuredClone(weight), graphVersion, recordedAt: new Date().toISOString() };
      const nextData: SessionData = { weights: current.weights, applied: { ...current.data.applied, [input.runId]: result } };
      const written = await this.engine.query('MATCH (s:ICSession {id:$id}) SET s.data=$data', { id: identity(input.sessionId).id, data: JSON.stringify(nextData) });
      const version = await this.engine.query('MATCH (r:ICEntity {id:$root}) SET r.graphVersion=$version', { root: ROOT, version: graphVersion });
      const verified = await this.read(input.sessionId, skills);
      const receipt: GraphReceipt = { engine: 'HydraDB', engineVersion: '0.4.0', queries: [...current.queries, written.receipt, version.receipt, ...verified.queries], nodes: verified.nodes, edges: verified.edges, graphVersion: verified.graphVersion, durationMs: Math.round(performance.now() - start) };
      return { ...result, receipt };
    });
  }
}
