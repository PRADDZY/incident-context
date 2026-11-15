import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { AgentRun, Bootstrap, EvaluationReport } from '../shared/contracts.ts';
import { SCENARIOS } from './catalog.ts';
import { GraphRepository } from './graph.ts';
import { Planner } from './planner.ts';
import { StateStore } from './state.ts';
import { ToolRunner, assessObservations } from './runner.ts';
import { ApiError, message } from './errors.ts';

const sessionId = z.string().regex(/^[a-zA-Z0-9:_-]{1,80}$/);
const planInput = z.object({ task: z.string().min(1).max(16384), sessionId, mode: z.enum(['all', 'lexical', 'frozen', 'graph']).optional(), budget: z.number().int().min(2).max(4096).optional() }).strict();
const usage = z.object({ promptTokens: z.number().nonnegative().nullable(), completionTokens: z.number().nonnegative().nullable(), neurons: z.number().nonnegative().nullable() }).strict();
const executeInput = z.object({ planId: z.string().min(1).max(80), sessionId, calls: z.array(z.object({ name: z.string().min(1).max(80), arguments: z.record(z.string(), z.json()) }).strict()).max(4), usage, requestedModel: z.string().min(1).max(160), returnedModel: z.string().min(1).max(160) }).strict();
const feedbackInput = z.object({ runId: z.string().min(1).max(80), sessionId, correct: z.boolean() }).strict();
const count = z.number().int().nonnegative();
const supplementInput = z.object({
  status: z.literal('complete'), study: z.literal('goal-oriented-supplement-v1'), successMetric: z.literal('observationSuccess'),
  generatedAt: z.string().datetime(), datasetHash: z.string().regex(/^[a-f0-9]{64}$/), trainingTasks: count.positive(), heldoutTasks: count.positive(), graphVersion: count,
  actualFeedbackUpdates: count,
  rows: z.array(z.object({ mode: z.enum(['all', 'lexical', 'frozen', 'graph']), tasks: count.positive(), successes: count, completePrerequisites: count, meanSchemaBytes: z.number().nonnegative(), irrelevantTools: count, p50Ms: z.number().nonnegative(), p95Ms: z.number().nonnegative() })).length(4),
  curve: z.array(z.object({ checkpoint: count, tasks: count.positive(), successes: count, meanSchemaBytes: z.number().nonnegative() })).min(2),
  notes: z.array(z.string()),
  trainingCheckpoints: z.array(z.object({ checkpoint: count, attempts: count, feedback: count })).min(2),
}).refine(report => {
  if (report.actualFeedbackUpdates > report.trainingTasks || new Set(report.rows.map(row => row.mode)).size !== 4) return false;
  if (report.rows.some(row => row.tasks !== report.heldoutTasks || row.successes > row.tasks || row.completePrerequisites > row.tasks || row.p95Ms < row.p50Ms)) return false;
  if (report.curve[0].checkpoint !== 0 || report.curve.at(-1)!.checkpoint !== report.trainingTasks || report.trainingCheckpoints.length !== report.curve.length) return false;
  return report.curve.every((point, index) => {
    const training = report.trainingCheckpoints[index], previous = report.trainingCheckpoints[index - 1];
    return point.tasks === report.heldoutTasks && point.successes <= point.tasks && training.checkpoint === point.checkpoint && training.attempts === point.checkpoint && training.feedback <= training.attempts && (!previous || (training.checkpoint > previous.checkpoint && training.feedback >= previous.feedback));
  }) && report.trainingCheckpoints[0].feedback === 0 && report.trainingCheckpoints.at(-1)!.feedback === report.actualFeedbackUpdates;
});

export interface ApplicationOptions { token: string; dataDir: string; graph: GraphRepository; planner: Planner; state: StateStore; runner: ToolRunner; evaluationFile?: string }

async function body(req: IncomingMessage): Promise<unknown> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 48 * 1024) throw new ApiError(413, 'Request body exceeds 48 KiB');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Request body must be valid JSON'); }
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function authorized(req: IncomingMessage, token: string) {
  const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApplication(options: ApplicationOptions) {
  if (!options.token) throw new Error('Backend bearer token is required');
  const { graph, planner, state, runner } = options;
  const server = createServer(async (req, res) => {
    try {
      if (!authorized(req, options.token)) throw new ApiError(401, 'Backend authentication required');
      const url = new URL(req.url ?? '/', 'http://backend.local');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/health') {
        const ready = await graph.engine.health();
        send(res, ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable', engine: { name: 'HydraDB', version: '0.4.0', status: ready ? 'ready' : 'unavailable' } }); return;
      }
      if (route === 'GET /api/bootstrap') {
        const session = sessionId.parse(url.searchParams.get('sessionId'));
        const snapshot = await graph.snapshot();
        const memory = await planner.sessions.read(session, snapshot.skills);
        const bootstrap: Bootstrap = { product: 'Incident Context', engine: { status: 'ready', version: '0.4.0' }, tools: snapshot.tools, services: snapshot.services, skills: snapshot.skills, scenarios: SCENARIOS, graph: { nodes: [...snapshot.nodes, ...memory.nodes.filter(n => !snapshot.nodes.some(existing => existing.id === n.id))], edges: [...snapshot.edges, ...memory.edges] }, weights: memory.weights, graphVersion: memory.graphVersion, budget: state.budget() };
        send(res, 200, bootstrap); return;
      }
      if (route === 'POST /api/plan') { send(res, 200, await planner.plan(planInput.parse(await body(req)))); return; }
      if (route === 'POST /internal/reserve-model') {
        z.object({ sessionId }).strict().parse(await body(req));
        send(res, 200, await state.reserveModel()); return;
      }
      if (route === 'POST /internal/protect-session') {
        const input = z.object({ sessionId }).strict().parse(await body(req));
        send(res, 200, await state.protectSession(input.sessionId)); return;
      }
      if (route === 'POST /internal/execute') {
        const start = performance.now(), input = executeInput.parse(await body(req));
        const plan = state.getPlan(input.planId, input.sessionId);
        const observations = [];
        for (const call of input.calls) observations.push(await runner.execute(plan, call));
        const assessment = assessObservations(plan, observations);
        const run: AgentRun = { id: randomUUID(), plan, calls: input.calls, observations, ...assessment, usage: input.usage, requestedModel: input.requestedModel, returnedModel: input.returnedModel, createdAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start) };
        await state.saveRun(run); send(res, 200, run); return;
      }
      if (route === 'POST /api/feedback') {
        const input = feedbackInput.parse(await body(req));
        send(res, 200, await state.feedback(input, (feedback, run) => planner.sessions.feedback(feedback, run.plan, run.plan.skill ? [run.plan.skill] : []))); return;
      }
      if (route === 'GET /api/evaluation') {
        const evaluationFile = options.evaluationFile ?? join(options.dataDir, 'evaluation', 'results.json');
        let report: EvaluationReport;
        try { report = JSON.parse(await readFile(evaluationFile, 'utf8')) as EvaluationReport; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          report = { status: 'pending', generatedAt: null, datasetHash: null, trainingTasks: 0, heldoutTasks: 0, graphVersion: state.graphVersion, rows: [], curve: [], notes: ['No benchmark artifact exists yet. No improvement or model success is claimed.'] };
        }
        delete report.supplement;
        try {
          const parsed = supplementInput.safeParse(JSON.parse(await readFile(join(dirname(evaluationFile), 'ambiguity-results.json'), 'utf8')));
          if (parsed.success) report.supplement = parsed.data;
        } catch { /* The supplementary artifact is optional; unavailable or incomplete evidence is omitted. */ }
        send(res, 200, report); return;
      }
      throw new ApiError(404, 'Route not found');
    } catch (error) {
      if (error instanceof z.ZodError) send(res, 400, { error: 'Request validation failed', details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
      else if (error instanceof ApiError) send(res, error.status, { error: error.message });
      else { console.error('backend request failed:', message(error)); send(res, 500, { error: 'Backend operation failed' }); }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
