import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan } from "../shared/contracts.ts";
import { handleApi, modelInput, normalizeCalls, readUsage } from "./index.ts";

const plan: Plan = {
  id: "plan-1", sessionId: "session-1", task: "Inspect checkout errors", mode: "graph", family: "deployment",
  service: { id: "northstar-checkout", name: "Northstar Checkout", aliases: ["checkout"], resourceId: "res-northstar-checkout-prod", environment: "production" },
  skill: null,
  tools: [{ id: "metrics", name: "service_metrics", description: "Read service metrics", parameters: { type: "object", properties: { service_id: { type: "string" } }, required: ["service_id"], additionalProperties: false }, source: "sandbox", requires: [], server: "observability" }],
  schemaBytes: 200, fullSchemaBytes: 1200, savedPercent: 83.3,
  resolvedEntities: [{ alias: "checkout", canonicalId: "northstar-checkout", resourceId: "res-northstar-checkout-prod" }],
  receipt: { engine: "HydraDB", engineVersion: "0.4.0", queries: [], nodes: [], edges: [], durationMs: 1, graphVersion: 1 },
  abstained: false, reason: null,
};

test("preserves normalized calls without correcting model arguments", () => {
  const calls = normalizeCalls({ tool_calls: [{ name: "service_metrics", arguments: { service_id: "wrong" } }] });
  assert.deepEqual(calls, [{ name: "service_metrics", arguments: { service_id: "wrong" } }]);
});

test("decodes standard OpenAI tool arguments", () => {
  assert.deepEqual(normalizeCalls({ choices: [{ message: { tool_calls: [{ function: { name: "service_metrics", arguments: '{"service_id":"northstar-checkout"}' } }] } }] }),
    [{ name: "service_metrics", arguments: { service_id: "northstar-checkout" } }]);
});

test("rejects malformed arguments and excess calls", () => {
  assert.throws(() => normalizeCalls({ tool_calls: [{ name: "service_metrics", arguments: "bad-json" }] }));
  assert.throws(() => normalizeCalls({ tool_calls: Array.from({ length: 5 }, () => ({ name: "metrics", arguments: {} })) }));
});

test("keeps missing usage as null instead of estimating it", () => {
  assert.deepEqual(readUsage({}), { promptTokens: null, completionTokens: null, neurons: null });
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 298, completion_tokens: 27, neurons: 2.168 } }),
    { promptTokens: 298, completionTokens: 27, neurons: 2.168 });
});

test("model context carries graph-resolved identities and excludes receipts", () => {
  const input = modelInput(plan);
  assert.match(JSON.stringify(input.messages), /northstar-checkout/);
  assert.equal(input.tools[0].name, "service_metrics");
  assert.equal(input.max_tokens, 256);
  assert.equal(input.temperature, 0);
  assert.doesNotMatch(JSON.stringify(input), /graphVersion|query_id/);
});

test("unsupported modes are rejected before backend or model work", async () => {
  let touched = false;
  const response = await handleApi(new Request("https://example.test/api/run", { method: "POST", body: JSON.stringify({ task: "inspect", sessionId: "session-1", mode: "unknown" }) }), {
    backend: async () => { touched = true; return plan; }, infer: async () => { touched = true; return {}; },
  });
  assert.equal(response.status, 400);
  assert.equal(touched, false);
});

test("reserves the call before inference and passes actual usage to execution", async () => {
  const events: string[] = [];
  let execution: Record<string, unknown> = {};
  const response = await handleApi(new Request("https://example.test/api/run", { method: "POST", body: JSON.stringify({ task: plan.task, sessionId: "session-1", mode: "graph" }) }), {
    backend: async (path, init) => {
      events.push(path);
      if (path === "/api/plan") return plan;
      if (path === "/internal/reserve-model") return { allowed: true };
      execution = JSON.parse(String(init?.body));
      return { id: "run-1", answer: "observed", usage: execution.usage };
    },
    infer: async () => { events.push("infer"); return { model: "actual-model", tool_calls: [{ name: "service_metrics", arguments: { service_id: "northstar-checkout" } }], usage: { prompt_tokens: 10, completion_tokens: 5, neurons: 0.2 } }; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(events, ["/api/plan", "/internal/reserve-model", "infer", "/internal/execute"]);
  assert.deepEqual(execution.usage, { promptTokens: 10, completionTokens: 5, neurons: 0.2 });
  assert.equal(execution.returnedModel, "actual-model");
});

test("abstention does not reserve or call the model", async () => {
  let calls = 0;
  const response = await handleApi(new Request("https://example.test/api/run", { method: "POST", body: JSON.stringify({ task: plan.task, sessionId: "session-1" }) }), {
    backend: async () => { calls++; return { ...plan, abstained: true, reason: "budget too small" }; },
    infer: async () => { throw new Error("must not run"); },
  });
  assert.equal(response.status, 422);
  assert.equal(calls, 1);
});

test("invalid model JSON is reported as a model failure without execution", async () => {
  let executed = false;
  const response = await handleApi(new Request("https://example.test/api/run", { method: "POST", body: JSON.stringify({ task: plan.task, sessionId: "session-1" }) }), {
    backend: async (path) => {
      if (path === "/api/plan") return plan;
      if (path === "/internal/execute") executed = true;
      return {};
    },
    infer: async () => ({ tool_calls: [{ name: "service_metrics", arguments: "broken json" }] }),
  });
  assert.equal(response.status, 502);
  assert.equal(executed, false);
});

test("backend failure becomes an explicit unavailable response", async () => {
  const response = await handleApi(new Request("https://example.test/api/health"), {
    backend: async () => { throw new Error("origin unavailable"); }, infer: async () => ({}),
  });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /unavailable/);
});
