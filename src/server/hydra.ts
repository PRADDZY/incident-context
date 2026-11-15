import { performance } from 'node:perf_hooks';
import type { Json, QueryReceipt } from '../shared/contracts.ts';
import { ApiError } from './errors.ts';

export interface HydraOptions { origin: string; token: string; namespace?: string; cellId?: string; timeoutMs?: number }
export interface QueryResult { rows: Record<string, Json>[]; receipt: QueryReceipt }

export class HydraClient {
  constructor(private options: HydraOptions) {}

  async query(cypher: string, parameters: Record<string, string | number | boolean> = {}): Promise<QueryResult> {
    const start = performance.now();
    let response: Response;
    try {
      response = await fetch(`${this.options.origin}/v1/graphs/default/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json', 'X-Graph-Namespace': this.options.namespace ?? 'default' },
        body: JSON.stringify({ cell_id: this.options.cellId ?? 'cell-0', query: cypher, parameters }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch { throw new ApiError(503, 'HydraDB is unreachable or query timed out'); }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500).replaceAll(this.options.token, '[redacted]');
      console.error('HydraDB query rejected', { status: response.status, cypher, detail });
      throw new ApiError(503, `HydraDB query failed (${response.status})`);
    }
    const payload = await response.json() as { columns?: string[]; rows?: unknown[][]; error?: unknown; next_cursor?: string | null };
    if (payload.error || !Array.isArray(payload.columns) || !Array.isArray(payload.rows)) {
      throw new ApiError(502, 'HydraDB returned an invalid query response');
    }
    if (payload.next_cursor) throw new ApiError(502, 'HydraDB result exceeds the bounded graph response');
    const rows = payload.rows.map(cells => Object.fromEntries(payload.columns!.map((name, index) => {
      const cell = cells[index];
      const value = cell && typeof cell === 'object' && 'type' in cell && cell.type === 'null' ? null
        : cell && typeof cell === 'object' && 'value' in cell ? (cell as { value: Json }).value : cell as Json;
      return [name, value ?? null];
    })));
    return { rows, receipt: { cypher, parameters, rows: rows.length, durationMs: Math.round((performance.now() - start) * 100) / 100 } };
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.origin}/healthz`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch { return false; }
  }
}
