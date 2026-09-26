import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

type RpcMessage = { id?: string | number; method?: string; result?: unknown; error?: { code: number; message: string; data?: unknown }; params?: unknown };
export type CodexEndpoint = { url?: string; socketPath?: string; timeoutMs?: number };

export class CodexAppServer {
  readonly #socket: WebSocket;
  readonly #pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #id = 0;
  #closed = false;
  private constructor(socket: WebSocket, readonly timeoutMs: number) {
    this.#socket = socket;
    socket.on('message', (bytes) => {
      let message: RpcMessage;
      try { message = JSON.parse(bytes.toString()) as RpcMessage; } catch { return; }
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Codex RPC ${message.error.code}: ${message.error.message}`)); else pending.resolve(message.result);
    });
    socket.on('close', () => this.#failAll(new Error('Codex app-server connection closed')));
    socket.on('error', (error) => this.#failAll(error));
  }

  static async connect(endpoint: CodexEndpoint = {}): Promise<CodexAppServer> {
    if (endpoint.url && endpoint.socketPath) throw new Error('Choose either a WebSocket URL or a Unix socket path.');
    const socketPath = endpoint.socketPath ?? (!endpoint.url ? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock') : undefined);
    const socket = socketPath
      ? new WebSocket('ws://localhost', { createConnection: () => createConnection(socketPath), perMessageDeflate: false })
      : new WebSocket(endpoint.url!, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Codex app-server')), endpoint.timeoutMs ?? 10_000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const client = new CodexAppServer(socket, endpoint.timeoutMs ?? 10_000);
    try {
      await client.request('initialize', { clientInfo: { name: 'codex-mcp-hotload', version: '0.2.5' }, capabilities: { experimentalApi: true } });
      client.notify('initialized');
      return client;
    } catch (error) { await client.close(); throw error; }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex app-server is not connected'));
    const id = ++this.#id;
    const message = { id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Codex RPC timed out: ${method}`)); }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify(message), (error) => {
        if (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
      });
    });
  }
  notify(method: string, params?: unknown) { this.#socket.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) })); }
  async close() { this.#closed = true; this.#failAll(new Error('Codex app-server client closed')); await new Promise<void>((resolve) => { if (this.#socket.readyState === WebSocket.CLOSED) resolve(); else { this.#socket.once('close', () => resolve()); this.#socket.close(); setTimeout(() => resolve(), 500).unref(); } }); }
  #failAll(error: Error) { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.#pending.clear(); }
}

export async function nativeStatus(endpoint: CodexEndpoint = {}) {
  const client = await CodexAppServer.connect(endpoint);
  try { return await listMcpServers(client); } finally { await client.close(); }
}
export async function nativeReload(endpoint: CodexEndpoint = {}, serverName?: string, waitMs = 10_000, threadId?: string) {
  const client = await CodexAppServer.connect(endpoint);
  try {
    const before = await listMcpServers(client, threadId);
    const target = serverName ? before.servers.find((server) => server.name === serverName) : undefined;
    if (serverName && !target) throw new Error(`Unknown Codex MCP server: ${serverName}`);
    await client.request('config/mcpServer/reload', {});
    if (waitMs > 0) await delay(Math.min(waitMs, 250));
    const after = await listMcpServers(client, threadId);
    const status = serverName ? after.servers.find((server) => server.name === serverName) : undefined;
    return {
      reloaded: true,
      verified: !serverName || Boolean(status),
      server: serverName ?? null,
      scope: 'all_configured_servers',
      refresh: 'queued_for_next_active_turn',
      reconnected: status?.runtimeStatus === undefined || status.runtimeStatus === null ? null : ['connected', 'ready'].includes(status.runtimeStatus.toLowerCase()),
      statusScope: threadId ? 'thread' : 'global',
      runtimeStatus: status?.runtimeStatus ?? null,
      status: serverName ? status ?? null : after.servers,
      ...(serverName && !status ? { error: `Server ${serverName} is no longer listed after reload` } : {}),
    };
  } finally { await client.close(); }
}

type ServerStatus = { name: string; runtimeStatus?: string | null; tools?: Record<string, unknown>; toolsError?: string | null; [key: string]: unknown };
export async function listMcpServers(client: CodexAppServer, threadId?: string): Promise<{ servers: ServerStatus[] }> {
  const servers: ServerStatus[] = [];
  let cursor: string | undefined;
  do {
    const value = await client.request('mcpServerStatus/list', { ...(cursor ? { cursor } : {}), ...(threadId ? { threadId } : {}), detail: 'toolsAndAuthOnly' }) as { data?: ServerStatus[]; nextCursor?: string | null };
    servers.push(...(value.data ?? []));
    cursor = value.nextCursor ?? undefined;
  } while (cursor);
  return { servers };
}
