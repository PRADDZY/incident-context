import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HydraClient } from './hydra.ts';

test('Hydra HTTP adapter sends scoped authenticated scalar queries and decodes typed rows', async () => {
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-engine-token');
    assert.equal(req.headers['x-graph-namespace'], 'default');
    let body = ''; for await (const chunk of req) body += chunk;
    const { query_id, ...query } = JSON.parse(body);
    assert.equal(typeof query_id, 'string');
    assert.ok(query_id.length > 0);
    assert.deepEqual(query, { cell_id: 'cell-0', query: 'MATCH (n {id:$id}) RETURN n.id AS id', parameters: { id: 42 } });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ columns: ['id', 'name', 'active', 'missing'], rows: [[{ type: 'vertex_id', value: 42 }, { type: 'string', value: 'Cedar' }, { type: 'boolean', value: true }, { type: 'null' }]], read_epoch: 3 }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  try {
    const engine = new HydraClient({ origin: `http://127.0.0.1:${address.port}`, token: 'test-engine-token' });
    const result = await engine.query('MATCH (n {id:$id}) RETURN n.id AS id', { id: 42 });
    assert.deepEqual(result.rows, [{ id: 42, name: 'Cedar', active: true, missing: null }]);
    assert.equal(result.receipt.rows, 1);
    assert.ok(result.receipt.durationMs >= 0);
  } finally { server.close(); }
});

test('Hydra query errors are surfaced without manufacturing rows', async () => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end('offline'); }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  try {
    const engine = new HydraClient({ origin: `http://127.0.0.1:${address.port}`, token: 'secret' });
    await assert.rejects(engine.query('RETURN 1'), /HydraDB.*503/);
  } finally { server.close(); }
});

test('query identities survive independent clients without relying on the engine process counter', async () => {
  const identities: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const query = JSON.parse(body);
    // Persisted engine mutation receipts reject a reused identity after restart.
    if (typeof query.query_id !== 'string' || identities.includes(query.query_id)) {
      res.writeHead(409); res.end('mutation identity conflict'); return;
    }
    identities.push(query.query_id);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ columns: [], rows: [] }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await new HydraClient({ origin, token: 'test' }).query('MERGE (a {id:$src})-[:TEST]->(b {id:2})', { src: 1 });
    await new HydraClient({ origin, token: 'test' }).query('MERGE (a {id:$src})-[:TEST]->(b {id:2})', { src: 3 });
    assert.equal(identities.length, 2);
    assert.notEqual(identities[0], identities[1]);
  } finally { server.closeAllConnections(); server.close(); }
});

test('an unresponsive engine query is aborted and remains unavailable', { timeout: 3000 }, async () => {
  const server = createServer(() => { /* Hold the response open until the client aborts. */ }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const engine = new HydraClient({ origin, token: 'test', timeoutMs: 50 });
    await assert.rejects(engine.query('RETURN 1'), /unreachable or query timed out/);
  } finally { server.closeAllConnections(); server.close(); }
});
