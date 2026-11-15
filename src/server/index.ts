import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HydraClient } from './hydra.ts';
import { GraphRepository } from './graph.ts';
import { Planner } from './planner.ts';
import { StateStore } from './state.ts';
import { ToolRunner } from './runner.ts';
import { SKILLS } from './catalog.ts';
import { createApplication } from './app.ts';

async function credential(name: string) {
  const value = process.env[name] ?? (process.env[`${name}_FILE`] ? (await readFile(process.env[`${name}_FILE`]!, 'utf8')).trim() : '');
  if (!value) throw new Error(`${name} or ${name}_FILE is required`);
  return value;
}

const token = await credential('BACKEND_TOKEN');
const engine = new HydraClient({ origin: process.env.HYDRA_URL ?? 'http://127.0.0.1:8443', token: await credential('HYDRA_TOKEN'), namespace: process.env.HYDRA_NAMESPACE ?? 'default', cellId: process.env.HYDRA_CELL_ID ?? 'cell-0' });
const graph = new GraphRepository(engine);
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const state = await StateStore.open(dataDir, SKILLS);
await graph.seed();
const app = createApplication({ token, dataDir, graph, state, planner: new Planner(graph, state), runner: new ToolRunner(), evaluationFile: process.env.EVALUATION_FILE });
const port = Number(process.env.PORT ?? 8788), host = process.env.HOST ?? '127.0.0.1';
app.listen(port, host, () => console.log(`Incident Context backend listening on ${host}:${port}; HydraDB 0.4.0`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => app.close(() => process.exit(0)));
