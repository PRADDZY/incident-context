import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
