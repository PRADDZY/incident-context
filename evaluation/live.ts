import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EvaluationReport } from '../src/shared/contracts.ts';
import type { BenchmarkDetail } from './benchmark.ts';
import { HttpApi } from './client.ts';
import { DATASET_SHA256, assertDatasetLocked } from './dataset.ts';
import { claimOutput, writeJson } from './files.ts';
import { runLiveComparison, type LiveResult } from './live-benchmark.ts';

async function main() {
  await assertDatasetLocked();
  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) throw new Error('PUBLIC_URL is required. This command makes up to 30 real model requests.');
  if (new URL(publicUrl).protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(new URL(publicUrl).hostname)) throw new Error('PUBLIC_URL must use HTTPS outside localhost.');
  const tokenFile = process.env.BACKEND_TOKEN_FILE;
  if (!tokenFile) throw new Error('BACKEND_TOKEN_FILE must name the backend token file.');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Error('Backend token file is empty.');
  const training = JSON.parse(await readFile(resolve(process.env.BENCHMARK_DETAIL_FILE ?? 'evaluation/resultsdetail.json'), 'utf8')) as BenchmarkDetail;
  const reportFile = resolve(process.env.REPORT_FILE ?? 'evaluation/results.json');
  const report = JSON.parse(await readFile(reportFile, 'utf8')) as EvaluationReport;
  if (report.status !== 'complete' || report.datasetHash !== DATASET_SHA256 || report.live) throw new Error('A complete locked deterministic report without a previous live comparison is required.');
  const outfile = resolve(process.env.OUTFILE ?? 'evaluation/live-results.json');
  await claimOutput(outfile);
  const intervalMs = Number(process.env.LIVE_INTERVAL_MS ?? 1000);
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 60_000) throw new Error('LIVE_INTERVAL_MS must be between 0 and 60000.');
  const backend = new HttpApi(process.env.BACKEND_URL ?? 'http://127.0.0.1:8788', token);
  const publicApi = new HttpApi(publicUrl, null);
  let latest: LiveResult | undefined;
  try {
    const result = await runLiveComparison(publicApi, backend, training, async progress => {
      latest = progress; await writeJson(outfile, progress);
      const row = progress.cases.at(-1);
      if (row) console.log(JSON.stringify({ taskId: row.taskId, mode: row.mode, order: row.order, executorSuccess: row.executorSuccess, observationSuccess: row.observationSuccess, httpStatus: row.httpStatus, error: row.error, status: progress.status }));
    }, intervalMs);
    report.live = { tasks: result.taskIds.length, rows: result.rows };
    report.notes.push(...result.notes, `Live evidence: ${outfile}; reserved model attempts ${result.budgetBefore.calls} -> ${result.budgetAfter.calls}.`);
    await writeJson(reportFile, report);
    console.log(JSON.stringify({ event: 'complete', outfile, rows: result.rows, budgetBefore: result.budgetBefore, budgetAfter: result.budgetAfter }, null, 2));
  } catch (error) {
    if (latest) await writeJson(outfile, latest);
    throw error;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
