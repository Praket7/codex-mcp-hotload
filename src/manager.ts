import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import chokidar, { type FSWatcher } from 'chokidar';
import { readConfig, type ChildConfig } from './config.js';
import { canonicalJson, Registry } from './core.js';

const DEFAULT_MAX_RESTART_ATTEMPTS = 5;
const logCatalogEvent = (event: string, details: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ event, timestamp: new Date().toISOString(), ...details })}\n`);
const sorted = (names: string[]) => [...names].sort();
type Managed = { config: ChildConfig; client: Client | undefined;  watcher: FSWatcher | undefined; state: string; lastReload: string | undefined; lastError: string | undefined; stderr: string[]; restartCount: number; startedAt: number | undefined; recoveryAttempt: number; recoveryTimer: NodeJS.Timeout | undefined; lock: Promise<unknown> };

export class Manager {
  readonly registry = new Registry();
  readonly #servers = new Map<string, Managed>();
  #configSync: Promise<void> = Promise.resolve();
  constructor(readonly definitions: Record<string, ChildConfig>) {
    for (const [name, config] of Object.entries(definitions)) this.#servers.set(name, { config, client: undefined, watcher: undefined, state: 'stopped', lastReload: undefined, lastError: undefined, stderr: [], restartCount: 0, startedAt: undefined, recoveryAttempt: 0, recoveryTimer: undefined, lock: Promise.resolve() });
  }
  names() { return [...this.#servers.keys()]; }
  refreshConfig() {
    const operation = this.#configSync.then(async () => {
      const latest = (await readConfig()).servers;
      for (const name of this.names()) if (!(name in latest)) {
        const beforeCount = this.registry.list(name).length;
        await this.stop(name);
        const diff = this.registry.replace(name, []);
        logCatalogEvent('mcp.server.removed', { server: name, reason: 'config_removed', beforeCount, afterCount: 0, removed: sorted(diff.removed), revision: diff.revision });
        this.#servers.delete(name);
      }
      const reload = new Set<string>();
      for (const [name, config] of Object.entries(latest)) {
        const existing = this.#servers.get(name);
        if (!existing) {
          this.#servers.set(name, { config, client: undefined, watcher: undefined, state: 'stopped', lastReload: undefined, lastError: undefined, stderr: [], restartCount: 0, recoveryAttempt: 0, recoveryTimer: undefined, startedAt: undefined, lock: Promise.resolve() });
          reload.add(name);
        } else if (canonicalJson(existing.config) !== canonicalJson(config)) {
          existing.config = config;
          reload.add(name);
        }
      }
      await Promise.allSettled([...reload].map((name) => this.reload(name)));
    });
    this.#configSync = operation.catch(() => undefined);
    return operation;
  }

  async startAll() { await Promise.allSettled(this.names().map((name) => this.reload(name))); }
  async close() { await Promise.all(this.names().map((name) => this.stop(name))); }
  async reload(name: string, build = true) {
    const server = this.#servers.get(name); if (!server) throw new Error(`Unknown server: ${name}`);
    const operation = server.lock.then(async () => {
      const startedAt = Date.now();
      const beforeCount = this.registry.list(name).length;
      let diff: ReturnType<Registry['replace']> | undefined;
      server.state = build && server.config.build ? 'building' : 'restarting';
      try {
        if (build && server.config.build) await this.#runBuild(server);
        await this.#stop(server, name);
        server.state = 'starting';
        const { client } = await this.#connect(server);
        if (server.startedAt) server.restartCount++;
        server.client = client; server.state = 'ready'; clearTimeout(server.recoveryTimer); server.recoveryTimer = undefined; server.lastReload = new Date().toISOString(); server.startedAt = Date.now(); server.lastError = undefined;
        const response = await withTimeout(client.listTools(), server.config.startupTimeoutMs ?? 10_000, `Discovering tools for ${name}`);
        diff = this.registry.replace(name, response.tools.map((tool) => ({ name: tool.name, ...(tool.title ? { title: tool.title } : {}), ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema as Record<string, unknown>, ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}) })));
        if (build) server.recoveryAttempt = 0;
        logCatalogEvent('mcp.catalog.reload', { server: name, trigger: build ? 'reload' : 'recovery', outcome: 'ok', beforeCount, afterCount: response.tools.length, added: sorted(diff.added), removed: sorted(diff.removed), changed: sorted(diff.changed), revision: diff.revision, durationMs: Date.now() - startedAt });
        return diff;
      } catch (error) {
        server.lastError = (error as Error).message;
        if (server.client && server.state === 'building') server.state = 'ready';
        else { server.state = 'failed'; diff = this.registry.replace(name, []); }
        logCatalogEvent('mcp.catalog.reload', { server: name, trigger: build ? 'reload' : 'recovery', outcome: 'failed', beforeCount, afterCount: this.registry.list(name).length, added: sorted(diff?.added ?? []), removed: sorted(diff?.removed ?? []), changed: sorted(diff?.changed ?? []), revision: diff?.revision ?? this.registry.list(name)[0]?.revision ?? 0, durationMs: Date.now() - startedAt, errorType: error instanceof Error ? error.name : 'UnknownError' });
        throw error;
      }
    });
    server.lock = operation.catch(() => undefined);
    return operation;
  }
  async #connect(server: Managed): Promise<{ client: Client }> {
    const client = new Client({ name: 'codex-mcp-hotload', version: '0.2.6' });
    if (server.config.transport === 'stdio') {
      const transport = new StdioClientTransport({ command: server.config.command!, args: server.config.args ?? [], ...(server.config.cwd ? { cwd: server.config.cwd } : {}), env: Object.fromEntries(Object.entries({ ...process.env, ...server.config.env }).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
      transport.onclose = () => { if (server.state === 'ready' && server.client) { server.client = undefined; server.state = 'crash_backoff'; server.lastError = 'Child MCP connection closed unexpectedly'; const name = this.#name(server); const beforeCount = this.registry.list(name).length; const diff = this.registry.replace(name, []); logCatalogEvent('mcp.catalog.unavailable', { server: name, reason: 'child_disconnected', beforeCount, afterCount: 0, removed: sorted(diff.removed), revision: diff.revision }); this.#scheduleRecovery(name, server); } };
      transport.stderr?.on('data', (chunk: Buffer) => this.#recordStderr(server, chunk.toString()));
      try { await withTimeout(client.connect(transport), server.config.startupTimeoutMs ?? 10_000, `Starting ${this.#name(server)}`); } catch (error) { await client.close().catch(() => undefined); throw error; }
      return { client };
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.config.headers ?? {})) { const resolved = value.startsWith('$') ? process.env[value.slice(1)] : value; if (resolved !== undefined) headers[key] = resolved; }
    await client.connect(new StreamableHTTPClientTransport(new URL(server.config.url!), { requestInit: { headers } }));
    return { client };
  }
  #recordStderr(server: Managed, value: string) {
    const secrets = Object.entries({ ...process.env, ...server.config.env }).filter(([key, secret]) => secret && /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(key)).map(([, secret]) => secret!);
    const safe = secrets.reduce((line, secret) => line.replaceAll(secret, '[REDACTED]'), value).replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]').replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED]').replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
    server.stderr = (server.stderr.join('') + safe).slice(-8192).split('\n');
  }
  #scheduleRecovery(name: string, server: Managed) {
    const maximum = server.config.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    if (server.recoveryAttempt >= maximum) { server.state = 'failed'; server.lastError = `Child recovery stopped after ${maximum} attempts`; return; }
    const waits = [250, 500, 1000, 2000, 5000];
    const wait = waits[Math.min(server.recoveryAttempt, waits.length - 1)]!;
    server.recoveryAttempt++; server.recoveryTimer = setTimeout(() => { void this.reload(name, false).catch(() => { if (server.state === 'failed' && server.recoveryAttempt < maximum) this.#scheduleRecovery(name, server); }); }, wait);
  }
  #name(target: Managed) { return [...this.#servers].find(([, value]) => value === target)?.[0] ?? ''; }
  async #runBuild(server: Managed) {
    const { command, args = [] } = server.config.build!;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd: server.config.cwd, env: Object.fromEntries(Object.entries({ ...process.env, ...server.config.env }).filter((entry): entry is [string, string] => entry[1] !== undefined)), stdio: 'inherit', windowsHide: true });
      child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build exited with code ${code}`)));
    });
  }
  async #stop(server: Managed, name: string) {
    server.state = 'stopping'; clearTimeout(server.recoveryTimer); server.recoveryTimer = undefined;
    await server.watcher?.close(); server.watcher = undefined;
    await server.client?.close().catch(() => undefined); server.client = undefined;
    server.state = 'stopped';
    if (name) void name;
  }
  async stop(name: string) { const server = this.#servers.get(name); if (server) await this.#stop(server, name); }
  getClient(name: string) { return this.#servers.get(name)?.client; }
  toolTimeout(name: string) { return this.#servers.get(name)?.config.toolTimeoutMs ?? 60_000; }
  status() { return [...this.#servers.entries()].map(([name, s]) => ({ name, state: s.state, transport: s.config.transport, revision: this.registry.list(name)[0]?.revision ?? 0, toolCount: this.registry.list(name).length, lastReload: s.lastReload ?? null, lastError: s.lastError ?? null, restartCount: s.restartCount, recoveryAttempt: s.recoveryAttempt, maxRestartAttempts: s.config.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS, uptimeMs: s.startedAt ? Date.now() - s.startedAt : null, watch: Boolean(s.watcher), stderrTail: s.stderr.join('').slice(-2000) })); }
  async watch(name: string) {
    const server = this.#servers.get(name); if (!server) throw new Error(`Unknown server: ${name}`);
    if (!server.config.watch?.length) throw new Error(`${name} has no watch patterns; configure watch in config.json`);
    if (server.watcher) return;
    const watcher = chokidar.watch(server.config.watch, { ...(server.config.cwd ? { cwd: server.config.cwd } : {}), ignoreInitial: true }); server.watcher = watcher;
    let timer: NodeJS.Timeout | undefined;
    watcher.on('all', () => { clearTimeout(timer); timer = setTimeout(() => { void this.reload(name).catch(() => undefined); }, server.config.restartDebounceMs ?? 300); });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })]).finally(() => clearTimeout(timer!));
}
