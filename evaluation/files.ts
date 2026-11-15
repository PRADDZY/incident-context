import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function claimOutput(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, 'wx');
  await file.close();
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
