import { execFileSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { nativeReload } from '../dist/codex.js';

const codex = process.env.CODEX_BIN ?? 'codex';
const root = resolve(import.meta.dirname, '..');
const home = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'hl-'));
const bridgeConfig = join(home, 'bridge.json');
const appConfig = join(home, 'config.toml');
const fixtureState = join(home, 'fixture-version');
const useUnixSocket = process.platform !== 'win32';
const controlSocket = join(home, 'app-server-control', 'app-server-control.sock');
const endpoint = useUnixSocket ? { socketPath: controlSocket } : { url: `ws://127.0.0.1:${await freePort()}` };
const listenUrl = useUnixSocket ? `unix://${controlSocket}` : endpoint.url;
let child;
let ws;
let nextId = 0;
const pending = new Map();
const notify = [];
try {
  await mkdir(join(home, 'project'));
  await writeFile(fixtureState, '1');
  await writeFile(bridgeConfig, JSON.stringify({ version: 1, servers: {} }));
  await writeFile(appConfig, `[mcp_servers.codex-mcp-hotload]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(root, 'dist/cli.js'))}, "serve"]\n[mcp_servers.codex-mcp-hotload.env]\nCODEX_MCP_HOTLOAD_CONFIG = ${JSON.stringify(bridgeConfig)}\nFIXTURE_STATE = ${JSON.stringify(fixtureState)}\n`);
  const port = endpoint.url ? new URL(endpoint.url).port : undefined;
  child = spawn(codex, ['app-server', '--listen', listenUrl], { env: { ...process.env, CODEX_HOME: home, CODEX_CONFIG: appConfig, FIXTURE_STATE: fixtureState }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-6000); });
  await waitFor(async () => { if (useUnixSocket) { try { await access(controlSocket); return true; } catch { return false; } } try { const response = await fetch(`http://127.0.0.1:${port}/readyz`); return response.ok; } catch { return false; } }, 30_000, () => stderr);
  ws = useUnixSocket ? new WebSocket('ws://localhost', { createConnection: () => createConnection(controlSocket), perMessageDeflate: false }) : new WebSocket(endpoint.url);
  ws.on('message', (data) => { const message = JSON.parse(data.toString()); if (message.id !== undefined) { const item = pending.get(message.id); if (item) { pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); } } else notify.push(message); });
  await new Promise((resolveOpen, reject) => { ws.once('open', resolveOpen); ws.once('error', reject); });
  const rpc = (method, params = {}) => new Promise((resolveRpc, reject) => { const id = ++nextId; pending.set(id, { resolve: resolveRpc, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout ${method}`)); } }, 15_000).unref(); });
  await rpc('initialize', { clientInfo: { name: 'hotload-e2e', version: '1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  const thread = await rpc('thread/start', { cwd: join(home, 'project'), ephemeral: true });
  const threadId = thread.thread.id;
  let lastStatus;
  await waitFor(async () => { lastStatus = await rpc('mcpServerStatus/list', {}); const items = lastStatus.data ?? lastStatus.servers ?? []; return items.some((item) => item.name === 'codex-mcp-hotload' && item.tools && Object.keys(item.tools).length >= 5); }, 20_000, () => `${JSON.stringify(lastStatus)}\n${stderr}`);
  const call = async (server, tool, args = {}) => rpc('mcpServer/tool/call', { threadId, server, tool, arguments: args });
  execFileSync(process.execPath, [join(root, 'dist/cli.js'), 'add', 'fixture', '--cwd', root, '--', process.execPath, join(root, 'tests/fixtures/changing-server.mjs')], { env: { ...process.env, CODEX_MCP_HOTLOAD_CONFIG: bridgeConfig } });
  const childConfig = JSON.parse(await readFile(bridgeConfig, 'utf8')); childConfig.servers.fixture.maxRestartAttempts = 3; await writeFile(bridgeConfig, JSON.stringify(childConfig));
  const search1 = await call('codex-mcp-hotload', 'hotload_search_tools', { query: 'echo', server: 'fixture' });
  assert(findText(search1).includes('echo'), 'v1 echo tool discoverable');
  const echo1 = await call('codex-mcp-hotload', 'hotload_call_tool', { server: 'fixture', tool: 'echo', arguments: { text: 'v1' } });
  assert(findText(echo1).includes('v1'), `v1 echo executes: ${findText(echo1)}`);
  await writeFile(fixtureState, '2');
  const reload2 = await call('codex-mcp-hotload', 'hotload_reload_server', { server: 'fixture' });
  assert(findText(reload2).includes('git_branch'), 'child reload adds git_branch');
  const search2 = await call('codex-mcp-hotload', 'hotload_search_tools', { query: 'git branch', server: 'fixture' });
  assert(findText(search2).includes('git_branch'), 'same thread sees new tool');
  const native = await nativeReload(endpoint, 'codex-mcp-hotload');
  assert(native.verified, 'native Codex reload/status verifies bridge remains connected');
  const branch = await call('codex-mcp-hotload', 'hotload_call_tool', { server: 'fixture', tool: 'git_branch', arguments: {} });
  assert(findText(branch).includes('main'), 'new tool executes in same thread');
  const oldEcho = JSON.parse(search1.content.find((part) => part.type === 'text').text).matches.find((tool) => tool.name === 'echo');
  await writeFile(fixtureState, '3');
  await call('codex-mcp-hotload', 'hotload_reload_server', { server: 'fixture' });
  const stale = await call('codex-mcp-hotload', 'hotload_call_tool', { server: 'fixture', tool: 'echo', arguments: { text: 'stale' }, expectedSchemaHash: oldEcho.schemaHash });
  assert(findText(stale).includes('STALE_SCHEMA'), `stale schema is rejected: ${findText(stale)}`);
  const echo3 = await call('codex-mcp-hotload', 'hotload_call_tool', { server: 'fixture', tool: 'echo', arguments: { text: 7 } });
  assert(findText(echo3).includes('7'), 'updated schema executes');
  await call('codex-mcp-hotload', 'hotload_call_tool', { server: 'fixture', tool: 'crash_child', arguments: {} }).catch(() => undefined);
  await waitFor(async () => { const r = await call('codex-mcp-hotload', 'hotload_server_status', { server: 'fixture' }); const status = JSON.parse(findText(r)); return status.state === 'ready' && status.restartCount >= 1; }, 10_000);
  await writeFile(fixtureState, 'crash-loop');
  await call('codex-mcp-hotload', 'hotload_call_tool', { server: 'fixture', tool: 'crash_child', arguments: {} }).catch(() => undefined);
  let finalChildStatus;
  await waitFor(async () => { const r = await call('codex-mcp-hotload', 'hotload_server_status', { server: 'fixture' }); finalChildStatus = JSON.parse(findText(r)); return finalChildStatus.state === 'failed' && finalChildStatus.recoveryAttempt === 3; }, 15_000);
  assert((await rpc('thread/read', { threadId })).thread.id === threadId, 'thread ID remains the same across reloads');
  console.log(JSON.stringify({ passed: true, threadId, boundedCrashRecovery: finalChildStatus.recoveryAttempt, phases: ['register child after thread start', 'initial discovery and call', 'child catalog update', 'same-thread discovery and call', 'native reload and status verification', 'stale schema rejection', 'updated-schema call', 'crash recovery', 'bounded crash-loop stop'] }, null, 2));
} finally {
  ws?.close(); child?.kill('SIGTERM');
  if (child) await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(2000)]);
  child?.kill('SIGKILL'); await rm(home, { recursive: true, force: true });
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function findText(value) { return value.content?.map((part) => part.text ?? '').join('\n') ?? JSON.stringify(value); }
async function waitFor(predicate, timeout, errorText = () => '') { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await delay(200); } throw new Error(`Timed out waiting for app-server${typeof errorText === 'function' ? `: ${errorText()}` : ''}`); }
async function freePort() { const net = await import('node:net'); const server = net.createServer(); await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen)); const port = server.address().port; await new Promise((resolveClose) => server.close(resolveClose)); return port; }
