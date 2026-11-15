import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './app.ts';
import { StateStore } from './state.ts';
import { ToolRunner } from './runner.ts';
import { TOOLS, SERVICES, SKILLS } from './catalog.ts';
import type { GraphRepository } from './graph.ts';
import type { Planner } from './planner.ts';
import type { Plan } from '../shared/contracts.ts';

test('HTTP authenticates every route, rejects invalid calls and enforces plan session ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incident-http-'));
  const state = await StateStore.open(dir, SKILLS);
  const plan = { id: 'owned-plan', sessionId: 'owner-session', family: 'deployment', service: { ...SERVICES[0], latestDeploymentId: 'dep-northstar-checkout-20261115' }, tools: TOOLS, skill: SKILLS[1], abstained: false } as Plan;
  await state.savePlan(plan);
  const planner = { sessions: { feedback: async () => ({ before: { family: 'deployment', skillId: SKILLS[1].id, successes: 1, failures: 1, usefulness: 0.5 }, after: { family: 'deployment', skillId: SKILLS[1].id, successes: 2, failures: 1, usefulness: 2 / 3 }, graphVersion: 2, recordedAt: new Date().toISOString() }) } } as unknown as Planner;
  const server = createApplication({ token: 'backend-test-token', state, runner: new ToolRunner(), dataDir: dir, graph: {} as GraphRepository, planner }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer backend-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(origin + '/api/health')).status, 401);
    assert.equal((await post('/internal/reserve-model', { sessionId: 'owner-session' })).status, 200);
    assert.equal(state.budget().calls, 1);
    const input = { planId: plan.id, sessionId: 'other-session', calls: [], usage: { promptTokens: null, completionTokens: null, neurons: null }, requestedModel: 'test-model', returnedModel: 'test-model' };
    assert.equal((await post('/internal/execute', input)).status, 403);
    assert.equal((await post('/internal/execute', { ...input, sessionId: plan.sessionId, calls: Array.from({ length: 5 }, () => ({ name: 'service_metrics', arguments: {} })) })).status, 400);
    const response = await post('/internal/execute', { ...input, sessionId: plan.sessionId, calls: [{ name: 'service_metrics', arguments: { serviceId: plan.service.id, resourceId: plan.service.resourceId } }, { name: 'deployment_details', arguments: { serviceId: plan.service.id, deploymentId: plan.service.latestDeploymentId } }] });
    assert.equal(response.status, 200);
    const run = await response.json();
    assert.equal(run.success, true);
    assert.equal(run.observations.length, 2);
    assert.equal((await post('/api/feedback', { runId: run.id, sessionId: plan.sessionId, correct: true })).status, 200);
    assert.equal((await post('/api/feedback', { runId: run.id, sessionId: plan.sessionId, correct: true })).status, 409);
  } finally { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); }
});
