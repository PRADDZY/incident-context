import type { Json, Scenario, Service, Skill, ToolDefinition } from '../shared/contracts.ts';

export const SERVICES: Service[] = [
  { id: 'northstar-checkout', name: 'Northstar Checkout', aliases: ['checkout', 'payments', 'northstar'], resourceId: 'res-northstar-checkout-prod', environment: 'sandbox-production' },
  { id: 'cedar-dispatch', name: 'Cedar Dispatch', aliases: ['dispatch', 'routing', 'cedar'], resourceId: 'res-cedar-dispatch-prod', environment: 'sandbox-production' },
  { id: 'juniper-search', name: 'Juniper Search', aliases: ['search', 'discovery', 'juniper'], resourceId: 'res-juniper-search-prod', environment: 'sandbox-production' },
  { id: 'harbor-ledger', name: 'Harbor Ledger', aliases: ['ledger', 'billing', 'harbor'], resourceId: 'res-harbor-ledger-prod', environment: 'sandbox-production' },
];

const string = (description: string): Json => ({ type: 'string', minLength: 1, maxLength: 160, description });
const serviceId = string('Canonical service ID resolved in the plan. Use this ID exactly; display aliases are not accepted.');
const resourceId = string('Canonical production resource ID from the resolved plan. Must belong to the service.');
const provider: Json = { type: 'string', enum: ['cloudflare'], description: 'Read-only public status provider. Status does not diagnose this application infrastructure.' };
function tool(name: string, description: string, properties: Record<string, Json>, requires: string[] = [], live = false): ToolDefinition {
  return { id: name, name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, source: live ? 'live' : 'sandbox', requires, server: live ? 'cloudflare-status' : 'incident-sandbox' };
}

export const TOOLS: ToolDefinition[] = [
  tool('service_resolve', 'Resolve a service alias to its canonical service and resource identifiers. Sandbox service inventory; compare the result with the graph-resolved plan before diagnostics.', { query: string('Service name, alias or canonical ID to resolve.') }),
  tool('service_metrics', 'Read sandbox incident metrics: request error rate, p95 latency, observation window and baseline. These simulated measurements reveal a regression but cannot identify the deployment responsible.', { serviceId, resourceId }, ['service_resolve']),
  tool('service_logs', 'Read a bounded sample of simulated service error logs with timestamps, request categories and correlation IDs. Logs are sandbox fixtures, not a live production logging integration.', { serviceId, resourceId }, ['service_resolve']),
  tool('deployments_list', 'List the latest and previous sandbox deployments for a canonical service, including immutable deployment IDs and rollout timestamps. Read this before requesting deployment details.', { serviceId }, ['service_resolve']),
  tool('deployment_details', 'Inspect a specific sandbox deployment: version, rollout time, changed configuration and rollback target. Requires a deployment ID returned by deployments_list; never invent a deployment ID.', { serviceId, deploymentId: string('Exact immutable deployment ID returned by deployments_list.') }, ['deployments_list']),
  tool('runbook_read', 'Read the sandbox operational runbook for a service, including investigation steps and rollback safeguards. A runbook supplies procedure rather than evidence of the current failure cause.', { serviceId }, ['service_resolve']),
  tool('owner_lookup', 'Find the sandbox service owner and escalation route. This read-only directory lookup does not contact anyone or trigger an escalation.', { serviceId }, ['service_resolve']),
  tool('provider_components', 'Read the live Cloudflare status component directory from the fixed public status endpoint. Returns component IDs and current status; this is provider-reported evidence only.', { provider }, [], true),
  tool('provider_incidents', 'Read unresolved incidents reported by the live Cloudflare public status API, with provider incident IDs and affected component IDs. An empty list means no unresolved provider-reported incident at observation time.', { provider }, ['provider_components'], true),
  tool('component_status', 'Read the current live status of one Cloudflare component using an exact ID from provider_components. The result identifies provider-reported availability, not the health of this application.', { provider, componentId: string('Exact component ID returned by provider_components; never use a component name as its ID.') }, ['provider_components'], true),
  tool('dependencies_read', 'Read the sandbox upstream dependency map for a canonical service, including expected providers and operational boundaries. Dependency configuration is not a real-time health measurement.', { serviceId }, ['service_resolve']),
  tool('incident_history', 'Read the bounded sandbox history of resolved incidents for a service. Historical similarity is contextual evidence and must not be presented as a current diagnosis.', { serviceId }, ['service_resolve']),
];

export const SKILLS: Skill[] = [
  { id: 'telemetry', name: 'Service telemetry', description: 'Diagnose service errors, latency and availability. Inspect metrics logs runbook and ownership for general troubleshooting.', family: 'deployment', tools: ['service_metrics', 'service_logs', 'runbook_read', 'owner_lookup'] },
  { id: 'release-investigation', name: 'Release investigation', description: 'Investigate deployment rollout version regression change release rollback. Correlate metrics with deployment list and deployment details.', family: 'deployment', tools: ['service_metrics', 'deployment_details'] },
  { id: 'provider-investigation', name: 'Provider investigation', description: 'Investigate Cloudflare provider upstream component outage incident status disruption. Read component directory, current component status and unresolved incidents.', family: 'provider', tools: ['component_status', 'provider_incidents'] },
];

export const SCENARIOS: Scenario[] = [
  { id: 'checkout-release', title: 'Checkout rollout regression', task: 'Investigate the checkout deployment regression: compare error metrics with the latest deployment details and identify the rollback target.', family: 'deployment', source: 'sandbox' },
  { id: 'dispatch-telemetry', title: 'Dispatch error investigation', task: 'Diagnose dispatch errors and identify the release change using metrics and deployment details.', family: 'deployment', source: 'sandbox' },
  { id: 'search-provider', title: 'Search provider observation', task: 'Investigate whether Cloudflare has an active provider incident affecting search. Read current component status and unresolved incidents; distinguish provider reports from our sandbox service.', family: 'provider', source: 'live' },
];

export function schemaBytes(tools: ToolDefinition[]): number { return Buffer.byteLength(JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))), 'utf8'); }
export function prerequisiteClosure(names: string[], tools: ToolDefinition[]): ToolDefinition[] {
  const selected = new Set<string>();
  const visit = (name: string) => {
    if (selected.has(name)) return;
    const definition = tools.find(t => t.name === name);
    if (!definition) throw new Error(`Unknown prerequisite: ${name}`);
    selected.add(name); definition.requires.forEach(visit);
  };
  names.forEach(visit);
  return tools.filter(t => selected.has(t.name));
}
