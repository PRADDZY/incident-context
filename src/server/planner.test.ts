import test from 'node:test';
import assert from 'node:assert/strict';
import { lexicalScore, taskFamily } from './planner.ts';

test('explicit deployment context resolves ambiguous status wording while explicit providers remain live', () => {
  assert.equal(taskFamily('Check checkout deployment status after the rollout regression'), 'deployment');
  assert.equal(taskFamily('Cloudflare provider status for checkout following a rollout'), 'provider');
  assert.equal(taskFamily('Investigate ledger component outage'), 'provider');
});

test('lexical relevance is normalized and returns zero for unrelated descriptions', () => {
  assert.equal(lexicalScore('deployment rollback', 'deployment rollback'), 1);
  assert.equal(lexicalScore('deployment rollback', 'provider components'), 0);
  assert.ok(lexicalScore('deployment rollback', 'deployment release rollback details') < 1);
});
