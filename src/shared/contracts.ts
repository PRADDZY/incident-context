export type Mode = "all" | "lexical" | "frozen" | "graph";
export type Family = "deployment" | "provider";
export type Source = "sandbox" | "live";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, Json>; required: string[]; additionalProperties: false };
  source: Source;
  requires: string[];
  server: string;
}

export interface Service {
  id: string;
  name: string;
  aliases: string[];
  resourceId: string;
  environment: string;
  providerComponentId?: string;
  providerComponentName?: string;
  providerComponentSource?: string;
  latestDeploymentId?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  family: Family;
  tools: string[];
}

export interface GraphNode {
  id: number;
  key: string;
  kind: "alias" | "service" | "resource" | "skill" | "tool" | "server" | "session";
  label: string;
}

export interface GraphEdge {
  from: number;
  to: number;
  type: string;
  label: string;
}

export interface QueryReceipt {
  cypher: string;
  parameters: Record<string, string | number | boolean>;
  rows: number;
  durationMs: number;
}

export interface GraphReceipt {
  engine: "HydraDB";
  engineVersion: string;
  queries: QueryReceipt[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  durationMs: number;
  graphVersion: number;
}

export interface PlanRequest {
  task: string;
  sessionId: string;
  mode?: Mode;
  budget?: number;
}

export interface Plan {
  id: string;
  sessionId: string;
  task: string;
  mode: Mode;
  family: Family;
  service: Service;
  skill: Skill | null;
  tools: ToolDefinition[];
  schemaBytes: number;
  fullSchemaBytes: number;
  savedPercent: number;
  resolvedEntities: { alias: string; canonicalId: string; resourceId: string }[];
  receipt: GraphReceipt;
  abstained: boolean;
  reason: string | null;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, Json>;
}

export interface Observation {
  tool: string;
  source: Source;
  ok: boolean;
  result: Json;
  error: string | null;
  durationMs: number;
  observedAt: string;
}

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  neurons: number | null;
}

export interface AgentRun {
  id: string;
  plan: Plan;
  calls: ToolCall[];
  observations: Observation[];
  answer: string;
  success: boolean | null;
  reason: string | null;
  usage: Usage;
  requestedModel: string;
  returnedModel: string;
  createdAt: string;
  durationMs: number;
  totalDurationMs?: number;
}

export interface Weight {
  family: Family;
  skillId: string;
  successes: number;
  failures: number;
  usefulness: number;
}

export interface Feedback {
  runId: string;
  sessionId: string;
  correct: boolean;
}

export interface FeedbackResult {
  before: Weight;
  after: Weight;
  graphVersion: number;
  recordedAt: string;
  receipt?: GraphReceipt;
}

export interface Scenario {
  id: string;
  title: string;
  task: string;
  family: Family;
  source: Source;
}

export interface Bootstrap {
  product: "Incident Context";
  engine: { status: "ready" | "unavailable"; version: string };
  tools: ToolDefinition[];
  services: Service[];
  skills: Skill[];
  scenarios: Scenario[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  weights: Weight[];
  graphVersion: number;
  budget: { day: string; calls: number; limit: number };
}

export interface EvaluationRow {
  mode: Mode;
  tasks: number;
  successes: number;
  completePrerequisites: number;
  meanSchemaBytes: number;
  irrelevantTools: number;
  p50Ms: number;
  p95Ms: number;
}

export interface EvaluationReport {
  status: "pending" | "complete";
  generatedAt: string | null;
  datasetHash: string | null;
  trainingTasks: number;
  heldoutTasks: number;
  graphVersion: number;
  rows: EvaluationRow[];
  curve: { checkpoint: number; tasks: number; successes: number; meanSchemaBytes: number }[];
  notes: string[];
  live?: { tasks: number; rows: { mode: Mode; successes: number; runIds: string[] }[] };
}
