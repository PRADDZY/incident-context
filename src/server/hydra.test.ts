import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HydraClient } from './hydra.ts';

test('Hydra HTTP adapter sends scoped authenticated scalar queries and decodes typed rows', async () => {
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-engine-token');
    assert.equal(req.headers['x-graph-namespace'], 'default');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { cell_id: 'cell-0', query: 'MATCH (n {id:$id}) RETURN n.id AS id', parameters: { id: 42 } });
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
