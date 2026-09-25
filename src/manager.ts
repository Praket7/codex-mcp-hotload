import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ChildConfig } from './config.js';
import { Registry } from './core.js';

type Managed = { config: ChildConfig; client: Client | undefined;  watcher: FSWatcher | undefined; state: string; lastReload: string | undefined; lastError: string | undefined; stderr: string[]; restartCount: number; startedAt: number | undefined; lock: Promise<unknown> };

export class Manager {
  readonly registry = new Registry();
  readonly #servers = new Map<string, Managed>();
  constructor(readonly definitions: Record<string, ChildConfig>) {
    for (const [name, config] of Object.entries(definitions)) this.#servers.set(name, { config, client: undefined, watcher: undefined, state: 'stopped', lastReload: undefined, lastError: undefined, stderr: [], restartCount: 0, startedAt: undefined, lock: Promise.resolve() });
  }
  names() { return [...this.#servers.keys()]; }
  async startAll() { await Promise.allSettled(this.names().map((name) => this.reload(name))); }
  async close() { await Promise.all(this.names().map((name) => this.stop(name))); }
  async reload(name: string, build = true) {
    const server = this.#servers.get(name); if (!server) throw new Error(`Unknown server: ${name}`);
    const operation = server.lock.then(async () => {
      server.state = build && server.config.build ? 'building' : 'restarting';
      try {
        if (build && server.config.build) await this.#runBuild(server);
        await this.#stop(server, name);
        server.state = 'starting';
        const { client } = await this.#connect(server);
        server.client = client; server.state = 'ready'; server.lastReload = new Date().toISOString(); server.startedAt = Date.now(); server.lastError = undefined;
        const response = await client.listTools();
        const diff = this.registry.replace(name, response.tools.map((tool) => ({ name: tool.name, ...(tool.title ? { title: tool.title } : {}), ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema as Record<string, unknown>, ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}) })));
        return diff;
      } catch (error) {
        server.state = 'failed'; server.lastError = (error as Error).message; this.registry.replace(name, []); throw error;
      }
    });
    server.lock = operation.catch(() => undefined);
    return operation;
  }
  async #connect(server: Managed): Promise<{ client: Client }> {
    const client = new Client({ name: 'codex-mcp-hotload', version: '0.1.0' });
    if (server.config.transport === 'stdio') {
      const transport = new StdioClientTransport({ command: server.config.command!, args: server.config.args ?? [], ...(server.config.cwd ? { cwd: server.config.cwd } : {}), env: Object.fromEntries(Object.entries({ ...process.env, ...server.config.env }).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
      transport.stderr?.on('data', (chunk: Buffer) => { server.stderr.push(chunk.toString()); server.stderr = server.stderr.join('').slice(-8192).split('\n'); });
      try { await client.connect(transport); } catch (error) { await client.close().catch(() => undefined); throw error; }
      return { client };
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.config.headers ?? {})) { const resolved = value.startsWith('$') ? process.env[value.slice(1)] : value; if (resolved !== undefined) headers[key] = resolved; }
    await client.connect(new StreamableHTTPClientTransport(new URL(server.config.url!), { requestInit: { headers } }));
    return { client };
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
    server.state = 'stopping';
    await server.watcher?.close(); server.watcher = undefined;
    await server.client?.close().catch(() => undefined); server.client = undefined;
    server.state = 'stopped';
    if (name) void name;
  }
  async stop(name: string) { const server = this.#servers.get(name); if (server) await this.#stop(server, name); }
  getClient(name: string) { return this.#servers.get(name)?.client; }
  status() { return [...this.#servers.entries()].map(([name, s]) => ({ name, state: s.state, transport: s.config.transport, revision: this.registry.list(name)[0]?.revision ?? 0, toolCount: this.registry.list(name).length, lastReload: s.lastReload ?? null, lastError: s.lastError ?? null, restartCount: s.restartCount, uptimeMs: s.startedAt ? Date.now() - s.startedAt : null, watch: Boolean(s.watcher), stderrTail: s.stderr.join('').slice(-2000) })); }
  async watch(name: string) {
    const server = this.#servers.get(name); if (!server) throw new Error(`Unknown server: ${name}`);
    if (!server.config.watch?.length) throw new Error(`${name} has no watch patterns; configure watch in config.json`);
    if (server.watcher) return;
    const watcher = chokidar.watch(server.config.watch, { ...(server.config.cwd ? { cwd: server.config.cwd } : {}), ignoreInitial: true }); server.watcher = watcher;
    let timer: NodeJS.Timeout | undefined;
    watcher.on('all', () => { clearTimeout(timer); timer = setTimeout(() => { void this.reload(name).catch(() => undefined); }, server.config.restartDebounceMs ?? 300); });
  }
}
