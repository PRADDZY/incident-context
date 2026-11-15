import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import data from './ambiguity-dataset.json' with { type: 'json' };
import { runBenchmark, type BenchmarkApi } from './benchmark.ts';
import { HttpError } from './client.ts';
import { DATASET, type EvaluationTask } from './dataset.ts';
import { AMBIGUITY_STUDY, ambiguitySegments, assertAmbiguityComplete } from './ambiguity-study.ts';
import type { AgentRun, Bootstrap, Feedback, FeedbackResult, Plan, PlanRequest } from '../src/shared/contracts.ts';

const tasks = data.tasks.map(task => ({ ...task, alias: '' })) as EvaluationTask[];
const spec = {
  datasetHash: '7f29df93c38efdf15d47fea66dbc958e5dfd5f26a5cc2257096f3b1f519da2f7',
  trainingTasks: tasks.filter(task => task.split === 'train'),
  heldoutTasks: tasks.filter(task => task.split === 'heldout'),
  checkpoints: [0, 5, 10, 20],
  notes: ['Supplement: training checkpoints count attempts; actual feedback may be lower.'],
  successMetric: 'observationSuccess' as const,
  assertLocked: async () => {},
  isSemanticPlanFailure: (error: unknown) => error instanceof HttpError && error.status === 422 && error.message.includes('No known service alias found in the task'),
};

function backend() {
  const requests: PlanRequest[] = [], feedback: Feedback[] = [];
  const plans = new Map<string, Plan>();
  let version = 1;
  const weights = [{ family: 'deployment' as const, skillId: 'release-investigation', successes: 1, failures: 1, usefulness: 0.5 }];
  const api: BenchmarkApi = {
    async bootstrap() {
      return structuredClone({ product: 'Incident Context', engine: { status: 'ready', version: 'test-only' }, scenarios: [], budget: { day: 'test', calls: 0, limit: 60 }, graphVersion: version, weights, tools: [], services: [], skills: [], graph: { nodes: [], edges: [] } }) as Bootstrap;
    },
    async plan(input) {
      requests.push(input);
      const task = [...tasks, ...DATASET.tasks].find(task => task.task === input.task)!;
      assert.ok(task, 'request must be an untouched corpus request or original warmup');
      const service = DATASET.services[task.serviceId];
      const plan: Plan = {
        id: `plan-${requests.length}`, sessionId: input.sessionId, task: input.task, family: task.family, mode: input.mode!,
        service: { ...service, id: task.serviceId, environment: 'sandbox', providerComponentId: 'live-id' },
        tools: DATASET.expectations[task.family].requiredTools.map(name => ({ id: name, name, description: '', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, source: 'sandbox', requires: [], server: 'test-only' })),
        skill: { id: 'release-investigation', name: 'test', description: '', family: task.family, tools: [] },
        schemaBytes: 0, fullSchemaBytes: 0, savedPercent: 0, resolvedEntities: [], abstained: false, reason: null,
        receipt: { engine: 'HydraDB', engineVersion: 'test-only', queries: [], nodes: [], edges: [], durationMs: 1, graphVersion: version },
      };
      plan.schemaBytes = Buffer.byteLength(JSON.stringify(plan.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))), 'utf8');
      plans.set(plan.id, plan); return plan;
    },
    async execute(plan, calls) {
      return { id: `run-${plan.id}`, plan, calls, observations: [], success: false, reason: 'intentional failure', answer: '', usage: { promptTokens: null, completionTokens: null, neurons: null }, requestedModel: 'deterministic-policy', returnedModel: 'deterministic-policy', createdAt: new Date().toISOString(), durationMs: 1 } as AgentRun;
    },
    async feedback(input) {
      feedback.push(input);
      const plan = plans.get(input.runId.replace('run-', ''))!;
      assert.ok(spec.trainingTasks.some(task => task.task === plan.task));
      assert.equal(input.correct, false);
      const before = structuredClone(weights[0]); weights[0].failures++; weights[0].usefulness = weights[0].successes / (weights[0].successes + weights[0].failures); version++;
      return { before, after: structuredClone(weights[0]), graphVersion: version, recordedAt: new Date().toISOString() } as FeedbackResult;
    },
  };
  return { api, requests, feedback };
}

test('supplement preserves all 160 cases, flat results, and canonical warmups', async () => {
  const fake = backend();
  const result = await runBenchmark(fake.api, 'supplement-test', async () => {}, spec);
  assert.equal(result.report.datasetHash, spec.datasetHash);
  assert.equal(result.detail.cases.length, 160);
  assert.equal(fake.feedback.length, 20);
  assert.deepEqual(result.report.curve.map(point => point.checkpoint), [0, 5, 10, 20]);
  assert.ok(result.report.curve.every(point => point.successes === 0));
  assert.ok(result.report.rows.every(row => row.tasks === 20 && row.successes === 0));
  assert.equal(result.detail.freezeAudits.length, 7);
  assert.deepEqual(fake.requests.slice(0, 4).map(input => input.task), Object.keys(DATASET.services).map(id => DATASET.tasks.find(task => task.serviceId === id)!.task));
  assert.deepEqual(result.detail.cases.filter(row => row.phase === 'training').map(row => row.taskId), spec.trainingTasks.map(task => task.id));
});

test('semantic plan failures count as attempts without feedback and never repeat earlier training', async () => {
  const fake = backend(); const plan = fake.api.plan;
  const skipped = spec.trainingTasks[0];
  fake.api.plan = async input => {
    if (input.task === skipped.task) throw new HttpError(422, 'POST /api/plan: HTTP 422: No known service alias found in the task');
    return plan(input);
  };
  const result = await runBenchmark(fake.api, 'supplement-test', async () => {}, spec);
  assert.equal(result.detail.cases.length, 160);
  assert.equal(result.detail.trainingAttempts, 20);
  assert.equal(result.detail.feedback.length, 19);
  assert.deepEqual(result.detail.trainingCheckpoints, [
    { checkpoint: 0, attempts: 0, feedback: 0 }, { checkpoint: 5, attempts: 5, feedback: 4 },
    { checkpoint: 10, attempts: 10, feedback: 9 }, { checkpoint: 20, attempts: 20, feedback: 19 },
  ]);
  const failed = result.detail.cases.filter(row => row.taskId === skipped.id);
  assert.equal(failed.length, 1); assert.equal(failed[0].plan, null); assert.equal(failed[0].run, null);
  assert.equal(failed[0].executorSuccess, false); assert.equal(failed[0].schemaBytes, null);
  assert.ok(result.report.notes.some(note => note.includes('20 training attempts') && note.includes('19 actual feedback')));
});

test('supplement aborts transport errors after preserving the attempted case', async () => {
  const fake = backend(); const plan = fake.api.plan; let retained = 0;
  fake.api.plan = async input => {
    if (input.mode === 'graph') throw new HttpError(503, 'HydraDB unavailable');
    return plan(input);
  };
  await assert.rejects(runBenchmark(fake.api, 'supplement-test', async detail => { retained = detail.cases.length; }, spec), /HydraDB unavailable/);
  assert.equal(retained, 1); assert.equal(fake.feedback.length, 0);
});

test('supplement aborts non-resolution 422 responses', async () => {
  const fake = backend(); const execute = fake.api.execute;
  fake.api.execute = async (plan, calls) => {
    if (plan.mode === 'graph') throw new HttpError(422, 'Malformed executor request');
    return execute(plan, calls);
  };
  await assert.rejects(runBenchmark(fake.api, 'supplement-test', async () => {}, spec), /Malformed executor request/);
});

test('supplement trains and scores independent goals even when executor self-grading differs', async () => {
  const fake = backend(); const execute = fake.api.execute;
  fake.api.execute = async (plan, calls) => ({ ...await execute(plan, calls), success: true });
  const result = await runBenchmark(fake.api, 'supplement-test', async () => {}, spec);
  assert.ok(result.detail.cases.every(row => row.executorSuccess && !row.observationSuccess));
  assert.ok(result.report.curve.every(point => point.successes === 0));
  assert.ok(result.report.rows.every(row => row.successes === 0));
  assert.ok(fake.feedback.every(input => input.correct === false));
});

test('supplement lock rejects raw-byte or manifest changes and exposes frozen balanced metadata', async () => {
  const study = await import('./ambiguity-study.ts').catch(() => null);
  assert.ok(study, 'supplement must expose its locked study spec');
  const bytes = await readFile(new URL('./ambiguity-dataset.json', import.meta.url));
  const lock = await readFile(new URL('./ambiguity-dataset.sha256', import.meta.url), 'utf8');
  assert.doesNotThrow(() => study.verifyAmbiguityLock(bytes, lock));
  assert.throws(() => study.verifyAmbiguityLock(Buffer.concat([bytes, Buffer.from(' ')]), lock), /hash mismatch/);
  assert.throws(() => study.verifyAmbiguityLock(bytes, lock.replace('ambiguity-dataset', 'wrong-dataset')), /manifest mismatch/);
  await study.AMBIGUITY_STUDY.assertLocked();
  assert.deepEqual(study.AMBIGUITY_STUDY.checkpoints, [0, 5, 10, 20]);
  assert.equal(study.AMBIGUITY_STUDY.successMetric, 'observationSuccess');
  assert.ok(study.AMBIGUITY_STUDY.trainingTasks.every(task => task.alias === ''));
});

test('ambiguity raw corpus hash and manifest remain preregistered', async () => {
  const bytes = await readFile(new URL('./ambiguity-dataset.json', import.meta.url));
  const lock = await readFile(new URL('./ambiguity-dataset.sha256', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), spec.datasetHash);
  assert.equal(lock.trim(), `${spec.datasetHash}  ambiguity-dataset.json`);
  for (const split of ['train', 'heldout']) for (const family of ['deployment', 'provider']) {
    assert.equal(tasks.filter(task => task.split === split && task.family === family).length, 10);
  }
});

test('completed supplement validates membership and reports both family/split metrics', async () => {
  const fake = backend();
  const result = await runBenchmark(fake.api, 'supplement-test', async () => {}, AMBIGUITY_STUDY);
  assert.doesNotThrow(() => assertAmbiguityComplete(result.detail));
  const segments = ambiguitySegments(result.detail);
  assert.equal(segments.length, 16);
  assert.ok(segments.every(segment => segment.tasks === 10 && segment.successes === 0 && segment.executorSuccesses === 0 && segment.observationSuccesses === 0));
  assert.equal(segments.filter(segment => segment.split === 'train').length, 2);
  const dropped = structuredClone(result.detail); dropped.cases.pop();
  assert.throws(() => assertAmbiguityComplete(dropped), /Incomplete/);
  const leaked = structuredClone(result.detail); leaked.feedback[0].taskId = spec.heldoutTasks[0].id;
  assert.throws(() => assertAmbiguityComplete(leaked), /Feedback/);
});

test('actual runs with no selected skill remain attempts with no fabricated Beta update', async () => {
  const fake = backend(); const plan = fake.api.plan;
  fake.api.plan = async input => ({ ...await plan(input), skill: null });
  const result = await runBenchmark(fake.api, 'supplement-test', async () => {}, AMBIGUITY_STUDY);
  assert.equal(result.detail.cases.length, 160); assert.equal(result.detail.trainingAttempts, 20);
  assert.equal(result.detail.feedback.length, 0); assert.equal(fake.feedback.length, 0);
  assert.ok(result.detail.cases.every(row => row.run !== null));
  assert.doesNotThrow(() => assertAmbiguityComplete(result.detail));
});

test('only known semantic resolution errors qualify for continuation', () => {
  const classify = AMBIGUITY_STUDY.isSemanticPlanFailure!;
  for (const message of ['No known service alias found in the task', 'Service alias has no unique graph resolution', 'Service has no unique graph resource']) {
    assert.equal(classify(new HttpError(422, `POST /api/plan: HTTP 422: ${message}`)), true);
    assert.equal(classify(new HttpError(503, `POST /api/plan: HTTP 503: ${message}`)), false);
  }
  assert.equal(classify(new HttpError(422, 'POST /api/plan: HTTP 422: Malformed request')), false);
  assert.equal(classify(new Error('No known service alias found in the task')), false);
});

test('a dataset integrity change during a measured pass invalidates the supplement', async () => {
  const fake = backend(); let checks = 0; let retained = 0;
  const changed = { ...spec, assertLocked: async () => { if (++checks === 3) throw new Error('Ambiguity dataset hash mismatch'); } };
  await assert.rejects(runBenchmark(fake.api, 'supplement-test', async detail => { retained = detail.cases.length; }, changed), /hash mismatch/);
  assert.equal(retained, 20); assert.equal(fake.feedback.length, 0);
});
