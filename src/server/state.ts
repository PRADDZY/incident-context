import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRun, Family, Feedback, FeedbackResult, Plan, Weight } from '../shared/contracts.ts';
import { ApiError } from './errors.ts';

interface State {
  version: 1;
  graphVersion: number;
  days: Record<string, number>;
  weights: Record<string, Weight[]>;
  plans: Record<string, Plan>;
  runs: Record<string, AgentRun>;
  feedback: Record<string, FeedbackResult>;
  protectedSessions: string[];
}
type SkillIdentity = { id: string; family: Family };
export const utcDay = () => new Date().toISOString().slice(0, 10);

export class StateStore {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private dir: string, private skills: SkillIdentity[], private data: State) {}

  static async open(dir: string, skills: SkillIdentity[]) {
    await mkdir(dir, { recursive: true });
    let data: State;
    try { data = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as State; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      data = { version: 1, graphVersion: 1, days: {}, weights: {}, plans: {}, runs: {}, feedback: {}, protectedSessions: [] };
    }
    data.protectedSessions ??= [];
    if (data.version !== 1 || !data.days || !data.weights || !data.plans || !data.runs || !data.feedback) {
      throw new Error('Unsupported or damaged persistent state');
    }
    if (!Array.isArray(data.protectedSessions) || data.protectedSessions.some(id => typeof id !== 'string')) throw new Error('Invalid protected session state');
    return new StateStore(dir, skills, data);
  }

  get graphVersion() { return this.data.graphVersion; }
  budget(day = utcDay()) { return { day, calls: this.data.days[day] ?? 0, limit: 60 }; }
  weights(sessionId: string, frozen = false): Weight[] {
    const initial = (['deployment', 'provider'] as Family[]).flatMap(family => this.skills.map(s => ({ family, skillId: s.id, successes: 1, failures: 1, usefulness: 0.5 })));
    return structuredClone(frozen ? initial : this.data.weights[sessionId] ?? initial);
  }

  private mutate<T>(operation: (next: State) => T | Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const result = await operation(next);
      const temp = join(this.dir, `state.${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, join(this.dir, 'state.json'));
      this.data = next;
      return structuredClone(result);
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  reserveModel(day = utcDay()) {
    return this.mutate(next => {
      const calls = next.days[day] ?? 0;
      if (calls >= 60) throw new ApiError(429, 'Daily model attempt limit reached');
      next.days[day] = calls + 1;
      return { day, calls: calls + 1, limit: 60 };
    });
  }
  savePlan(plan: Plan) { return this.mutate(next => { next.plans[plan.id] = plan; }); }
  getPlan(id: string, sessionId: string) {
    const plan = this.data.plans[id];
    if (!plan) throw new ApiError(404, 'Plan not found');
    if (plan.sessionId !== sessionId) throw new ApiError(403, 'Plan owner does not match session');
    return structuredClone(plan);
  }
  saveRun(run: AgentRun) { return this.mutate(next => { next.runs[run.id] = run; }); }
  protectSession(sessionId: string) {
    return this.mutate(next => {
      if (!next.protectedSessions.includes(sessionId)) next.protectedSessions.push(sessionId);
      return { sessionId, protected: true };
    });
  }
  getRun(id: string, sessionId: string) {
    const run = this.data.runs[id];
    if (!run) throw new ApiError(404, 'Run not found');
    if (run.plan.sessionId !== sessionId) throw new ApiError(403, 'Run owner does not match session');
    return structuredClone(run);
  }
  feedback(input: Feedback, graphWriter?: (input: Feedback, run: AgentRun) => Promise<FeedbackResult>): Promise<FeedbackResult> {
    return this.mutate(async next => {
      if (next.protectedSessions.includes(input.sessionId)) throw new ApiError(403, 'Feedback is locked for this protected session');
      const run = next.runs[input.runId];
      if (!run) throw new ApiError(404, 'Run not found');
      if (run.plan.sessionId !== input.sessionId) throw new ApiError(403, 'Run owner does not match session');
      if (next.feedback[input.runId]) throw new ApiError(409, 'Feedback already recorded');
      if (/^(benchmark|evaluation)[:_-]/i.test(input.sessionId)) throw new ApiError(403, 'Benchmark feedback is locked');
      if (!run.plan.skill) throw new ApiError(422, 'Run has no selected skill to update');
      if (graphWriter) {
        const result = await graphWriter(input, run);
        const weights = next.weights[input.sessionId] ?? this.weights(input.sessionId);
        next.weights[input.sessionId] = weights.map(w => w.family === result.after.family && w.skillId === result.after.skillId ? result.after : w);
        next.graphVersion = Math.max(next.graphVersion, result.graphVersion);
        next.feedback[input.runId] = result;
        return result;
      }
      const weights = next.weights[input.sessionId] ?? this.weights(input.sessionId);
      const weight = weights.find(w => w.skillId === run.plan.skill!.id && w.family === run.plan.family);
      if (!weight) throw new ApiError(422, 'Unknown skill weight');
      const before = structuredClone(weight);
      if (input.correct) weight.successes++; else weight.failures++;
      weight.usefulness = weight.successes / (weight.successes + weight.failures);
      next.weights[input.sessionId] = weights;
      next.graphVersion++;
      const result = { before, after: structuredClone(weight), graphVersion: next.graphVersion, recordedAt: new Date().toISOString() };
      next.feedback[input.runId] = result;
      return result;
    });
  }
}
