import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES, TOOLS, SKILLS, schemaBytes, prerequisiteClosure } from './catalog.ts';

test('catalog has four distinct canonical services and twelve usable tool schemas', () => {
  assert.equal(TOOLS.length, 12);
  assert.equal(SERVICES.length, 4);
  assert.equal(new Set(SERVICES.map(s => s.resourceId)).size, 4);
  assert.ok(TOOLS.every(t => t.parameters.additionalProperties === false));
  assert.equal(schemaBytes(TOOLS), Buffer.byteLength(JSON.stringify(TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }))), 'utf8'));
  assert.ok(schemaBytes(TOOLS) > 4096);
  for (const skill of SKILLS) {
    const bundle = prerequisiteClosure(skill.tools, TOOLS);
    assert.ok(schemaBytes(bundle) <= 4096, `${skill.id} must fit the context limit`);
    assert.ok(bundle.every(tool => tool.requires.every(name => bundle.some(t => t.name === name))));
  }
});
