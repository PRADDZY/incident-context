import assert from 'node:assert/strict';
import test from 'node:test';
import type { Plan, Observation, ToolDefinition } from '../src/shared/contracts.ts';
import { DATASET, DATASET_SHA256, HELDOUT_TASKS, TRAINING_TASKS, assertDatasetLocked } from './dataset.ts';
import { gradeCoverage, gradeObservations, fixedWorkflowCalls, summarize } from './grade.ts';

const deployment = HELDOUT_TASKS.find(task => task.id === 'heldout-d01')!;
const provider = HELDOUT_TASKS.find(task => task.id === 'heldout-p02')!;
const tool = (name: string): ToolDefinition => ({ id: name, name, description: 'é', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, source: 'sandbox', requires: [], server: 'test' });
const plan = (names: string[], family: 'deployment' | 'provider' = 'deployment'): Plan => ({
  id: 'plan', sessionId: 'test', task: deployment.task, family, mode: 'all', skill: null,
  service: { id: 'juniper-search', name: 'Juniper Search', aliases: ['search'], resourceId: 'res-juniper-search-prod', environment: 'sandbox-production', latestDeploymentId: 'dep-juniper-search-20261115', providerComponentId: 'from-live-directory', providerComponentName: 'Workers' },
  tools: names.map(tool), schemaBytes: -1, fullSchemaBytes: 0, savedPercent: 0, resolvedEntities: [],
  receipt: { engine: 'HydraDB', engineVersion: '0.4.0', queries: [], nodes: [], edges: [], durationMs: 0, graphVersion: 1 }, abstained: false, reason: null,
});
const observed = (name: string, result: Observation['result'], source: Observation['source'] = 'sandbox'): Observation => ({ tool: name, result, source, ok: true, error: null, durationMs: 1, observedAt: '2026-11-15T16:00:00Z' });
const validDeployment = (): Observation[] => [
  observed('service_metrics', { serviceId: 'juniper-search', resourceId: 'res-juniper-search-prod', simulated: true, errorRate: 0.083, baselineErrorRate: 0.002, regressionStartedAt: '2026-11-15T12:00:00Z' }),
  observed('deployment_details', { serviceId: 'juniper-search', resourceId: 'res-juniper-search-prod', simulated: true, deploymentId: 'dep-juniper-search-20261115', changedAt: '2026-11-15T12:00:00Z', changedConfig: { upstreamRetryBudget: 0, previousUpstreamRetryBudget: 3 }, rollbackTarget: 'dep-juniper-search-20261114', knownRegression: true }),
];

test('locked dataset is balanced, disjoint by service identity and aliases, with ten preselected live tasks', async () => {
  await assertDatasetLocked();
  assert.match(DATASET_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(TRAINING_TASKS.length, 40); assert.equal(HELDOUT_TASKS.length, 20);
  for (const tasks of [TRAINING_TASKS, HELDOUT_TASKS]) for (const family of ['deployment', 'provider']) assert.equal(tasks.filter(task => task.family === family).length, tasks.length / 2);
  const trainIds = new Set(TRAINING_TASKS.map(task => task.serviceId));
  for (const task of HELDOUT_TASKS) assert.ok(!trainIds.has(task.serviceId));
  const trainAliases = new Set([...trainIds].flatMap(id => [DATASET.services[id].name.toLowerCase(), ...DATASET.services[id].aliases]));
  for (const id of new Set(HELDOUT_TASKS.map(task => task.serviceId))) for (const alias of [DATASET.services[id].name.toLowerCase(), ...DATASET.services[id].aliases]) assert.ok(!trainAliases.has(alias));
  assert.equal(new Set([...TRAINING_TASKS, ...HELDOUT_TASKS].map(task => task.task)).size, 60);
  assert.equal(DATASET.liveTaskIds.length, 10);
  assert.ok(DATASET.liveTaskIds.every(id => HELDOUT_TASKS.some(task => task.id === id)));
  assert.equal(HELDOUT_TASKS.filter(task => DATASET.liveTaskIds.includes(task.id) && task.family === 'deployment').length, 5);
});

test('schema coverage fails when a prerequisite is absent even if both diagnostic tools exist', () => {
  const coverage = gradeCoverage(deployment, plan(['service_resolve', 'service_metrics', 'deployment_details']));
  assert.equal(coverage.completePrerequisites, false);
  assert.deepEqual(coverage.missingTools, ['deployments_list']);
});

test('coverage counts unrelated full-catalog schemas and measures actual UTF-8 bytes', () => {
  const bundle = plan(['service_resolve', 'service_metrics', 'deployments_list', 'deployment_details', 'service_logs', 'owner_lookup']);
  const coverage = gradeCoverage(deployment, bundle);
  assert.equal(coverage.completePrerequisites, true); assert.equal(coverage.irrelevantTools, 2);
  const serialized = JSON.stringify(bundle.tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
  assert.equal(coverage.schemaBytes, Buffer.byteLength(serialized, 'utf8'));
  assert.ok(coverage.schemaBytes > serialized.length);
});

test('independent deployment observations require the correct service and resource', () => {
  assert.equal(gradeObservations(deployment, validDeployment()).success, true);
  const wrong = validDeployment(); (wrong[0].result as Record<string, unknown>).serviceId = 'northstar-checkout';
  assert.equal(gradeObservations(deployment, wrong).success, false);
  const wrongResource = validDeployment(); (wrongResource[1].result as Record<string, unknown>).resourceId = 'res-harbor-ledger-prod';
  assert.equal(gradeObservations(deployment, wrongResource).success, false);
});

test('deployment evidence cannot pass with an old deployment or incorrect retry configuration', () => {
  const wrong = validDeployment(); (wrong[1].result as Record<string, unknown>).deploymentId = 'dep-juniper-search-20261114';
  assert.equal(gradeObservations(deployment, wrong).success, false);
  const wrongConfig = validDeployment(); (wrongConfig[1].result as Record<string, unknown>).changedConfig = { upstreamRetryBudget: 3 };
  assert.equal(gradeObservations(deployment, wrongConfig).success, false);
  assert.equal(gradeObservations(deployment, [validDeployment()[0]]).success, false);
});

test('provider grading accepts any current status and incident count, requires fixed live sources and component identity', () => {
  const data = [
    observed('component_status', { provider: 'cloudflare', componentId: 'directory-id', name: 'Workers', status: 'degraded_performance', sourceUrl: 'https://www.cloudflarestatus.com/api/v2/components.json' }, 'live'),
    observed('provider_incidents', { provider: 'cloudflare', incidents: [], sourceUrl: 'https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json' }, 'live'),
  ];
  assert.equal(gradeObservations(provider, data).success, true);
  (data[0].result as Record<string, unknown>).status = 'operational';
  assert.equal(gradeObservations(provider, data).success, true);
  (data[0].result as Record<string, unknown>).name = 'Some Other Product';
  assert.equal(gradeObservations(provider, data).success, false);
  assert.equal(gradeObservations(provider, [data[1]]).success, false);
});

test('fixed workflow uses available tools and resolved IDs, never fabricates missing identifiers or repairs a wrong service', () => {
  const deploymentPlan = plan(['service_metrics', 'deployments_list', 'deployment_details', 'owner_lookup']);
  assert.deepEqual(fixedWorkflowCalls(deployment, deploymentPlan), [
    { name: 'service_metrics', arguments: { serviceId: 'juniper-search', resourceId: 'res-juniper-search-prod' } },
    { name: 'deployments_list', arguments: { serviceId: 'juniper-search' } },
    { name: 'deployment_details', arguments: { serviceId: 'juniper-search', deploymentId: 'dep-juniper-search-20261115' } },
  ]);
  deploymentPlan.service.id = 'wrong-service';
  assert.equal(fixedWorkflowCalls(deployment, deploymentPlan)[0].arguments.serviceId, 'wrong-service');
  delete deploymentPlan.service.latestDeploymentId;
  assert.ok(!fixedWorkflowCalls(deployment, deploymentPlan).some(call => call.name === 'deployment_details'));
  const providerPlan = plan(['provider_components', 'component_status', 'provider_incidents'], 'provider');
  assert.deepEqual(fixedWorkflowCalls(provider, providerPlan).map(call => call.name), ['provider_components', 'component_status', 'provider_incidents']);
  assert.equal(fixedWorkflowCalls(provider, providerPlan)[1].arguments.componentId, 'from-live-directory');
  assert.deepEqual(fixedWorkflowCalls(deployment, plan(['owner_lookup'])), []);
});

test('reported successes count actual executor success, coverage and independent grader stay separate', () => {
  const rows = [
    { mode: 'all' as const, schemaBytes: 900, planLatencyMs: 10, completePrerequisites: true, irrelevantTools: 8, executorSuccess: false, observationSuccess: true },
    { mode: 'all' as const, schemaBytes: 1100, planLatencyMs: 30, completePrerequisites: false, irrelevantTools: 7, executorSuccess: true, observationSuccess: false },
  ];
  assert.deepEqual(summarize('all', rows), { mode: 'all', tasks: 2, successes: 1, completePrerequisites: 1, meanSchemaBytes: 1000, irrelevantTools: 15, p50Ms: 10, p95Ms: 30 });
});
