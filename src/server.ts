import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import type { Manager } from './manager.js';
import { searchTools, validateArguments } from './core.js';
import { listMcpServers, CodexAppServer, nativeReload, type CodexEndpoint } from './codex.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from './config.js';

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => { let timer: NodeJS.Timeout; return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Tool call timed out after ${timeoutMs}ms`)), timeoutMs); })]).finally(() => clearTimeout(timer!)); };
const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const fail = (code: string, message: string, extra: object = {}) => text({ error: { code, message, ...extra } });
export function createServer(manager: Manager) {
  const codexEndpoint = async (): Promise<CodexEndpoint> => {
    const config = await readConfig();
    return config.codexControl ?? { socketPath: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock') };
  };
  const server = new McpServer({ name: 'codex-mcp-hotload', version: '0.2.3' });
  server.registerTool('hotload_list_servers', { description: 'List Hotload child servers and MCP servers configured directly in Codex.', inputSchema: {} }, async () => {
    await manager.refreshConfig();
    const local = manager.status();
    try { const client = await CodexAppServer.connect(await codexEndpoint()); try { const codex = await listMcpServers(client); return text({ servers: local, codexServers: codex.servers }); } finally { await client.close(); } }
    catch (error) { return text({ servers: local, codexServers: [], codexControl: { available: false, error: (error as Error).message } }); }
  });
  server.registerTool('hotload_server_status', { description: 'Show runtime status for a child MCP server.', inputSchema: { server: z.string() } }, async ({ server: name }) => {
    await manager.refreshConfig();
    const item = manager.status().find((server) => server.name === name); if (item) return text({ source: 'hotload', ...item });
    try { const client = await CodexAppServer.connect(await codexEndpoint()); try { const result = await listMcpServers(client); const codex = result.servers.find((server) => server.name === name); return codex ? text({ source: 'codex', ...codex }) : fail('NOT_FOUND', `Unknown server: ${name}`); } finally { await client.close(); } }
    catch (error) { return fail('CODEX_CONTROL_UNAVAILABLE', (error as Error).message); }
  });
  server.registerTool('hotload_search_tools', { description: 'Search current tools exposed by child MCP servers.', inputSchema: { query: z.string(), server: z.string().optional(), limit: z.number().int().min(1).max(50).optional() } }, async ({ query, server: name, limit }) => { await manager.refreshConfig(); return text({ matches: searchTools(manager.registry.list(name), query, limit).map((tool) => ({ ...tool })) }); })
  server.registerTool('hotload_reload_server', { description: 'Reload a Hotload child or request Codex to refresh its configured MCP servers.', inputSchema: { server: z.string(), reason: z.string().optional() } }, async ({ server: name }) => {
    await manager.refreshConfig();
    if (manager.status().some((item) => item.name === name)) { try { return text({ source: 'hotload', ...await manager.reload(name) }); } catch (error) { return fail('RELOAD_FAILED', (error as Error).message); } }
    try { return text({ source: 'codex', ...await nativeReload(await codexEndpoint(), name, 0) }); } catch (error) { return fail('CODEX_RELOAD_FAILED', (error as Error).message); }
  });
  server.registerTool('hotload_call_tool', { description: 'Validate against the current schema and invoke a child MCP tool.', inputSchema: { server: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()).default({}), expectedSchemaHash: z.string().optional() } }, async ({ server: name, tool: toolName, arguments: args, expectedSchemaHash }) => {
    await manager.refreshConfig();
    const record = manager.registry.get(name, toolName); if (!record) return fail('NOT_FOUND', `Unknown tool: ${name}.${toolName}`);
    if (!expectedSchemaHash) return fail('SCHEMA_HASH_REQUIRED', 'Search for the current tool definition and pass its schemaHash before calling it.', { current: { name: record.name, ...(record.title ? { title: record.title } : {}), ...(record.description ? { description: record.description } : {}), schemaHash: record.schemaHash, inputSchema: record.inputSchema, outputSchema: record.outputSchema ?? {} } });
    if (expectedSchemaHash !== record.schemaHash) return fail('STALE_SCHEMA', 'Tool definition has changed. Search again and review its current definition before calling it.', { oldSchemaHash: expectedSchemaHash, current: { name: record.name, ...(record.title ? { title: record.title } : {}), ...(record.description ? { description: record.description } : {}), schemaHash: record.schemaHash, inputSchema: record.inputSchema, outputSchema: record.outputSchema ?? {} } });
    const errors = validateArguments(record.inputSchema, args); if (errors.length) return fail('INVALID_ARGUMENTS', errors.join('; '), { schemaHash: record.schemaHash });
    const client = manager.getClient(name); if (!client) return fail('SERVER_UNAVAILABLE', `${name} is not ready.`);
    try { const result = await withTimeout(client.callTool({ name: toolName, arguments: args }), manager.toolTimeout(name)); return text({ server: name, tool: toolName, schemaHash: record.schemaHash, result }); }
    catch (error) { return fail('CALL_FAILED', (error as Error).message); }
  });
  return server;
}
export async function serve(manager: Manager) {
  await manager.startAll();
  const server = createServer(manager);
  const transport = serveStdio(() => server);
  const shutdown = async () => { await transport.close().catch(() => undefined); await manager.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
