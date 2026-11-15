import type { Json, Plan, ToolCall, Usage } from "../shared/contracts.ts";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const MODES = new Set(["all", "lexical", "frozen", "graph"]);
const ROUTES = new Map([
  ["/api/bootstrap", "GET"], ["/api/health", "GET"], ["/api/evaluation", "GET"],
  ["/api/plan", "POST"], ["/api/run", "POST"], ["/api/feedback", "POST"],
]);

type ModelInput = ReturnType<typeof modelInput>;
interface Services {
  backend(path: string, init?: RequestInit): Promise<unknown>;
  infer(input: ModelInput): Promise<unknown>;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resultOf(value: unknown): Record<string, unknown> {
  const valueRecord = record(value);
  return valueRecord.result !== undefined ? record(valueRecord.result) : valueRecord;
}

export function normalizeCalls(value: unknown): ToolCall[] {
  const result = resultOf(value);
  const choices = Array.isArray(result.choices) ? result.choices : [];
  const message = record(record(choices[0]).message);
  const source = result.tool_calls ?? message.tool_calls ?? [];
  if (!Array.isArray(source) || source.length > 4) throw new ApiError(502, "Model returned an invalid tool-call count.");
  return source.map((item: unknown) => {
    const row = record(item);
    const call = row.function ? record(row.function) : row;
    let args: unknown = call.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); }
      catch { throw new ApiError(502, "Model returned malformed tool arguments."); }
    }
    if (typeof call.name !== "string" || args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new ApiError(502, "Model returned invalid tool arguments.");
    }
    return { name: call.name, arguments: args as Record<string, Json> };
  });
}

export function readUsage(value: unknown): Usage {
  const usage = record(resultOf(value).usage);
  const finite = (input: unknown): number | null => typeof input === "number" && Number.isFinite(input) ? input : null;
  return { promptTokens: finite(usage.prompt_tokens), completionTokens: finite(usage.completion_tokens), neurons: finite(usage.neurons) };
}

export function modelInput(plan: Plan) {
  return {
    messages: [
      { role: "system" as const, content: "You are a read-only incident investigator. Choose up to four supplied tools that obtain the observations needed for the request. Use the exact canonical IDs from graph context. Never invent IDs, tool names, or observations. Supply every required argument and no undeclared arguments. Request the applicable tool calls together; do not write a narrative instead. Tool prerequisites and canonical resource identities have already been resolved by the graph." },
      { role: "user" as const, content: `${plan.task}\nGraph context: ${JSON.stringify({ service: plan.service, resolvedEntities: plan.resolvedEntities })}` },
    ],
    tools: plan.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    max_tokens: 256,
    temperature: 0,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function readText(message: Request | Response, limit: number): Promise<string> {
  if (!message.body) return "";
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new ApiError(413, "Request or response exceeds the allowed size."); }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(combined);
}

export async function handleApi(request: Request, services: Services): Promise<Response> {
  try {
    const url = new URL(request.url);
    const method = ROUTES.get(url.pathname);
    if (!method) return json({ error: "Route not found." }, 404);
    if (request.method !== method) return json({ error: "Method not allowed." }, 405);
    if (method === "GET") {
      if (url.search.length > 256) return json({ error: "Query too long." }, 400);
      return json(await services.backend(url.pathname + url.search));
    }
    let body: Record<string, unknown>;
    try { body = record(JSON.parse(await readText(request, 4096))); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, "Expected a JSON request."); }
    if (url.pathname !== "/api/feedback") {
      if (typeof body.task !== "string" || body.task.length < 3 || body.task.length > 1200 ||
          typeof body.sessionId !== "string" || !/^[A-Za-z0-9_-]{3,80}$/.test(body.sessionId) ||
          (body.mode !== undefined && !MODES.has(String(body.mode))) ||
          (body.budget !== undefined && (!Number.isInteger(body.budget) || Number(body.budget) < 1 || Number(body.budget) > 16384))) {
        throw new ApiError(400, "Provide a task, valid session, mode and context budget.");
      }
    }
    if (url.pathname !== "/api/run") return json(await services.backend(url.pathname, { method: "POST", body: JSON.stringify(body) }));
    const plan = await services.backend("/api/plan", { method: "POST", body: JSON.stringify(body) }) as Plan;
    if (plan.abstained) return json({ error: plan.reason ?? "No complete context bundle fits.", plan }, 422);
    const input = modelInput(plan);
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 16384) throw new ApiError(413, "Model input exceeds the 16 KiB application limit.");
    await services.backend("/internal/reserve-model", { method: "POST", body: JSON.stringify({ sessionId: body.sessionId }) });
    const output = await services.infer(input);
    const calls = normalizeCalls(output);
    const result = resultOf(output);
    const run = await services.backend("/internal/execute", {
      method: "POST",
      body: JSON.stringify({ planId: plan.id, sessionId: body.sessionId, calls, usage: readUsage(output), requestedModel: MODEL, returnedModel: typeof result.model === "string" ? result.model : "not reported" }),
    });
    return json(run);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    return json({ error: "Service unavailable. The graph origin or model could not complete this request." }, 503);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.BACKEND_TOKEN || env.BACKEND_ORIGIN.includes("not-configured.invalid")) return json({ error: "Graph origin is not configured." }, 503);
    return handleApi(request, {
      backend: async (path, init) => {
        const response = await fetch(new URL(path, env.BACKEND_ORIGIN), {
          ...init, signal: AbortSignal.timeout(20000),
          headers: { "Authorization": `Bearer ${env.BACKEND_TOKEN}`, "Content-Type": "application/json" },
        });
        const text = await readText(response, 512 * 1024);
        let body: unknown;
        try { body = JSON.parse(text); } catch { throw new ApiError(503, "Graph origin returned an invalid response."); }
        if (!response.ok) throw new ApiError(response.status, typeof record(body).error === "string" ? String(record(body).error) : "Graph origin rejected the request.");
        return body;
      },
      infer: (input) => env.AI.run(MODEL, input),
    });
  },
} satisfies ExportedHandler<Env>;
