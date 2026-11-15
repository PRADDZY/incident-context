import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRunner, assessObservations } from './runner.ts';
import { SERVICES, SKILLS, TOOLS } from './catalog.ts';
import type { Plan, ToolCall } from '../shared/contracts.ts';

const service = { ...SERVICES[0], latestDeploymentId: 'dep-northstar-checkout-20261115', providerComponentId: 'test-workers-component', providerComponentName: 'Workers' };
const plan = { service, family: 'deployment', skill: SKILLS[1], tools: TOOLS, abstained: false } as Plan;

test('sandbox diagnosis requires successful observations from metrics and the exact current deployment', async () => {
  const runner = new ToolRunner();
  const metrics = await runner.execute(plan, { name: 'service_metrics', arguments: { serviceId: service.id, resourceId: service.resourceId } });
  assert.equal(metrics.ok, true);
  assert.equal(metrics.source, 'sandbox');
  assert.equal(assessObservations(plan, [metrics]).success, false);
  const wrong = await runner.execute(plan, { name: 'deployment_details', arguments: { serviceId: service.id, deploymentId: 'invented-release' } });
  assert.equal(wrong.ok, false);
  const details = await runner.execute(plan, { name: 'deployment_details', arguments: { serviceId: service.id, deploymentId: service.latestDeploymentId } });
  assert.equal(assessObservations(plan, [metrics, details]).success, true);
  assert.match(details.observedAt, /^\d{4}-/);
});

test('unselected tools, cross-service resource IDs and unexpected arguments remain failed calls', async () => {
  const runner = new ToolRunner();
  const narrow = { ...plan, tools: TOOLS.filter(t => t.name === 'service_metrics') };
  const cases: ToolCall[] = [
    { name: 'service_logs', arguments: { serviceId: service.id, resourceId: service.resourceId } },
    { name: 'service_metrics', arguments: { serviceId: service.id, resourceId: SERVICES[1].resourceId } },
    { name: 'service_metrics', arguments: { serviceId: service.id, resourceId: service.resourceId, repair: true } },
  ];
  for (const call of cases) assert.equal((await runner.execute(narrow, call)).ok, false);
});

test('provider status uses only the fixed endpoints and verifies the component ID without repairing arguments', async () => {
  const urls: string[] = [];
  const runner = new ToolRunner(async url => {
    urls.push(url);
    return url.endsWith('components.json')
      ? { components: [{ id: 'test-workers-component', name: 'Workers', status: 'operational' }] }
      : { incidents: [] };
  });
  const provider = { ...plan, family: 'provider' as const };
  const invalid = await runner.execute(provider, { name: 'component_status', arguments: { provider: 'cloudflare', componentId: 'made-up' } });
  assert.equal(invalid.ok, false);
  const component = await runner.execute(provider, { name: 'component_status', arguments: { provider: 'cloudflare', componentId: 'test-workers-component' } });
  const incidents = await runner.execute(provider, { name: 'provider_incidents', arguments: { provider: 'cloudflare' } });
  assert.equal(assessObservations(provider, [component, incidents]).success, true);
  assert.deepEqual(new Set(urls), new Set(['https://www.cloudflarestatus.com/api/v2/components.json', 'https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json']));
});
