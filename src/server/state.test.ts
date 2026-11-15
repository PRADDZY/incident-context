import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state.ts';
import type { AgentRun, Plan } from '../shared/contracts.ts';

const skills = [{ id: 'release-investigation', family: 'deployment' as const }];
const plan = { id: 'p1', sessionId: 'session-a', family: 'deployment', skill: { id: 'release-investigation' } } as Plan;
const run = { id: 'r1', plan, success: true } as AgentRun;

test('daily reservations serialize and remain capped after reopening the store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incident-state-'));
  try {
    const state = await StateStore.open(dir, skills);
    const reservations = await Promise.allSettled(Array.from({ length: 65 }, () => state.reserveModel('2026-11-15')));
    assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 60);
    assert.equal((await StateStore.open(dir, skills)).budget('2026-11-15').calls, 60);
    assert.equal((await state.reserveModel('2026-11-16')).calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('feedback is owner-scoped, duplicate-safe and durable without changing another session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incident-feedback-'));
  try {
    const state = await StateStore.open(dir, skills);
    await state.savePlan(plan);
    await state.saveRun(run);
    await assert.rejects(state.feedback({ runId: 'r1', sessionId: 'session-b', correct: true }), /owner/);
    const updated = await state.feedback({ runId: 'r1', sessionId: 'session-a', correct: true });
    assert.equal(updated.before.usefulness, 0.5);
    assert.equal(updated.after.usefulness, 2 / 3);
    await assert.rejects(state.feedback({ runId: 'r1', sessionId: 'session-a', correct: false }), /already/);
    const reopened = await StateStore.open(dir, skills);
    assert.equal(reopened.weights('session-a')[0].successes, 2);
    assert.equal(reopened.weights('session-b')[0].successes, 1);
    assert.equal(reopened.graphVersion, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed graph feedback write does not acknowledge feedback or consume the retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incident-graph-failure-'));
  try {
    const state = await StateStore.open(dir, skills);
    await state.saveRun(run);
    const input = { runId: run.id, sessionId: plan.sessionId, correct: true };
    await assert.rejects(state.feedback(input, async () => { throw new Error('engine unavailable'); }), /engine unavailable/);
    assert.equal(state.weights(plan.sessionId)[0].successes, 1);
    const result = await state.feedback(input, async () => ({ before: state.weights(plan.sessionId)[0], after: { ...state.weights(plan.sessionId)[0], successes: 2, usefulness: 2 / 3 }, graphVersion: 7, recordedAt: '2026-11-15T12:00:00Z' }));
    assert.equal(result.graphVersion, 7);
    assert.equal(state.weights(plan.sessionId)[0].successes, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('session protection durably blocks feedback before any graph write and leaves other sessions usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incident-protected-'));
  try {
    const state = await StateStore.open(dir, skills);
    await state.saveRun(run);
    await state.feedback({ runId: run.id, sessionId: plan.sessionId, correct: true });
    await state.saveRun({ ...run, id: 'protected-run' });
    const before = state.weights(plan.sessionId), version = state.graphVersion;
    await state.protectSession(plan.sessionId);
    let graphWrites = 0;
    const feedback = { runId: 'protected-run', sessionId: plan.sessionId, correct: false };
    const writer = async () => { graphWrites++; throw new Error('Graph writer must not be invoked'); };
    const forbidden = (error: unknown) => error instanceof Error && 'status' in error && error.status === 403;
    await assert.rejects(state.feedback(feedback, writer), forbidden);
    assert.equal(graphWrites, 0);
    assert.deepEqual(state.weights(plan.sessionId), before);
    assert.equal(state.graphVersion, version);
    const reopened = await StateStore.open(dir, skills);
    await assert.rejects(reopened.feedback(feedback, writer), forbidden);
    assert.deepEqual(reopened.weights(plan.sessionId), before);
    await reopened.saveRun({ ...run, id: 'unprotected-run', plan: { ...plan, sessionId: 'session-b' } });
    const other = await reopened.feedback({ runId: 'unprotected-run', sessionId: 'session-b', correct: false });
    assert.equal(other.after.failures, 2);
    assert.deepEqual(reopened.weights(plan.sessionId), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('existing version-one state without protected sessions preserves its data when protection is added', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incident-state-migration-'));
  try {
    const original = await StateStore.open(dir, skills);
    await original.reserveModel('2026-11-15');
    await original.saveRun(run);
    const file = join(dir, 'state.json');
    const legacy = JSON.parse(await readFile(file, 'utf8'));
    delete legacy.protectedSessions;
    await writeFile(file, JSON.stringify(legacy));
    const reopened = await StateStore.open(dir, skills);
    assert.equal(reopened.budget('2026-11-15').calls, 1);
    assert.equal((await reopened.feedback({ runId: run.id, sessionId: plan.sessionId, correct: true })).after.successes, 2);
    await reopened.protectSession(plan.sessionId);
    const protectedStore = await StateStore.open(dir, skills);
    assert.equal(protectedStore.budget('2026-11-15').calls, 1);
    assert.equal(protectedStore.weights(plan.sessionId)[0].successes, 2);
    await assert.rejects(protectedStore.feedback({ runId: run.id, sessionId: plan.sessionId, correct: false }), /protected session/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
