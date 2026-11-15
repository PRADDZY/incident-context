import { performance } from 'node:perf_hooks';
import type { AgentRun, Bootstrap, EvaluationReport, Feedback, FeedbackResult, Mode, Plan, PlanRequest, ToolCall, Weight } from '../src/shared/contracts.ts';
import { DATASET, DATASET_SHA256, HELDOUT_TASKS, TRAINING_TASKS, assertDatasetLocked, type EvaluationTask } from './dataset.ts';
import { fixedWorkflowCalls, gradeCoverage, gradeObservations, summarize, type CaseMetrics } from './grade.ts';

export interface BenchmarkApi {
  bootstrap(sessionId: string): Promise<Bootstrap>;
  plan(input: PlanRequest): Promise<Plan>;
  execute(plan: Plan, calls: ToolCall[]): Promise<AgentRun>;
  feedback(input: Feedback): Promise<FeedbackResult>;
}
export interface CaseDetail extends CaseMetrics {
  taskId: string;
  split: EvaluationTask['split'];
  family: EvaluationTask['family'];
  phase: string;
  run: AgentRun | null;
  plan: Plan | null;
  calls: ToolCall[];
  error: string | null;
  missingTools: string[];
  resolutionCorrect: boolean;
  observationFailures: string[];
}
export interface FreezeAudit {
  phase: string;
  beforeGraphVersion: number;
  afterGraphVersion: number;
  beforeWeights: Weight[];
  afterWeights: Weight[];
  receiptVersions: number[];
}
export interface BenchmarkDetail {
  protocol: 'fixed-workflow-v1';
  status: 'running' | 'complete' | 'failed';
  datasetHash: string;
  sessionId: string;
  startedAt: string;
  completedAt: string | null;
  cases: CaseDetail[];
  freezeAudits: FreezeAudit[];
  feedback: { taskId: string; runId: string; correct: boolean; result: FeedbackResult }[];
  warmupPlanIds: string[];
  trainingAttempts?: number;
  trainingCheckpoints?: { checkpoint: number; attempts: number; feedback: number }[];
  fatalError?: string;
}
export interface BenchmarkStudySpec {
  datasetHash: string;
  trainingTasks: EvaluationTask[];
  heldoutTasks: EvaluationTask[];
  checkpoints: number[];
  notes: string[];
  successMetric?: 'executorSuccess' | 'observationSuccess';
  assertLocked(): Promise<void>;
  /** Supplements fail on transport errors, retaining only expected semantic plan failures. */
  isSemanticPlanFailure?: (error: unknown) => boolean;
}
export const weightFingerprint = (weights: Weight[]): string => JSON.stringify([...weights].sort((a, b) => a.family.localeCompare(b.family) || a.skillId.localeCompare(b.skillId)));

export function verifyFrozen(phase: string, before: Bootstrap, after: Bootstrap, receiptVersions: number[]): FreezeAudit {
  if (before.graphVersion !== after.graphVersion || weightFingerprint(before.weights) !== weightFingerprint(after.weights) || receiptVersions.some(version => version !== before.graphVersion)) throw new Error(`Graph version or weights changed during ${phase}; measured pass invalidated.`);
  return { phase, beforeGraphVersion: before.graphVersion, afterGraphVersion: after.graphVersion, beforeWeights: structuredClone(before.weights), afterWeights: structuredClone(after.weights), receiptVersions };
}

export async function runBenchmark(api: BenchmarkApi, sessionId: string, onProgress: (detail: BenchmarkDetail) => Promise<void> = async () => {}, studySpec?: BenchmarkStudySpec): Promise<{ report: EvaluationReport; detail: BenchmarkDetail }> {
  await assertDatasetLocked();
  if (studySpec) await studySpec.assertLocked();
  const datasetHash = studySpec?.datasetHash ?? DATASET_SHA256;
  const trainingTasks = studySpec?.trainingTasks ?? TRAINING_TASKS;
  const heldoutTasks = studySpec?.heldoutTasks ?? HELDOUT_TASKS;
  const checkpoints = studySpec?.checkpoints ?? [0, 10, 20, 40];
  if (checkpoints[0] !== 0 || checkpoints.at(-1) !== trainingTasks.length || checkpoints.some((point, index) => !Number.isInteger(point) || point < 0 || (index > 0 && point <= checkpoints[index - 1]))) throw new Error('Study checkpoints must increase from zero through every training attempt.');
  const detail: BenchmarkDetail = { protocol: 'fixed-workflow-v1', status: 'running', datasetHash, sessionId, startedAt: new Date().toISOString(), completedAt: null, cases: [], freezeAudits: [], feedback: [], warmupPlanIds: [], ...(studySpec ? { trainingAttempts: 0, trainingCheckpoints: [] } : {}) };
  await onProgress(detail);
  try {
    // remember() may write REMEMBERS_SERVICE and increment global version. Warm
    // all four services before any measured pass. No warmup run or feedback.
    for (const serviceId of Object.keys(DATASET.services)) {
      const task = DATASET.tasks.find(task => task.serviceId === serviceId)!;
      const warmup = await api.plan({ task: task.task, sessionId, mode: 'frozen', budget: 4096 });
      detail.warmupPlanIds.push(warmup.id);
    }
    const initial = await api.bootstrap(sessionId);
    if (initial.weights.some(weight => weight.successes !== 1 || weight.failures !== 1)) throw new Error('Benchmark session must have untouched 1/1 priors.');

    const execute = async (task: EvaluationTask, mode: Mode, phase: string): Promise<CaseDetail> => {
      const start = performance.now();
      let plan: Plan | null = null, run: AgentRun | null = null, error: string | null = null;
      let fatal: unknown;
      let calls: ToolCall[] = [], planLatencyMs = 0;
      try {
        plan = await api.plan({ task: task.task, sessionId, mode, budget: 4096 });
        planLatencyMs = Math.round((performance.now() - start) * 100) / 100;
        calls = fixedWorkflowCalls(task, plan);
        run = await api.execute(plan, calls);
      } catch (caught) {
        if (!plan) planLatencyMs = Math.round((performance.now() - start) * 100) / 100;
        error = caught instanceof Error ? caught.message : String(caught);
        if (studySpec?.isSemanticPlanFailure && (plan !== null || !studySpec.isSemanticPlanFailure(caught))) fatal = caught ?? new Error(error);
      }
      const coverage = plan ? gradeCoverage(task, plan) : null;
      const observations = gradeObservations(task, run?.observations ?? []);
      const row: CaseDetail = {
        taskId: task.id, split: task.split, family: task.family, phase, mode,
        executorSuccess: run?.success === true,
        observationSuccess: observations.success && coverage?.resolutionCorrect === true,
        completePrerequisites: coverage?.completePrerequisites ?? false,
        schemaBytes: coverage?.schemaBytes ?? null,
        irrelevantTools: coverage?.irrelevantTools ?? null,
        planLatencyMs, plan, run, calls, error,
        missingTools: coverage?.missingTools ?? [...DATASET.expectations[task.family].requiredTools],
        resolutionCorrect: coverage?.resolutionCorrect ?? false,
        observationFailures: observations.failures,
      };
      detail.cases.push(row);
      if (coverage && plan!.schemaBytes !== coverage.schemaBytes) throw new Error(`Backend/model serialization byte mismatch in ${task.id}; expected ${coverage.schemaBytes}, reported ${plan!.schemaBytes}.`);
      await onProgress(detail);
      if (fatal) throw fatal;
      return row;
    };
    const measured = async (mode: Mode, phase: string) => {
      if (studySpec) await studySpec.assertLocked();
      const before = await api.bootstrap(sessionId);
      const rows: CaseDetail[] = [];
      for (const task of heldoutTasks) rows.push(await execute(task, mode, phase));
      const after = await api.bootstrap(sessionId);
      detail.freezeAudits.push(verifyFrozen(phase, before, after, rows.flatMap(row => row.plan ? [row.plan.receipt.graphVersion] : [])));
      if (studySpec) await studySpec.assertLocked();
      await onProgress(detail); return rows;
    };
    const curve: EvaluationReport['curve'] = [];
    let graphRows: CaseDetail[] = [];
    let trainingAttempts = 0;
    for (const checkpoint of checkpoints) {
      const previous = trainingAttempts;
      for (let index = previous; index < checkpoint; index++) {
        const task = trainingTasks[index];
        const row = await execute(task, 'graph', 'training');
        trainingAttempts++;
        if (studySpec) detail.trainingAttempts = trainingAttempts;
        if (!row.run) {
          if (studySpec?.isSemanticPlanFailure) { await onProgress(detail); continue; }
          throw new Error(`Training ${task.id} has no actual executor run; stop instead of inventing feedback.`);
        }
        if (studySpec?.isSemanticPlanFailure && !row.plan?.skill) { await onProgress(detail); continue; }
        const correct = studySpec?.successMetric === 'observationSuccess' ? row.observationSuccess : row.run.success === true;
        const result = await api.feedback({ runId: row.run.id, sessionId, correct });
        detail.feedback.push({ taskId: task.id, runId: row.run.id, correct, result });
        await onProgress(detail);
      }
      if (studySpec) detail.trainingCheckpoints!.push({ checkpoint, attempts: trainingAttempts, feedback: detail.feedback.length });
      graphRows = await measured('graph', `checkpoint-${checkpoint}`);
      const aggregate = summarize('graph', graphRows, studySpec?.successMetric);
      curve.push({ checkpoint, tasks: aggregate.tasks, successes: aggregate.successes, meanSchemaBytes: aggregate.meanSchemaBytes });
    }
    const rows: EvaluationReport['rows'] = [];
    for (const mode of ['all', 'lexical', 'frozen'] as const) rows.push(summarize(mode, await measured(mode, `final-${mode}`), studySpec?.successMetric));
    rows.push(summarize('graph', graphRows, studySpec?.successMetric));
    const after = await api.bootstrap(sessionId);
    const report: EvaluationReport = {
      status: 'complete', generatedAt: new Date().toISOString(), datasetHash,
      trainingTasks: trainingTasks.length, heldoutTasks: heldoutTasks.length, graphVersion: after.graphVersion, rows, curve,
      notes: studySpec ? [...studySpec.notes, `${trainingAttempts} training attempts produced ${detail.feedback.length} actual feedback updates; ${trainingAttempts - detail.feedback.length} attempts had no trainable run/selected skill. Checkpoints count attempts, never fabricated feedback.`] : [
        'Deterministic FIXED workflow policy, not LLM task accuracy. Successes count actual /internal/execute run.success === true; no model was called and token/neurons usage is null.',
        'Schema coverage, actual executor completion, independently graded observations, and live model task success are separate outcomes. Independent observation failures and raw runs are retained in resultsdetail.json.',
        'Independent gold is locked in dataset.json before feedback. Expected tool sets are investigation requirements, not graph-edge or selected-skill outputs. A complete bundle alone never counts as executor success.',
        '40 ordered training cases receive feedback from actual executor outcomes only. 20 held-out tasks receive no feedback. Checkpoints 0/10/20/40 each freeze weights and graph version; flat or worsening curves are retained.',
        'Full catalog and lexical baselines use the same three-call workflow and resolved identifiers as both graph arms. Full catalog selects all 12 schemas; irrelevant schema counts include every selected schema outside the independent useful set.',
        'Bytes are UTF-8 JSON of the exact model tool array [{name,description,parameters}], independently recomputed. p50/p95 are nearest-rank HTTP /api/plan round-trip milliseconds, excluding tool execution.',
        'IrrelevantTools is the total selected irrelevant schemas across cases. Byte means exclude failed plan requests, whose missing measurements remain null in detail; transport failures count as failed executions and are never retried.',
        'Four service fixtures underlie 60 varied task narratives: two train services and two held-out services. This measures service/alias and wording transfer within two families, not 60 distinct real incidents or statistical generalization.',
        'Provider reads are real live Cloudflare status observations. Status values, incident counts, and latency may change between arms. Only observation presence, identity, source, and timestamp are graded.',
        'Session service-memory writes are completed before measured passes; all bootstrap and receipt graph versions and weight vectors must remain unchanged within each pass. No topology ablation or load claims are made here.',
      ],
    };
    detail.status = 'complete'; detail.completedAt = report.generatedAt;
    await onProgress(detail); return { report, detail };
  } catch (error) {
    detail.status = 'failed'; detail.fatalError = error instanceof Error ? error.message : String(error);
    detail.completedAt = new Date().toISOString(); await onProgress(detail); throw error;
  }
}
