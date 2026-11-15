import type { EvaluationRow, Json, Mode, Observation, Plan, ToolCall } from '../src/shared/contracts.ts';
import { DATASET, type EvaluationTask } from './dataset.ts';

export interface CoverageGrade {
  completePrerequisites: boolean;
  missingTools: string[];
  irrelevantTools: number;
  schemaBytes: number;
  resolutionCorrect: boolean;
}
export interface ObservationGrade { success: boolean; failures: string[] }
export interface CaseMetrics {
  mode: Mode;
  schemaBytes: number | null;
  planLatencyMs: number;
  completePrerequisites: boolean;
  irrelevantTools: number | null;
  executorSuccess: boolean;
  observationSuccess: boolean;
}

// Gold comes from the locked investigation requirements, never the selected skill
// or tool.requires. This detects omitted prerequisite edges rather than endorsing them.
export function gradeCoverage(task: EvaluationTask, plan: Plan): CoverageGrade {
  const expected = DATASET.expectations[task.family];
  const selected = new Set(plan.tools.map(tool => tool.name));
  const missingTools = expected.requiredTools.filter(name => !selected.has(name));
  return {
    completePrerequisites: missingTools.length === 0,
    missingTools,
    irrelevantTools: plan.tools.filter(tool => !expected.usefulTools.includes(tool.name)).length,
    schemaBytes: Buffer.byteLength(JSON.stringify(plan.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))), 'utf8'),
    resolutionCorrect: plan.service.id === task.serviceId && plan.service.resourceId === DATASET.services[task.serviceId].resourceId,
  };
}

const record = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function gradeObservations(task: EvaluationTask, observations: Observation[]): ObservationGrade {
  const failures: string[] = [];
  const successful = (name: string, source: Observation['source']) => observations.filter(observation => observation.tool === name && observation.ok && observation.source === source && Number.isFinite(Date.parse(observation.observedAt))).map(observation => record(observation.result));
  if (task.family === 'deployment') {
    const expected = DATASET.expectations.deployment;
    const service = DATASET.services[task.serviceId];
    const belongs = (result: Record<string, Json>) => result.serviceId === task.serviceId && result.resourceId === service.resourceId && result.simulated === true;
    const metrics = successful('service_metrics', 'sandbox').find(result => belongs(result) && typeof result.errorRate === 'number' && typeof result.baselineErrorRate === 'number' && result.errorRate > result.baselineErrorRate && result.regressionStartedAt === expected.regressionStartedAt);
    const deployment = successful('deployment_details', 'sandbox').find(result => {
      const config = record(result.changedConfig);
      return belongs(result) && result.deploymentId === service.latestDeploymentId && result.changedAt === expected.regressionStartedAt && config.upstreamRetryBudget === expected.retryBudget && config.previousUpstreamRetryBudget === expected.previousRetryBudget && result.rollbackTarget === `dep-${task.serviceId}-20261114` && result.knownRegression === true;
    });
    if (!metrics) failures.push('Missing valid sandbox metrics for the independently expected service/resource and regression time.');
    if (!deployment) failures.push('Missing matching latest deployment, configuration change, or rollback candidate for the expected service.');
  } else {
    const expected = DATASET.expectations.provider;
    const component = successful('component_status', 'live').find(result => result.provider === 'cloudflare' && result.sourceUrl === expected.componentsUrl && result.name === expected.componentName && typeof result.componentId === 'string' && result.componentId.length > 0 && typeof result.status === 'string' && result.status.length > 0);
    const incidents = successful('provider_incidents', 'live').find(result => result.provider === 'cloudflare' && result.sourceUrl === expected.incidentsUrl && Array.isArray(result.incidents));
    if (!component) failures.push('Missing a timestamped live Workers component observation from the fixed Cloudflare source.');
    if (!incidents) failures.push('Missing a timestamped unresolved-incident list from the fixed Cloudflare source.');
  }
  return { success: failures.length === 0, failures };
}

// FIXED workflow policy, not a language model. Identical across all selectors.
// Only graph-resolved identifiers and schemas actually supplied in this plan
// are available. No expected identifier is used to repair an incorrect plan.
export function fixedWorkflowCalls(task: EvaluationTask, plan: Plan): ToolCall[] {
  const available = new Set(plan.tools.map(tool => tool.name));
  const calls: ToolCall[] = [];
  const add = (name: string, args: ToolCall['arguments']) => { if (available.has(name)) calls.push({ name, arguments: args }); };
  const { id: serviceId, resourceId, latestDeploymentId, providerComponentId } = plan.service;
  if (task.family === 'deployment') {
    add('service_metrics', { serviceId, resourceId });
    add('deployments_list', { serviceId });
    if (latestDeploymentId) add('deployment_details', { serviceId, deploymentId: latestDeploymentId });
  } else {
    add('provider_components', { provider: 'cloudflare' });
    if (providerComponentId) add('component_status', { provider: 'cloudflare', componentId: providerComponentId });
    add('provider_incidents', { provider: 'cloudflare' });
  }
  return calls;
}

// Nearest-rank quantiles include HTTP plan round-trip time, not execution time.
export function summarize(mode: Mode, rows: CaseMetrics[], successMetric: 'executorSuccess' | 'observationSuccess' = 'executorSuccess'): EvaluationRow {
  const timings = rows.map(row => row.planLatencyMs).sort((a, b) => a - b);
  const quantile = (p: number) => timings.length ? timings[Math.max(0, Math.ceil(p * timings.length) - 1)] : 0;
  return {
    mode, tasks: rows.length,
    successes: rows.filter(row => row[successMetric]).length,
    completePrerequisites: rows.filter(row => row.completePrerequisites).length,
    meanSchemaBytes: rows.some(row => row.schemaBytes !== null) ? Math.round(rows.reduce((sum, row) => sum + (row.schemaBytes ?? 0), 0) / rows.filter(row => row.schemaBytes !== null).length) : 0,
    irrelevantTools: rows.reduce((sum, row) => sum + (row.irrelevantTools ?? 0), 0),
    p50Ms: quantile(0.5), p95Ms: quantile(0.95),
  };
}
