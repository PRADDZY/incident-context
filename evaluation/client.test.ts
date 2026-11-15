import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpApi } from './client.ts';

test('backend client sends authenticated exact wire requests and never retries HTTP failures', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new HttpApi('http://127.0.0.1:8788', 'unit-test-token', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
  });
  await assert.rejects(client.bootstrap('test-session'), /GET \/api\/bootstrap.*HTTP 503/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8788/api/bootstrap?sessionId=test-session');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer unit-test-token');
});

test('public client never sends backend credentials and preserves HTTP error status', async () => {
  let headers: HeadersInit | undefined;
  const client = new HttpApi('https://example.workers.dev', null, async (_url, init) => {
    headers = init?.headers;
    return new Response('{"error":"quota exhausted"}', { status: 429 });
  });
  await assert.rejects(client.run({ task: 'test', sessionId: 'session', mode: 'all' }), error => error instanceof Error && 'status' in error && error.status === 429);
  assert.equal((headers as Record<string, string>).Authorization, undefined);
});
