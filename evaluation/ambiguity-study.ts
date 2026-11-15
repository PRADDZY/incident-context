import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import data from './ambiguity-dataset.json' with { type: 'json' };
import type { BenchmarkDetail, BenchmarkStudySpec } from './benchmark.ts';
import { HttpError } from './client.ts';
import { DATASET, type EvaluationTask } from './dataset.ts';
import { summarize } from './grade.ts';

export const AMBIGUITY_SHA256 = '7f29df93c38efdf15d47fea66dbc958e5dfd5f26a5cc2257096f3b1f519da2f7';
// Alias is unused by the independent grader. Never fill it from gold to repair a plan.
const tasks = data.tasks.map(task => ({ ...task, alias: '' })) as EvaluationTask[];

export function verifyAmbiguityLock(bytes: Uint8Array, manifest: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== AMBIGUITY_SHA256) throw new Error('Ambiguity dataset hash mismatch: stop before training or evaluation.');
  if (manifest.trim() !== `${AMBIGUITY_SHA256}  ambiguity-dataset.json`) throw new Error('Ambiguity dataset lock manifest mismatch.');
}

export async function assertAmbiguityLocked(): Promise<void> {
  const [bytes, manifest] = await Promise.all([
    readFile(new URL('./ambiguity-dataset.json', import.meta.url)),
    readFile(new URL('./ambiguity-dataset.sha256', import.meta.url), 'utf8'),
  ]);
  verifyAmbiguityLock(bytes, manifest);
  if (tasks.length !== 40 || new Set(tasks.map(task => task.id)).size !== 40 || data.trainingTasks !== 20 || data.heldoutTasks !== 20 || JSON.stringify(data.checkpoint) !== '[0,5,10,20]') throw new Error('Ambiguity corpus size, IDs, or checkpoints changed.');
  for (const split of ['train', 'heldout'] as const) {
    const serviceIds = split === 'train' ? ['northstar-checkout', 'cedar-dispatch'] : ['juniper-search', 'harbor-ledger'];
    const splitTasks = tasks.filter(task => task.split === split);
    if (splitTasks.length !== 20 || splitTasks.some(task => !serviceIds.includes(task.serviceId) || !DATASET.services[task.serviceId])) throw new Error('Ambiguity service split changed.');
    for (const family of ['deployment', 'provider']) {
      if (splitTasks.filter(task => task.family === family).length !== 10 || serviceIds.some(id => splitTasks.filter(task => task.family === family && task.serviceId === id).length !== 5)) throw new Error('Ambiguity family/service balance changed.');
    }
  }
}

const semanticResolutionMessages = ['No known service alias found in the task', 'Service alias has no unique graph resolution', 'Service has no unique graph resource'];
export const AMBIGUITY_STUDY: BenchmarkStudySpec = {
  datasetHash: AMBIGUITY_SHA256,
  trainingTasks: tasks.filter(task => task.split === 'train'),
  heldoutTasks: tasks.filter(task => task.split === 'heldout'),
  checkpoints: [0, 5, 10, 20],
  assertLocked: assertAmbiguityLocked,
  successMetric: 'observationSuccess',
  isSemanticPlanFailure: error => error instanceof HttpError && error.status === 422 && semanticResolutionMessages.some(message => error.message.endsWith(`: ${message}`)),
  notes: [
    'Bounded supplementary study of independently blind-authored goal-oriented requests; report alongside the completed initial study, never replacing it. Corpus wording, order, membership, planner, skills, and 1/1 priors are unchanged.',
    'Deterministic FIXED workflow policy, not LLM task accuracy. No model is called; token/neurons usage remains null. All catalog, lexical, frozen graph, and learned graph receive the identical workflow and independent grader.',
    'Success metric: independently graded actual observations plus correct service/resource resolution (observationSuccess). The supplementary goal-success curve and training feedback use this metric. Raw executorSuccess is retained separately because executor family self-grading can differ from the authored goal.',
    'Independent coverage/observation gold and service metadata reuse the original locked dataset. Expected tools or IDs never repair a plan. Schema coverage alone never counts as a successful goal.',
    '20 ordered training attempts and 20 held-out requests, balanced 10/10 by family in each split. Checkpoints 0/5/10/20 count attempts separately from feedback; feedback requires actual execution and a selected skill. Held-out requests receive no feedback; all failures and flat or worsening curves remain.',
    'Only known HTTP 422 service-resolution errors are retained as semantic failed plans; missing bytes remain null and cases stay in denominators. Other HTTP/transport errors, integrity changes, and freeze failures abort without retries. Partial detail is retained.',
    'Four canonical original requests warm all service memories before measurement. Each measured pass verifies identical before/after graph versions, weight vectors, and receipt versions. Dataset and manifest integrity are checked around each measured pass.',
    'Four service fixtures underlie 40 repeated request narratives. Training uses the first two services; held-out requests use the last two. This is wording/service transfer across two families, not independent new incidents or broad incident-response generalization.',
    'Live provider observations come from fixed Cloudflare public status URLs and may change between arms. Presence, identity, source, timestamp, and correct resource resolution are graded; no outage state or causal link is presumed.',
    'Bytes are independently recomputed UTF-8 JSON of the exact model tool array [{name,description,parameters}]. Means exclude failed plans with null bytes; latency is HTTP planning time excluding execution. Raw runs, errors, and independent observation failures remain in ambiguity-resultsdetail.json.',
  ],
};

export function assertAmbiguityComplete(detail: BenchmarkDetail): void {
  if (detail.status !== 'complete' || detail.datasetHash !== AMBIGUITY_SHA256 || detail.cases.length !== 160 || detail.trainingAttempts !== 20 || detail.freezeAudits.length !== 7) throw new Error('Incomplete ambiguity protocol evidence.');
  const training = detail.cases.filter(row => row.phase === 'training');
  if (JSON.stringify(training.map(row => row.taskId)) !== JSON.stringify(AMBIGUITY_STUDY.trainingTasks.map(task => task.id))) throw new Error('Training attempts missing, repeated, or reordered.');
  if (detail.feedback.some(item => !training.some(row => row.taskId === item.taskId && row.run?.id === item.runId && row.plan?.skill && row.observationSuccess === item.correct)) || new Set(detail.feedback.map(item => item.runId)).size !== detail.feedback.length) throw new Error('Feedback is not uniquely tied to actual training goal outcomes.');
  for (const phase of ['checkpoint-0', 'checkpoint-5', 'checkpoint-10', 'checkpoint-20', 'final-all', 'final-lexical', 'final-frozen']) {
    const rows = detail.cases.filter(row => row.phase === phase);
    if (JSON.stringify(rows.map(row => row.taskId)) !== JSON.stringify(AMBIGUITY_STUDY.heldoutTasks.map(task => task.id))) throw new Error(`Held-out membership/order changed in ${phase}.`);
  }
  for (const point of detail.trainingCheckpoints ?? []) {
    const expectedFeedback = training.slice(0, point.checkpoint).filter(row => row.run && row.plan?.skill).length;
    if (point.attempts !== point.checkpoint || point.feedback !== expectedFeedback) throw new Error('Training checkpoint attempt/feedback counts disagree.');
  }
  if (JSON.stringify(detail.trainingCheckpoints?.map(point => point.checkpoint)) !== '[0,5,10,20]') throw new Error('Missing attempt checkpoint evidence.');
}

export function ambiguitySegments(detail: BenchmarkDetail) {
  return [...new Set(detail.cases.map(row => row.phase))].flatMap(phase => (['deployment', 'provider'] as const).map(family => {
    const rows = detail.cases.filter(row => row.phase === phase && row.family === family);
    const aggregate = summarize(rows[0].mode, rows, 'observationSuccess');
    return { phase, split: rows[0].split, family, ...aggregate, executorSuccesses: rows.filter(row => row.executorSuccess).length, observationSuccesses: rows.filter(row => row.observationSuccess).length, feedbackUpdates: detail.feedback.filter(item => rows.some(row => row.taskId === item.taskId && row.run?.id === item.runId)).length };
  }));
}
