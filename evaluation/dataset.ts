import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import data from './dataset.json' with { type: 'json' };
import type { Family } from '../src/shared/contracts.ts';

export const DATASET_SHA256 = '3c16994b42a6d3387b04cc6eb62eac0223a6722315d1d869cfdabee9b3c21076';
export interface EvaluationTask { id: string; split: 'train' | 'heldout'; family: Family; serviceId: string; alias: string; task: string }
export interface ExpectedService { name: string; aliases: string[]; resourceId: string; latestDeploymentId: string }
export const DATASET = data as Omit<typeof data, 'tasks' | 'services'> & { tasks: EvaluationTask[]; services: Record<string, ExpectedService> };
export const TRAINING_TASKS = DATASET.tasks.filter(task => task.split === 'train');
export const HELDOUT_TASKS = DATASET.tasks.filter(task => task.split === 'heldout');
export async function assertDatasetLocked(): Promise<void> {
  const bytes = await readFile(new URL('./dataset.json', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== DATASET_SHA256) throw new Error('Dataset hash mismatch: stop before training or evaluation.');
  const lock = await readFile(new URL('./dataset.sha256', import.meta.url), 'utf8');
  if (lock.trim() !== `${DATASET_SHA256}  dataset.json`) throw new Error('Dataset lock manifest mismatch.');
}
