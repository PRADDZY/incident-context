import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, Bootstrap, FeedbackResult, PlanRequest } from '../src/shared/contracts.ts';
import { runLiveComparison } from './live-benchmark.ts';
import { DATASET, DATASET_SHA256, TRAINING_TASKS } from './dataset.ts';
import type { BenchmarkDetail } from './benchmark.ts';

const training: BenchmarkDetail = {
  protocol: 'fixed-workflow-v1', status: 'complete', datasetHash: DATASET_SHA256, sessionId: 'trained-session', startedAt: '2026-11-15T00:00:00Z', completedAt: '2026-11-15T01:00:00Z', cases: [], freezeAudits: [], warmupPlanIds: [],
  feedback: TRAINING_TASKS.map(task => ({ taskId: task.id, runId: task.id, correct: false, result: {} as FeedbackResult })),
};
const bootstrap = (calls = 0): Bootstrap => ({ product: 'Incident Context', engine: { status: 'ready', version: 'test' }, tools: [], services: [], skills: [], scenarios: [], graph: { nodes: [], edges: [] }, weights: [], graphVersion: 10, budget: { day: '2026-11-15', calls, limit: 60 } });

test('live protocol attempts exactly ten fixed heldout cases in each arm once, retains HTTP failures and never trains', async () => {
  const requests: PlanRequest[] = [];
  const result = await runLiveComparison({ async run(input) { requests.push(input); throw new Error('HTTP 502 model returned invalid arguments'); } }, { async bootstrap() { return bootstrap(); } }, training);
  assert.equal(requests.length, 30);
  assert.deepEqual([...new Set(requests.map(request => request.task))].sort(), DATASET.tasks.filter(task => DATASET.liveTaskIds.includes(task.id)).map(task => task.task).sort());
  for (const mode of ['all', 'frozen', 'graph']) assert.equal(requests.filter(request => request.mode === mode).length, 10);
  for (const taskId of DATASET.liveTaskIds) for (const mode of ['all', 'frozen', 'graph']) assert.equal(requests.filter(request => request.task === DATASET.tasks.find(task => task.id === taskId)!.task && request.mode === mode).length, 1);
  assert.ok(requests.every(request => request.sessionId === 'trained-session'));
  assert.equal(result.cases.length, 30);
  assert.ok(result.cases.every(row => !row.executorSuccess && row.error));
  assert.ok(result.rows.every(row => row.successes === 0));
  assert.equal(result.freezeAudit.beforeGraphVersion, result.freezeAudit.afterGraphVersion);
});

test('live comparison fails before model requests if the daily application quota cannot fit all arms', async () => {
  let attempts = 0;
  await assert.rejects(runLiveComparison({ async run() { attempts++; return {} as AgentRun; } }, { async bootstrap() { return bootstrap(31); } }, training), /30.*available/);
  assert.equal(attempts, 0);
});

test('live comparison rejects an unlocked or incomplete training artifact before model requests', async () => {
  let attempts = 0;
  await assert.rejects(runLiveComparison({ async run() { attempts++; return {} as AgentRun; } }, { async bootstrap() { return bootstrap(); } }, { ...training, datasetHash: 'wrong' }), /training artifact/);
  assert.equal(attempts, 0);
});
