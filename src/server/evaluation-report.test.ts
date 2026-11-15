import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './app.ts';
import { StateStore } from './state.ts';
import { SKILLS } from './catalog.ts';
import type { GraphRepository } from './graph.ts';
import type { Planner } from './planner.ts';
import type { ToolRunner } from './runner.ts';

const original = { status: 'complete', generatedAt: '2026-11-15T18:00:00.000Z', datasetHash: 'a'.repeat(64), trainingTasks: 40, heldoutTasks: 20, graphVersion: 45, rows: [], curve: [{ checkpoint: 0, tasks: 20, successes: 20, meanSchemaBytes: 2000 }, { checkpoint: 40, tasks: 20, successes: 20, meanSchemaBytes: 2000 }], notes: ['Preserved original study.'], live: { tasks: 10, rows: [] } };
const supplement = () => ({ status: 'complete', study: 'goal-oriented-supplement-v1', successMetric: 'observationSuccess', generatedAt: '2026-11-15T18:12:10.838Z', datasetHash: 'b'.repeat(64), trainingTasks: 20, heldoutTasks: 20, graphVersion: 80, actualFeedbackUpdates: 16, rows: ['all', 'lexical', 'frozen', 'graph'].map(mode => ({ mode, tasks: 20, successes: 15, completePrerequisites: 15, meanSchemaBytes: 1996, irrelevantTools: 0, p50Ms: 140, p95Ms: 163 })), curve: [0, 5, 10, 20].map(checkpoint => ({ checkpoint, tasks: 20, successes: checkpoint ? 15 : 14, meanSchemaBytes: checkpoint ? 1996 : 2067 })), trainingCheckpoints: [{ checkpoint: 0, attempts: 0, feedback: 0 }, { checkpoint: 5, attempts: 5, feedback: 4 }, { checkpoint: 10, attempts: 10, feedback: 7 }, { checkpoint: 20, attempts: 20, feedback: 16 }], notes: ['Deterministic goal observations; failures retained.'], segments: [{ privateDetail: 'not part of the public subset' }] });

test('evaluation merges only a complete valid sibling supplement without replacing or rewriting the original study', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incident-evidence-'));
  const evidenceDir = join(dir, 'configured-artifacts');
  await mkdir(evidenceDir);
  const originalFile = join(evidenceDir, 'original-study.json');
  const supplementFile = join(evidenceDir, 'ambiguity-results.json');
  await writeFile(originalFile, JSON.stringify(original));
  const state = await StateStore.open(dir, SKILLS);
  const server = createApplication({ token: 'evidence-test', dataDir: dir, evaluationFile: originalFile, state, graph: {} as GraphRepository, planner: {} as Planner, runner: {} as ToolRunner }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async () => {
    const response = await fetch(`${origin}/api/evaluation`, { headers: { Authorization: 'Bearer evidence-test' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    await writeFile(supplementFile, JSON.stringify(supplement()));
    const report = await request();
    const { supplement: added, ...preserved } = report;
    assert.deepEqual(preserved, original);
    assert.ok(added, 'a complete valid sibling supplement must be included');
    assert.equal(added.study, 'goal-oriented-supplement-v1');
    assert.equal(added.actualFeedbackUpdates, 16);
    assert.deepEqual(added.curve.map((point: { successes: number }) => point.successes), [14, 15, 15, 15]);
    assert.equal(added.segments, undefined, 'unpublished detail must not leak through the response');
    assert.equal(await readFile(originalFile, 'utf8'), JSON.stringify(original));
    assert.equal(await readFile(supplementFile, 'utf8'), JSON.stringify(supplement()));

    const invalid = [
      { ...supplement(), status: 'pending' },
      { ...supplement(), successMetric: 'executorSuccess' },
      { ...supplement(), actualFeedbackUpdates: 21 },
      { ...supplement(), rows: supplement().rows.map(row => ({ ...row, successes: 21 })) },
      { ...supplement(), curve: supplement().curve.map(point => ({ ...point, tasks: 19 })) },
      { ...supplement(), trainingCheckpoints: supplement().trainingCheckpoints.slice(0, -1) },
    ];
    for (const artifact of invalid) {
      await writeFile(supplementFile, JSON.stringify(artifact));
      assert.deepEqual(await request(), original, 'pending or inconsistent supplement must be omitted');
    }
    await writeFile(supplementFile, '{unfinished');
    assert.deepEqual(await request(), original);
    await rm(supplementFile);
    await mkdir(join(dir, 'evaluation'));
    await writeFile(join(dir, 'evaluation', 'ambiguity-results.json'), JSON.stringify(supplement()));
    assert.deepEqual(await request(), original, 'only the configured original artifact’s fixed sibling is read');
  } finally { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); }
});
