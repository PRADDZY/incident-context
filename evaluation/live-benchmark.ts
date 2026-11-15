import { performance } from 'node:perf_hooks';
import type { AgentRun, Bootstrap, EvaluationReport, Mode, PlanRequest } from '../src/shared/contracts.ts';
import { type BenchmarkDetail, type FreezeAudit, verifyFrozen, weightFingerprint } from './benchmark.ts';
import { HttpError } from './client.ts';
import { DATASET, DATASET_SHA256, HELDOUT_TASKS, TRAINING_TASKS, assertDatasetLocked } from './dataset.ts';
import { gradeCoverage, gradeObservations } from './grade.ts';

export interface LiveCase {
  taskId: string;
  mode: Mode;
  order: number;
  executorSuccess: boolean;
  observationSuccess: boolean;
  latencyMs: number;
  httpStatus: number;
  error: string | null;
  run: AgentRun | null;
  observationFailures: string[];
}
export interface LiveResult {
  status: 'running' | 'complete' | 'failed';
  protocol: 'paired-live-v1';
  datasetHash: string;
  sessionId: string;
  taskIds: string[];
  startedAt: string;
  completedAt: string | null;
  cases: LiveCase[];
  rows: NonNullable<EvaluationReport['live']>['rows'];
  freezeAudit: FreezeAudit;
  budgetBefore: Bootstrap['budget'];
  budgetAfter: Bootstrap['budget'];
  notes: string[];
  fatalError?: string;
}

export async function runLiveComparison(
  publicApi: { run(input: PlanRequest): Promise<AgentRun> },
  backend: { bootstrap(sessionId: string): Promise<Bootstrap> },
  training: BenchmarkDetail,
  onProgress: (result: LiveResult) => Promise<void> = async () => {},
  intervalMs = 0,
): Promise<LiveResult> {
  await assertDatasetLocked();
  if (training.status !== 'complete' || training.datasetHash !== DATASET_SHA256 || training.feedback.length !== 40 || TRAINING_TASKS.some(task => !training.feedback.some(feedback => feedback.taskId === task.id))) throw new Error('Completed locked training artifact with exactly 40 training feedback records required.');
  const before = await backend.bootstrap(training.sessionId);
  if (before.budget.limit - before.budget.calls < 30) throw new Error('30 model-call slots must be available before the paired live comparison.');
  const trainedWeights = training.freezeAudits.at(-1)?.afterWeights;
  if (trainedWeights && weightFingerprint(trainedWeights) !== weightFingerprint(before.weights)) throw new Error('Training weights changed since the completed training artifact.');
  const modes = ['all', 'frozen', 'graph'] as const;
  const result: LiveResult = {
    status: 'running', protocol: 'paired-live-v1', datasetHash: DATASET_SHA256, sessionId: training.sessionId,
    taskIds: [...DATASET.liveTaskIds], startedAt: new Date().toISOString(), completedAt: null,
    cases: [], rows: [], freezeAudit: { phase: 'paired-live', beforeGraphVersion: before.graphVersion, afterGraphVersion: before.graphVersion, beforeWeights: before.weights, afterWeights: before.weights, receiptVersions: [] },
    budgetBefore: before.budget, budgetAfter: before.budget,
    notes: [
      'Actual Worker/model requests: ten preselected held-out tasks paired across all, frozen and graph, once per arm. Arm order rotates by task index. All HTTP failures are retained and no request is retried.',
      'No live held-out feedback is submitted. All arms use the same task, trained session, backend, Worker model endpoint, temperature 0, max completion 256, and four-call cap. Frozen ignores training weights.',
      'Rows.successes count actual executor run.success === true returned through the model path. Independent observation success, exact returned model identity, usage (including nulls), calls and failures remain in case evidence.',
      'HTTP request attempts need not equal inference calls: a request may abstain before reservation or fail after reservation. The persistent before/after budget counters record reserved attempts.',
      'Provider availability may change between serial arms. This small fixed comparison supports descriptive paired results, without a significance claim or selective reruns.',
    ],
  };
  await onProgress(result);
  try {
    for (const [index, taskId] of DATASET.liveTaskIds.entries()) {
      const task = HELDOUT_TASKS.find(task => task.id === taskId)!;
      const order = [...modes.slice(index % modes.length), ...modes.slice(0, index % modes.length)];
      for (const mode of order) {
        const start = performance.now(); let run: AgentRun | null = null, error: string | null = null, httpStatus = 200;
        try {
          run = await publicApi.run({ task: task.task, sessionId: training.sessionId, mode, budget: 4096 });
          if (!run || typeof run.id !== 'string' || !run.plan || !Array.isArray(run.observations)) throw new Error('Worker returned an invalid AgentRun response.');
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          httpStatus = caught instanceof HttpError ? caught.status : 0;
          run = null;
        }
        const grade = gradeObservations(task, run?.observations ?? []);
        const coverage = run ? gradeCoverage(task, run.plan) : null;
        result.cases.push({ taskId, mode, order: result.cases.length + 1, executorSuccess: run?.success === true, observationSuccess: grade.success && coverage?.resolutionCorrect === true, latencyMs: Math.round((performance.now() - start) * 100) / 100, httpStatus, error, run, observationFailures: grade.failures });
        await onProgress(result);
        if (intervalMs > 0 && result.cases.length < 30) await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    const after = await backend.bootstrap(training.sessionId);
    result.budgetAfter = after.budget;
    result.freezeAudit = verifyFrozen('paired-live', before, after, result.cases.flatMap(row => row.run ? [row.run.plan.receipt.graphVersion] : []));
    result.rows = modes.map(mode => ({ mode, successes: result.cases.filter(row => row.mode === mode && row.executorSuccess).length, runIds: result.cases.filter(row => row.mode === mode && row.run).map(row => row.run!.id) }));
    const requestedModels = new Set(result.cases.flatMap(row => row.run ? [row.run.requestedModel] : []));
    if (requestedModels.size > 1) throw new Error('Model endpoint changed between paired arms.');
    result.status = 'complete'; result.completedAt = new Date().toISOString(); await onProgress(result); return result;
  } catch (error) {
    result.status = 'failed'; result.fatalError = error instanceof Error ? error.message : String(error); result.completedAt = new Date().toISOString(); await onProgress(result); throw error;
  }
}
