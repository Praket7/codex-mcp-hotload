import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manager } from '../src/manager.ts';

test('reload and mid-session removal emit one-line catalog diagnostics', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hotload-log-'));
  const configPath = join(home, 'config.json');
  const statePath = join(home, 'version');
  const fixture = fileURLToPath(new URL('./fixtures/changing-server.mjs', import.meta.url));
  const originalConfig = process.env.CODEX_MCP_HOTLOAD_CONFIG;
  const originalWrite = process.stderr.write;
  let output = '';
  process.env.CODEX_MCP_HOTLOAD_CONFIG = configPath;
  process.stderr.write = ((chunk, encodingOrCallback, callback) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.();
    return true;
  });
  const config = { version: 1, servers: { fixture: { transport: 'stdio', command: process.execPath, args: [fixture], env: { FIXTURE_STATE: statePath } } } };
  const manager = new Manager(config.servers);
  const events = () => output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  try {
    await writeFile(statePath, '1');
    await writeFile(configPath, JSON.stringify(config));
    await manager.reload('fixture');
    let event = events().at(-1);
    assert.equal(event.event, 'mcp.catalog.reload');
    assert.equal(event.outcome, 'ok');
    assert.equal(event.beforeCount, 0);
    assert.equal(event.afterCount, 2);
    assert.deepEqual(event.added, ['crash_child', 'echo']);

    await writeFile(statePath, '2');
    await manager.reload('fixture');
    event = events().at(-1);
    assert.equal(event.beforeCount, 2);
    assert.equal(event.afterCount, 3);
    assert.deepEqual(event.added, ['git_branch']);
    assert.deepEqual(event.removed, []);

    const configWithoutChild = { version: 1, servers: {} };
    await writeFile(configPath, JSON.stringify(configWithoutChild));
    await manager.refreshConfig();
    event = events().at(-1);
    assert.equal(event.event, 'mcp.server.removed');
    assert.equal(event.reason, 'config_removed');
    assert.equal(event.beforeCount, 3);
    assert.equal(event.afterCount, 0);
    assert.deepEqual(event.removed, ['crash_child', 'echo', 'git_branch']);

    const broken = structuredClone(config);
    broken.servers.fixture.command = join(home, 'missing-command');
    await writeFile(configPath, JSON.stringify(broken));
    await manager.refreshConfig();
    event = events().at(-1);
    assert.equal(event.event, 'mcp.catalog.reload');
    assert.equal(event.outcome, 'failed');
    assert.equal(event.server, 'fixture');
    assert.equal(typeof event.errorType, 'string');
    assert.ok(events().every((entry) => !('description' in entry) && !('arguments' in entry)));
  } finally {
    await manager.close();
    process.stderr.write = originalWrite;
    if (originalConfig === undefined) delete process.env.CODEX_MCP_HOTLOAD_CONFIG;
    else process.env.CODEX_MCP_HOTLOAD_CONFIG = originalConfig;
    await rm(home, { recursive: true, force: true });
  }
});
