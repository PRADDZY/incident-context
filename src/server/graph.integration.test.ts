import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HydraClient } from './hydra.ts';
import { GraphRepository } from './graph.ts';
import { Planner } from './planner.ts';
import { StateStore } from './state.ts';
import { SKILLS } from './catalog.ts';
import { GraphSessions } from './sessions.ts';
import { createApplication } from './app.ts';
import { ToolRunner } from './runner.ts';

test('real HydraDB seed is idempotent and bounded planning receipts contain actual supporting edges', { skip: !process.env.HYDRA_URL }, async () => {
  const token = process.env.HYDRA_TOKEN ?? (await readFile(process.env.HYDRA_TOKEN_FILE!, 'utf8')).trim();
  const engine = new HydraClient({ origin: process.env.HYDRA_URL!, token });
  const graph = new GraphRepository(engine);
  await graph.seed();
  const first = await graph.snapshot();
  await graph.seed();
  const second = await graph.snapshot();
  assert.equal(first.nodes.length, second.nodes.length);
  assert.equal(first.edges.length, second.edges.length);
  const dir = await mkdtemp(join(tmpdir(), 'incident-graph-'));
  try {
    const state = await StateStore.open(dir, SKILLS);
    const planner = new Planner(graph, state);
    const plan = await planner.plan({ task: 'checkout deployment regression rollback', sessionId: 'integration-session', mode: 'frozen' });
    assert.equal(plan.service.id, 'northstar-checkout');
    assert.equal(plan.service.resourceId, 'res-northstar-checkout-prod');
    assert.ok(plan.tools.some(t => t.name === 'deployment_details'));
    assert.ok(plan.tools.some(t => t.name === 'deployments_list'));
    assert.ok(plan.schemaBytes <= 4096);
    assert.ok(plan.receipt.queries.some(q => q.cypher.includes('*1..4')));
    assert.ok(plan.receipt.edges.some(e => e.type === 'RESOLVES_TO'));
    assert.ok(plan.receipt.edges.some(e => e.type === 'REQUIRES'));
    const tiny = await planner.plan({ task: 'checkout deployment regression rollback', sessionId: 'integration-session', mode: 'graph', budget: 200 });
    assert.equal(tiny.abstained, true);
    assert.equal(tiny.tools.length, 0);
    const sessions = new GraphSessions(engine);
    const remembered = await sessions.remember('integration-session', plan.service, SKILLS);
    assert.ok(remembered.edges.some(e => e.type === 'REMEMBERS_SERVICE'));
    const feedback = { runId: `integration-${Date.now()}`, sessionId: 'integration-session', correct: false };
    const recorded = await sessions.feedback(feedback, plan, SKILLS);
    const duplicate = await sessions.feedback(feedback, plan, SKILLS);
    assert.equal(recorded.after.failures, duplicate.after.failures);
    assert.equal(recorded.graphVersion, duplicate.graphVersion);
    const fresh = await new GraphSessions(engine).read('integration-session', SKILLS);
    assert.equal(fresh.weights.find(w => w.family === 'deployment' && w.skillId === plan.skill!.id)?.failures, recorded.after.failures);
    assert.ok(fresh.edges.some(e => e.type === 'REMEMBERS_SERVICE'));
    const release = first.nodes.find(n => n.kind === 'tool' && n.key === 'deployment_details')!;
    const list = first.nodes.find(n => n.kind === 'tool' && n.key === 'deployments_list')!;
    await engine.query('MATCH (a:ICEntity {id:$src})-[r:REQUIRES]->(b:ICEntity {id:$dst}) DELETE r', { src: release.id, dst: list.id });
    try {
      const ablated = await planner.plan({ task: 'checkout deployment regression rollback', sessionId: 'integration-session', mode: 'frozen' });
      assert.equal(ablated.abstained, true);
      assert.match(ablated.reason!, /edges are incomplete/);
    } finally { await engine.query('MERGE (a:ICEntity {id:$src})-[:REQUIRES]->(b:ICEntity {id:$dst})', { src: release.id, dst: list.id }); }
    const alias = first.nodes.find(n => n.kind === 'alias' && n.label === 'checkout')!;
    const canonical = first.nodes.find(n => n.kind === 'service' && n.key === plan.service.id)!;
    await engine.query('MATCH (a:ICEntity {id:$src})-[r:RESOLVES_TO]->(b:ICEntity {id:$dst}) DELETE r', { src: alias.id, dst: canonical.id });
    try { await assert.rejects(planner.plan({ task: 'checkout deployment regression rollback', sessionId: 'integration-session', mode: 'frozen' }), /no unique graph resolution/); }
    finally { await engine.query('MERGE (a:ICEntity {id:$src})-[:RESOLVES_TO]->(b:ICEntity {id:$dst})', { src: alias.id, dst: canonical.id }); }
    const app = createApplication({ token: 'integration-only-token', dataDir: dir, graph, planner, state, runner: new ToolRunner() }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => app.once('listening', resolve));
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const headers = { Authorization: 'Bearer integration-only-token', 'Content-Type': 'application/json' };
    const sessionId = `integration-http-${Date.now()}`;
    const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
      assert.equal((await fetch(origin + '/api/health', { headers })).status, 200);
      const planned = await post('/api/plan', { sessionId, task: 'checkout deployment regression rollback', mode: 'graph' });
      assert.equal(planned.status, 200);
      const apiPlan = await planned.json();
      const executed = await post('/internal/execute', { planId: apiPlan.id, sessionId, calls: [{ name: 'service_metrics', arguments: { serviceId: apiPlan.service.id, resourceId: apiPlan.service.resourceId } }, { name: 'deployment_details', arguments: { serviceId: apiPlan.service.id, deploymentId: apiPlan.service.latestDeploymentId } }], usage: { promptTokens: null, completionTokens: null, neurons: null }, requestedModel: 'deterministic-integration-harness', returnedModel: 'deterministic-integration-harness' });
      assert.equal(executed.status, 200);
      const apiRun = await executed.json();
      assert.equal(apiRun.success, true);
      const feedbackResponse = await post('/api/feedback', { sessionId, runId: apiRun.id, correct: apiRun.success });
      assert.equal(feedbackResponse.status, 200);
      const feedback = await feedbackResponse.json();
      assert.equal(feedback.before.successes, 1);
      assert.equal(feedback.after.successes, 2);
      assert.ok(feedback.receipt.queries.some((q: { cypher: string }) => q.cypher.includes('SET s.data')));
      const bootstrap = await (await fetch(origin + `/api/bootstrap?sessionId=${sessionId}`, { headers })).json();
      assert.equal(bootstrap.weights.find((w: { family: string; skillId: string }) => w.family === 'deployment' && w.skillId === apiPlan.skill.id).successes, 2);
      assert.equal((await post('/api/feedback', { sessionId, runId: apiRun.id, correct: true })).status, 409);
    } finally { app.closeAllConnections(); app.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
