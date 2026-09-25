import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry, schemaHash, searchTools, validateArguments } from '../src/core.js';

test('registry revisions track additions, removals, and schema changes', () => {
  const registry = new Registry();
  const first = registry.replace('demo', [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]);
  assert.deepEqual(first.added, ['echo']); assert.equal(first.revision, 1);
  const changed = registry.replace('demo', [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'number' } }, required: ['text'] } }, { name: 'branch', description: 'current git branch', inputSchema: { type: 'object' } }]);
  assert.deepEqual(changed.changed, ['echo']); assert.deepEqual(changed.added, ['branch']); assert.equal(changed.revision, 2);
  assert.deepEqual(registry.replace('demo', []).removed, ['echo', 'branch']);
});

test('schemas hash canonically and arguments validate', () => {
  assert.equal(schemaHash({ name: 'x', inputSchema: { b: 2, a: 1 } }), schemaHash({ name: 'x', inputSchema: { a: 1, b: 2 } }));
  const schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] };
  assert.equal(validateArguments(schema, { count: 3 }).length, 0);
  assert.ok(validateArguments(schema, { count: '3' }).length);
});

test('search ranks exact and partial names before descriptions', () => {
  const registry = new Registry();
  registry.replace('demo', [{ name: 'git_branch', description: 'return branch', inputSchema: {} }, { name: 'other', description: 'git current branch selector', inputSchema: {} }]);
  const results = searchTools(registry.list(), 'git_branch');
  assert.equal(results[0]?.name, 'git_branch');
});
