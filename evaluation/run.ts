import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runBenchmark, type BenchmarkDetail } from './benchmark.ts';
import { HttpApi } from './client.ts';
import { DATASET_SHA256, assertDatasetLocked } from './dataset.ts';
import { claimOutput, writeJson } from './files.ts';

async function main() {
  await assertDatasetLocked();
  const tokenFile = process.env.BACKEND_TOKEN_FILE;
  if (!tokenFile) throw new Error('BACKEND_TOKEN_FILE must name the backend bearer-token file.');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Error('Backend token file is empty.');
  const outfile = resolve(process.env.OUTFILE ?? 'evaluation/results.json');
  const detailFile = resolve(process.env.DETAIL_OUTFILE ?? `${dirname(outfile)}/resultsdetail.json`);
  if (outfile === detailFile) throw new Error('OUTFILE and DETAIL_OUTFILE must differ.');
  await claimOutput(outfile); await claimOutput(detailFile);
  const sessionId = randomUUID();
  const api = new HttpApi(process.env.BACKEND_URL ?? 'http://127.0.0.1:8788', token);
  await writeJson(outfile, { status: 'pending', generatedAt: null, datasetHash: DATASET_SHA256, trainingTasks: 0, heldoutTasks: 0, graphVersion: 0, rows: [], curve: [], notes: ['Benchmark running. No result claimed before protocol and freeze audits complete.'] });
  let latest: BenchmarkDetail | undefined;
  let lastPrinted = '';
  try {
    const { report, detail } = await runBenchmark(api, sessionId, async progress => {
      latest = progress;
      const marker = `${progress.feedback.length}:${progress.freezeAudits.length}:${progress.status}`;
      if (marker !== lastPrinted) {
        console.log(JSON.stringify({ event: 'progress', trainingFeedback: progress.feedback.length, measuredPasses: progress.freezeAudits.length, cases: progress.cases.length, status: progress.status })); lastPrinted = marker;
      }
      if (progress.cases.length % 10 === 0 || progress.status !== 'running') await writeJson(detailFile, progress);
    });
    await writeJson(detailFile, detail); await writeJson(outfile, report);
    console.log(JSON.stringify({ event: 'complete', outfile, detailFile, datasetHash: DATASET_SHA256, sessionId, rows: report.rows, curve: report.curve }, null, 2));
  } catch (error) {
    if (latest) await writeJson(detailFile, latest);
    throw error;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
