import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runBenchmark, type BenchmarkDetail } from './benchmark.ts';
import { AMBIGUITY_SHA256, AMBIGUITY_STUDY, ambiguitySegments, assertAmbiguityComplete, assertAmbiguityLocked } from './ambiguity-study.ts';
import { HttpApi } from './client.ts';
import { claimOutput, writeJson } from './files.ts';

async function main() {
  await assertAmbiguityLocked();
  const tokenFile = process.env.BACKEND_TOKEN_FILE;
  if (!tokenFile) throw new Error('BACKEND_TOKEN_FILE must name the backend bearer-token file.');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Error('Backend token file is empty.');
  const outfile = resolve(process.env.OUTFILE ?? 'evaluation/ambiguity-results.json');
  const detailFile = resolve(process.env.DETAIL_OUTFILE ?? `${dirname(outfile)}/ambiguity-resultsdetail.json`);
  if (outfile === detailFile) throw new Error('OUTFILE and DETAIL_OUTFILE must differ.');
  await claimOutput(outfile); await claimOutput(detailFile);
  const sessionId = randomUUID();
  const api = new HttpApi(process.env.BACKEND_URL ?? 'http://127.0.0.1:8788', token);
  const pending = { status: 'pending', generatedAt: null, datasetHash: AMBIGUITY_SHA256, trainingTasks: 0, heldoutTasks: 20, graphVersion: 0, rows: [], curve: [], successMetric: 'observationSuccess', notes: ['Supplement running. No result claimed until all 160 cases, dataset checks, and freeze audits complete.'] };
  await writeJson(outfile, pending);
  let latest: BenchmarkDetail | undefined;
  let lastPrinted = '';
  try {
    const { report, detail } = await runBenchmark(api, sessionId, async progress => {
      latest = progress;
      const marker = `${progress.trainingAttempts}:${progress.feedback.length}:${progress.freezeAudits.length}:${progress.status}`;
      if (marker !== lastPrinted) {
        console.log(JSON.stringify({ event: 'progress', trainingAttempts: progress.trainingAttempts, trainingFeedback: progress.feedback.length, measuredPasses: progress.freezeAudits.length, cases: progress.cases.length, status: progress.status }));
        lastPrinted = marker;
      }
      await writeJson(detailFile, progress);
    }, AMBIGUITY_STUDY);
    await assertAmbiguityLocked();
    assertAmbiguityComplete(detail);
    const segments = ambiguitySegments(detail);
    await writeJson(detailFile, { ...detail, successMetric: 'observationSuccess', segments });
    await writeJson(outfile, { ...report, study: 'goal-oriented-supplement-v1', successMetric: 'observationSuccess', actualFeedbackUpdates: detail.feedback.length, trainingCheckpoints: detail.trainingCheckpoints, segments });
    console.log(JSON.stringify({ event: 'complete', outfile, detailFile, datasetHash: AMBIGUITY_SHA256, sessionId, trainingAttempts: detail.trainingAttempts, actualFeedbackUpdates: detail.feedback.length, rows: report.rows, curve: report.curve }, null, 2));
  } catch (error) {
    const fatalError = error instanceof Error ? error.message : String(error);
    if (latest) await writeJson(detailFile, { ...latest, status: 'failed', fatalError });
    await writeJson(outfile, { ...pending, status: 'failed', generatedAt: new Date().toISOString(), fatalError, notes: ['Supplement aborted; partial detail retained. No completed result claimed.'] });
    throw error;
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
