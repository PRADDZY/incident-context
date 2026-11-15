import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, Bootstrap, Feedback, FeedbackResult, Plan, PlanRequest, ToolCall } from '../src/shared/contracts.ts';
import { runBenchmark, type BenchmarkApi } from './benchmark.ts';
import { DATASET, DATASET_SHA256 } from './dataset.ts';

// Deliberately failing executor: proves neither curve nor feedback is invented
// from complete schemas, and that held-out feedback cannot enter training.
function backend(): { api: BenchmarkApi; feedback: Feedback[]; requests: PlanRequest[] } {
  const feedback: Feedback[] = [], requests: PlanRequest[] = [];
  const plans = new Map<string, Plan>();
  let version = 1;
  const weights = [{ family: 'deployment' as const, skillId: 'release-investigation', successes: 1, failures: 1, usefulness: 0.5 }];
  const api: BenchmarkApi = {
    async bootstrap() { return structuredClone({ product: 'Incident Context', engine: { status: 'ready', version: 'test-only' }, scenarios: [], budget: { day: 'test', calls: 0, limit: 60 }, graphVersion: version, weights, tools: [], services: [], skills: [], graph: { nodes: [], edges: [] } }) as Bootstrap; },
    async plan(input) {
      requests.push(input);
      const task = DATASET.tasks.find(task => task.task === input.task)!;
      const service = DATASET.services[task.serviceId];
      const names = DATASET.expectations[task.family].requiredTools;
      const plan: Plan = {
        id: `plan-${requests.length}`, sessionId: input.sessionId, task: input.task, family: task.family, mode: input.mode!,
        service: { ...service, id: task.serviceId, environment: 'sandbox', providerComponentId: 'live-id', providerComponentName: 'Workers' },
        tools: names.map(name => ({ id: name, name, description: '', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, source: task.family === 'provider' ? 'live' : 'sandbox', requires: [], server: 'fake-test-backend' })),
        skill: { id: 'release-investigation', name: 'test', description: '', family: task.family, tools: [] },
        schemaBytes: 0, fullSchemaBytes: 0, savedPercent: 0, resolvedEntities: [], abstained: false, reason: null,
        receipt: { engine: 'HydraDB', engineVersion: 'test-only', queries: [], nodes: [], edges: [], durationMs: 1, graphVersion: version },
      };
      plan.schemaBytes = Buffer.byteLength(JSON.stringify(plan.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))), 'utf8');
      plans.set(plan.id, plan); return plan;
    },
    async execute(plan, calls: ToolCall[]) {
      return { id: `run-${plan.id}`, plan, calls, observations: [], success: false, reason: 'intentional executor failure', answer: '', usage: { promptTokens: null, completionTokens: null, neurons: null }, requestedModel: 'deterministic-policy', returnedModel: 'deterministic-policy', createdAt: new Date().toISOString(), durationMs: 1 } as AgentRun;
    },
    async feedback(input) {
      feedback.push(input);
      const plan = plans.get(input.runId.replace('run-', ''))!;
      assert.ok(DATASET.tasks.some(task => task.task === plan.task && task.split === 'train'));
      assert.equal(input.correct, false);
      const before = structuredClone(weights[0]); weights[0].failures++; weights[0].usefulness = weights[0].successes / (weights[0].successes + weights[0].failures); version++;
      return { before, after: structuredClone(weights[0]), graphVersion: version, recordedAt: new Date().toISOString() } as FeedbackResult;
    },
  };
  return { api, feedback, requests };
}

test('protocol trains exactly 40 tasks, never feeds heldout back, keeps all failures and true flat curves', async () => {
  const fake = backend();
  const result = await runBenchmark(fake.api, 'test-session');
  assert.equal(fake.feedback.length, 40);
  assert.equal(result.report.datasetHash, DATASET_SHA256);
  assert.deepEqual(result.report.curve.map(point => point.checkpoint), [0, 10, 20, 40]);
  assert.ok(result.report.curve.every(point => point.successes === 0));
  assert.equal(result.detail.cases.length, 180);
  assert.equal(result.report.rows.length, 4);
  assert.ok(result.report.rows.every(row => row.tasks === 20 && row.successes === 0 && row.completePrerequisites === 20));
  assert.equal(result.detail.freezeAudits.length, 7);
  assert.ok(result.detail.freezeAudits.every(audit => audit.beforeGraphVersion === audit.afterGraphVersion));
  assert.ok(result.detail.cases.every(row => row.executorSuccess === false));
});

test('concurrent changes to evaluation weights or graph version invalidate a measured pass', async () => {
  const fake = backend();
  const original = fake.api.bootstrap; let reads = 0;
  fake.api.bootstrap = async session => {
    const value = await original(session);
    if (++reads > 1) value.graphVersion++;
    return value;
  };
  await assert.rejects(runBenchmark(fake.api, 'test-session'), /changed during/);
});

test('failed executor HTTP request stays a failed case without retries or artificial success', async () => {
  const fake = backend(); let attempts = 0;
  const execute = fake.api.execute;
  fake.api.execute = async (plan, calls) => {
    if (plan.mode === 'all') { attempts++; throw new Error('HTTP 503'); }
    return execute(plan, calls);
  };
  const result = await runBenchmark(fake.api, 'test-session');
  assert.equal(attempts, 20);
  assert.ok(result.detail.cases.filter(row => row.mode === 'all').every(row => row.executorSuccess === false && row.error?.includes('HTTP 503')));
});

test('failed plan requests keep unknown measurements null and remain in the denominator', async () => {
  const fake = backend();
  const plan = fake.api.plan;
  fake.api.plan = async input => {
    if (input.mode === 'all') throw new Error('HTTP 503 origin unavailable');
    return plan(input);
  };
  const result = await runBenchmark(fake.api, 'test-session');
  const full = result.report.rows.find(row => row.mode === 'all')!;
  assert.equal(full.tasks, 20); assert.equal(full.successes, 0); assert.equal(full.completePrerequisites, 0);
  assert.ok(result.detail.cases.filter(row => row.mode === 'all').every(row => row.plan === null && row.schemaBytes === null && row.irrelevantTools === null));
});

test('training stops without fabricated feedback when the executor returns no run', async () => {
  const fake = backend(); let finalStatus = '';
  fake.api.execute = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(runBenchmark(fake.api, 'test-session', async detail => { finalStatus = detail.status; }), /no actual executor run/);
  assert.equal(fake.feedback.length, 0); assert.equal(finalStatus, 'failed');
});
