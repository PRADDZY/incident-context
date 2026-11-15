import type { GraphEdge, GraphNode, Json, QueryReceipt, Service, Skill, ToolDefinition } from '../shared/contracts.ts';
import { SERVICES, SKILLS, TOOLS } from './catalog.ts';
import { HydraClient } from './hydra.ts';
import { ApiError } from './errors.ts';

export const EDGE_TYPES = ['RESOLVES_TO', 'USES_RESOURCE', 'SELECTS', 'REQUIRES', 'HOSTED_BY'] as const;
export interface GraphSnapshot {
  nodes: GraphNode[]; edges: GraphEdge[]; services: Service[]; skills: Skill[]; tools: ToolDefinition[];
  data: Map<number, unknown>; queries: QueryReceipt[]; graphVersion: number;
}
interface SeedNode extends GraphNode { data: string }

function seedGraph(services = SERVICES): { nodes: SeedNode[]; edges: GraphEdge[] } {
  const nodes: SeedNode[] = [], edges: GraphEdge[] = [];
  const add = (id: number, key: string, kind: GraphNode['kind'], label: string, data: unknown) => { const node = { id, key, kind, label, data: JSON.stringify(data) }; nodes.push(node); return id; };
  const edge = (from: number, to: number, type: string) => edges.push({ from, to, type, label: type.toLowerCase().replaceAll('_', ' ') });
  let aliasId = 100300;
  services.forEach((service, index) => {
    const serviceNode = add(100100 + index, service.id, 'service', service.name, service);
    const resource = add(100200 + index, service.resourceId, 'resource', service.resourceId, { id: service.resourceId, serviceId: service.id, environment: service.environment, providerComponentId: service.providerComponentId, providerComponentName: service.providerComponentName, providerComponentSource: service.providerComponentSource });
    edge(serviceNode, resource, 'USES_RESOURCE');
    [...new Set([service.id, service.name.toLowerCase(), ...service.aliases])].forEach(alias => {
      edge(add(aliasId++, `alias:${alias}`, 'alias', alias, { alias }), serviceNode, 'RESOLVES_TO');
    });
  });
  const serverIds = { 'incident-sandbox': 100700, 'cloudflare-status': 100701 };
  Object.entries(serverIds).forEach(([name, id]) => add(id, name, 'server', name, { name }));
  const toolIds = new Map(TOOLS.map((tool, index) => [tool.name, add(100600 + index, tool.id, 'tool', tool.name, tool)]));
  TOOLS.forEach(tool => {
    edge(toolIds.get(tool.name)!, serverIds[tool.server as keyof typeof serverIds], 'HOSTED_BY');
    tool.requires.forEach(name => edge(toolIds.get(tool.name)!, toolIds.get(name)!, 'REQUIRES'));
  });
  SKILLS.forEach((skill, index) => {
    const id = add(100500 + index, skill.id, 'skill', skill.name, skill);
    skill.tools.forEach(name => edge(id, toolIds.get(name)!, 'SELECTS'));
  });
  return { nodes, edges };
}

const fields = 'id, key, kind, label, data'.split(', ');
const project = (variable: string, prefix = '') => fields.map(f => `${variable}.${f} AS ${prefix}${f}`).join(', ');
const graphNode = (row: Record<string, Json>, prefix = ''): GraphNode => ({ id: Number(row[`${prefix}id`]), key: String(row[`${prefix}key`]), kind: row[`${prefix}kind`] as GraphNode['kind'], label: String(row[`${prefix}label`]) });
const parseData = <T>(row: Record<string, Json>, prefix = ''): T => {
  try { return JSON.parse(String(row[`${prefix}data`])) as T; }
  catch { throw new ApiError(503, 'Graph contains invalid entity metadata'); }
};

export class GraphRepository {
  constructor(public engine: HydraClient) {}
  async seed(): Promise<void> {
    const providerComponentSource = 'https://www.cloudflarestatus.com/api/v2/components.json';
    let component: { id: string; name: string } | undefined;
    try {
      const response = await fetch(providerComponentSource, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const payload = await response.json() as { components: { id: string; name: string }[] };
        component = payload.components.find(c => c.name === 'Workers');
      }
    } catch { /* Deployment sandbox remains usable; provider plans explicitly abstain without a resolved component. */ }
    const services = SERVICES.map(service => ({ ...service, latestDeploymentId: `dep-${service.id}-20261115`, ...(component ? { providerComponentId: component.id, providerComponentName: component.name, providerComponentSource } : {}) }));
    const graph = seedGraph(services);
    for (const edge of graph.edges) {
      await this.engine.query(`MERGE (a:ICEntity {id:$src})-[:${edge.type}]->(b:ICEntity {id:$dst})`, { src: edge.from, dst: edge.to });
    }
    for (const node of graph.nodes) {
      await this.engine.query('MATCH (n:ICEntity {id:$id}) SET n.key=$key, n.kind=$kind, n.label=$label, n.data=$data', { id: node.id, key: node.key, kind: node.kind, label: node.label, data: node.data });
    }
    const version = await this.engine.query('MATCH (n:ICEntity {id:$id}) RETURN n.graphVersion AS version LIMIT 1', { id: 100700 });
    if (version.rows[0]?.version === null || version.rows[0]?.version === undefined) await this.engine.query('MATCH (n:ICEntity {id:$id}) SET n.graphVersion=$version', { id: 100700, version: 1 });
  }

  async snapshot(): Promise<GraphSnapshot> {
    const result = await this.engine.query(`MATCH (n:ICEntity) RETURN ${project('n')} LIMIT 300`);
    const nodes = result.rows.map(row => graphNode(row));
    const data = new Map(result.rows.map(row => [Number(row.id), parseData<unknown>(row)]));
    const queries = [result.receipt];
    const edges: GraphEdge[] = [];
    for (const type of EDGE_TYPES) {
      const found = await this.engine.query(`MATCH (a:ICEntity)-[:${type}]->(b:ICEntity) RETURN a.id AS src, b.id AS dst LIMIT 500`);
      queries.push(found.receipt);
      for (const row of found.rows) edges.push({ from: Number(row.src), to: Number(row.dst), type, label: type.toLowerCase().replaceAll('_', ' ') });
    }
    const entities = <T>(kind: GraphNode['kind']) => nodes.filter(n => n.kind === kind).map(n => data.get(n.id) as T);
    const version = await this.engine.query('MATCH (n:ICEntity {id:$id}) RETURN n.graphVersion AS version LIMIT 1', { id: 100700 });
    queries.push(version.receipt);
    return { nodes, edges, data, services: entities<Service>('service'), tools: entities<ToolDefinition>('tool'), skills: entities<Skill>('skill'), queries, graphVersion: Number(version.rows[0]?.version ?? 1) };
  }

  async resolve(task: string, snapshot: GraphSnapshot) {
    const text = task.toLowerCase();
    const aliases = snapshot.nodes.filter(n => n.kind === 'alias').sort((a, b) => b.label.length - a.label.length || a.id - b.id);
    const alias = aliases.find(n => new RegExp(`(^|[^a-z0-9])${n.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i').test(text));
    if (!alias) throw new ApiError(422, 'No known service alias found in the task');
    const found = await this.engine.query(`MATCH (a:ICEntity {id:$id})-[:RESOLVES_TO*1..1]->(s:ICEntity) RETURN ${project('s')} LIMIT 2`, { id: alias.id });
    if (found.rows.length !== 1) throw new ApiError(422, 'Service alias has no unique graph resolution');
    const service = parseData<Service>(found.rows[0]);
    const serviceNode = graphNode(found.rows[0]);
    const resource = await this.engine.query(`MATCH (s:ICEntity {id:$id})-[:USES_RESOURCE*1..1]->(r:ICEntity) RETURN ${project('r')} LIMIT 2`, { id: serviceNode.id });
    if (resource.rows.length !== 1) throw new ApiError(422, 'Service has no unique graph resource');
    const resourceData = parseData<{ id: string; serviceId: string }>(resource.rows[0]);
    if (resourceData.serviceId !== service.id || resourceData.id !== service.resourceId) throw new ApiError(503, 'Graph service/resource metadata disagree');
    return { alias, service, nodes: [alias, serviceNode, graphNode(resource.rows[0])], queries: [found.receipt, resource.receipt] };
  }

  async bundle(skill: Skill, snapshot: GraphSnapshot) {
    const skillNode = snapshot.nodes.find(n => n.kind === 'skill' && n.key === skill.id);
    if (!skillNode) throw new ApiError(503, 'Selected skill is absent from the graph');
    const direct = await this.engine.query(`MATCH (s:ICEntity {id:$id})-[:SELECTS*1..1]->(t:ICEntity) RETURN ${project('t')} LIMIT 30`, { id: skillNode.id });
    const prerequisites = await this.engine.query(`MATCH (s:ICEntity {id:$id})-[:SELECTS]->(t:ICEntity)-[:REQUIRES*1..4]->(p:ICEntity) RETURN ${project('p')} LIMIT 60`, { id: skillNode.id });
    const rows = [...direct.rows, ...prerequisites.rows];
    const ids = new Set(rows.map(r => Number(r.id)));
    const tools = snapshot.tools.filter(t => snapshot.nodes.some(n => n.kind === 'tool' && n.key === t.id && ids.has(n.id)));
    const complete = skill.tools.every(name => direct.rows.some(row => parseData<ToolDefinition>(row).name === name))
      && tools.every(t => t.requires.every(name => {
        const target = snapshot.nodes.find(n => n.kind === 'tool' && n.key === name);
        const source = snapshot.nodes.find(n => n.kind === 'tool' && n.key === t.id);
        return tools.some(p => p.name === name) && snapshot.edges.some(e => e.from === source?.id && e.to === target?.id && e.type === 'REQUIRES');
      }))
      && tools.every(t => {
        const node = snapshot.nodes.find(n => n.key === t.id && n.kind === 'tool');
        return snapshot.edges.some(e => e.from === node?.id && e.type === 'HOSTED_BY' && snapshot.nodes.some(n => n.id === e.to && n.key === t.server));
      });
    return { tools, complete, nodeIds: new Set([skillNode.id, ...ids]), queries: [direct.receipt, prerequisites.receipt] };
  }
}
