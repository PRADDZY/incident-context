import type { AgentRun, Bootstrap, Feedback, FeedbackResult, Plan, PlanRequest, ToolCall } from '../src/shared/contracts.ts';
import type { BenchmarkApi } from './benchmark.ts';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type Fetch = (url: URL, init?: RequestInit) => Promise<Response>;
export class HttpApi implements BenchmarkApi {
  constructor(private origin: string, private token: string | null, private request: Fetch = fetch) {}

  private async json<T>(path: string, payload?: unknown): Promise<T> {
    const method = payload === undefined ? 'GET' : 'POST';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.request(new URL(path, this.origin), { method, headers, signal: AbortSignal.timeout(35_000), ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new HttpError(response.status, `${method} ${path}: HTTP ${response.status}, invalid JSON response`); }
    if (!response.ok) {
      const reason = value && typeof value === 'object' && 'error' in value ? String(value.error).slice(0, 500) : 'request rejected';
      throw new HttpError(response.status, `${method} ${path}: HTTP ${response.status}: ${reason}`);
    }
    return value as T;
  }
  bootstrap(sessionId: string): Promise<Bootstrap> { return this.json(`/api/bootstrap?sessionId=${encodeURIComponent(sessionId)}`); }
  plan(input: PlanRequest): Promise<Plan> { return this.json('/api/plan', input); }
  execute(plan: Plan, calls: ToolCall[]): Promise<AgentRun> {
    return this.json('/internal/execute', { planId: plan.id, sessionId: plan.sessionId, calls, usage: { promptTokens: null, completionTokens: null, neurons: null }, requestedModel: 'deterministic-policy', returnedModel: 'deterministic-policy' });
  }
  feedback(input: Feedback): Promise<FeedbackResult> { return this.json('/api/feedback', input); }
  run(input: PlanRequest): Promise<AgentRun> { return this.json('/api/run', input); }
}
