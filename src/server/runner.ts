import { performance } from 'node:perf_hooks';
import type { Json, Observation, Plan, ToolCall, ToolDefinition } from '../shared/contracts.ts';
import { SERVICES } from './catalog.ts';
import { message } from './errors.ts';

const COMPONENTS = 'https://www.cloudflarestatus.com/api/v2/components.json';
const INCIDENTS = 'https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json';
export type StatusSource = (url: string) => Promise<unknown>;
const readStatus: StatusSource = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Cloudflare status endpoint unavailable (${response.status})`);
  return response.json();
};
const asRecord = (value: Json) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {};

function validate(definition: ToolDefinition, args: Record<string, Json>, plan: Plan) {
  if (Object.keys(args).some(key => !Object.hasOwn(definition.parameters.properties, key))) throw new Error('Unexpected tool argument');
  for (const key of definition.parameters.required) {
    const value = args[key], schema = definition.parameters.properties[key] as Record<string, Json>;
    if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new Error(`Invalid or missing ${key}`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`Unsupported ${key}`);
  }
  if (args.serviceId !== undefined && args.serviceId !== plan.service.id) throw new Error('serviceId does not match the graph-resolved service');
  if (args.resourceId !== undefined && args.resourceId !== plan.service.resourceId) throw new Error('resourceId does not belong to the graph-resolved service');
}

export class ToolRunner {
  constructor(private statusSource: StatusSource = readStatus, private timeoutMs = 5000) {}

  async execute(plan: Plan, call: ToolCall): Promise<Observation> {
    const start = performance.now(), observedAt = new Date().toISOString();
    const definition = plan.tools.find(t => t.name === call.name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!definition) throw new Error('Tool was not selected in this plan');
      validate(definition, call.arguments, plan);
      const result = await Promise.race([
        this.handle(plan, call),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Tool observation timed out')), this.timeoutMs); }),
      ]);
      return { tool: call.name, source: definition.source, ok: true, result, error: null, durationMs: Math.round(performance.now() - start), observedAt };
    } catch (error) {
      return { tool: call.name, source: definition?.source ?? 'sandbox', ok: false, result: null, error: message(error), durationMs: Math.round(performance.now() - start), observedAt };
    } finally { if (timer) clearTimeout(timer); }
  }

  private async handle(plan: Plan, call: ToolCall): Promise<Json> {
    const { service } = plan, args = call.arguments;
    if (call.name.startsWith('provider_') || call.name === 'component_status') {
      if (call.name === 'provider_incidents') {
        const data = await this.statusSource(INCIDENTS) as { incidents?: { id: string; name: string; status: string; updated_at: string; components?: { id: string; name: string; status: string }[]; shortlink?: string }[] };
        if (!Array.isArray(data.incidents)) throw new Error('Invalid Cloudflare incident response');
        return { provider: 'cloudflare', sourceUrl: INCIDENTS, incidents: data.incidents.map(i => ({ id: i.id, name: i.name, status: i.status, updatedAt: i.updated_at, componentIds: (i.components ?? []).map(c => c.id), url: i.shortlink ?? null })), boundary: 'Provider-reported unresolved incidents; this does not establish the health of our application.' };
      }
      const data = await this.statusSource(COMPONENTS) as { components?: { id: string; name: string; status: string; updated_at?: string }[] };
      if (!Array.isArray(data.components)) throw new Error('Invalid Cloudflare component response');
      if (call.name === 'provider_components') {
        const target = data.components.find(c => c.id === service.providerComponentId);
        return { provider: 'cloudflare', sourceUrl: COMPONENTS, totalComponents: data.components.length, components: (target ? [target] : data.components.slice(0, 30)).map(c => ({ id: c.id, name: c.name, status: c.status })), scope: target ? 'Component associated with the graph-resolved resource' : 'First 30 directory entries; no component is resolved for this service' };
      }
      if (args.componentId !== service.providerComponentId) throw new Error('componentId does not match the graph-resolved provider resource');
      const component = data.components.find(c => c.id === args.componentId);
      if (!component) throw new Error('Provider component ID is absent from the current live directory');
      return { provider: 'cloudflare', sourceUrl: COMPONENTS, componentId: component.id, name: component.name, status: component.status, updatedAt: component.updated_at ?? null, boundary: 'Provider status only; not a diagnosis of this application.' };
    }
    const index = SERVICES.findIndex(s => s.id === service.id);
    if (index < 0) throw new Error('No sandbox fixture exists for this service');
    const fixture = { serviceId: service.id, resourceId: service.resourceId, simulated: true };
    const latest = service.latestDeploymentId;
    const previous = `dep-${service.id}-20261114`;
    const changedAt = '2026-11-15T12:00:00Z';
    switch (call.name) {
      case 'service_resolve': {
        const query = String(args.query).toLowerCase();
        if (![service.id, service.name.toLowerCase(), ...service.aliases].includes(query)) throw new Error('Alias does not match the graph-resolved service');
        return { ...fixture, name: service.name, environment: service.environment, providerComponentId: service.providerComponentId ?? null };
      }
      case 'service_metrics': return { ...fixture, window: { from: changedAt, to: '2026-11-15T12:15:00Z' }, errorRate: [0.074, 0.061, 0.083, 0.056][index], baselineErrorRate: 0.002, p95Ms: [940, 810, 1120, 760][index], baselineP95Ms: 140, regressionStartedAt: changedAt };
      case 'service_logs': return { ...fixture, entries: [{ at: '2026-11-15T12:03:42Z', level: 'error', message: 'Upstream retry budget exhausted', correlationId: `${service.id}-req-017` }, { at: '2026-11-15T12:04:01Z', level: 'error', message: 'Request failed after rollout', correlationId: `${service.id}-req-029` }] };
      case 'deployments_list':
        if (!latest) throw new Error('Latest sandbox deployment metadata is absent from the graph');
        return { ...fixture, deployments: [{ deploymentId: latest, version: `2026.11.15.${index + 1}`, changedAt }, { deploymentId: previous, version: `2026.11.14.${index + 1}`, changedAt: '2026-11-14T09:00:00Z' }] };
      case 'deployment_details':
        if (!latest || ![latest, previous].includes(String(args.deploymentId))) throw new Error('Unknown deployment ID; use the graph metadata or deployment list');
        return { ...fixture, deploymentId: String(args.deploymentId), version: args.deploymentId === latest ? `2026.11.15.${index + 1}` : `2026.11.14.${index + 1}`, changedAt: args.deploymentId === latest ? changedAt : '2026-11-14T09:00:00Z', changedConfig: args.deploymentId === latest ? { upstreamRetryBudget: 0, previousUpstreamRetryBudget: 3 } : { upstreamRetryBudget: 3 }, rollbackTarget: previous, knownRegression: args.deploymentId === latest };
      case 'runbook_read': return { ...fixture, steps: ['Compare error metrics before and after the latest rollout.', 'Inspect exact deployment details and changed configuration.', 'Confirm rollback target and obtain operator authorization before any write.'], readOnly: true };
      case 'owner_lookup': return { ...fixture, team: ['Commerce Reliability', 'Dispatch Platform', 'Search Experience', 'Ledger Operations'][index], escalation: 'Sandbox directory only; no notification sent.' };
      case 'dependencies_read': return { ...fixture, dependencies: [{ provider: 'cloudflare', component: 'Workers', componentId: service.providerComponentId ?? null }], boundary: 'Configured dependency, not a current health assertion.' };
      case 'incident_history': return { ...fixture, incidents: [{ id: `hist-${service.id}-retry`, resolvedAt: '2026-10-21T14:30:00Z', summary: 'A prior retry configuration regression was resolved by rollback.' }], historical: true };
      default: throw new Error('No handler exists for the selected tool');
    }
  }
}

export function assessObservations(plan: Plan, observations: Observation[]): { success: boolean; answer: string; reason: string | null } {
  const successful = (tool: string) => observations.filter(o => o.tool === tool && o.ok).map(o => asRecord(o.result));
  if (plan.family === 'deployment') {
    const metrics = successful('service_metrics').find(m => m.serviceId === plan.service.id && m.resourceId === plan.service.resourceId && Number(m.errorRate) > Number(m.baselineErrorRate));
    const deployment = successful('deployment_details').find(d => d.serviceId === plan.service.id && d.deploymentId === plan.service.latestDeploymentId && d.knownRegression === true && metrics?.regressionStartedAt === d.changedAt);
    if (metrics && deployment) return { success: true, answer: `Observed sandbox diagnosis: ${plan.service.name} errors rose to ${(Number(metrics.errorRate) * 100).toFixed(1)}% after deployment ${deployment.deploymentId} at ${deployment.changedAt}. The fixture shows the retry budget changed from 3 to 0. Rollback candidate: ${deployment.rollbackTarget}. This is a simulated incident, and no change was executed.`, reason: null };
    return { success: false, answer: 'Insufficient verified sandbox observations to connect this service regression to the current deployment.', reason: 'Requires successful service metrics and matching current deployment details; selected schemas alone are not evidence.' };
  }
  const component = successful('component_status').find(c => c.componentId === plan.service.providerComponentId && typeof c.status === 'string');
  const incidents = successful('provider_incidents').find(i => Array.isArray(i.incidents));
  if (component && incidents) return { success: true, answer: `Live provider observation: Cloudflare reports ${component.name} as ${component.status}. ${((incidents.incidents as Json[]) ?? []).length} unresolved provider incident(s) were returned. These are provider-reported observations at the recorded timestamps; they do not establish the health or cause of failures in ${plan.service.name}.`, reason: null };
  return { success: false, answer: 'Insufficient live provider observations: current component status and unresolved incidents are both required.', reason: 'Provider failure, missing observations or an invalid component ID must remain unresolved.' };
}
