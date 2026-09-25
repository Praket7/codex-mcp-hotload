import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import type { Manager } from './manager.js';
import { searchTools, validateArguments } from './core.js';

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => { let timer: NodeJS.Timeout; return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Tool call timed out after ${timeoutMs}ms`)), timeoutMs); })]).finally(() => clearTimeout(timer!)); };
const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const fail = (code: string, message: string, extra: object = {}) => text({ error: { code, message, ...extra } });
export function createServer(manager: Manager) {
  const server = new McpServer({ name: 'codex-mcp-hotload', version: '0.2.1' });
  server.registerTool('hotload_list_servers', { description: 'List configured child MCP servers and their readiness.', inputSchema: {} }, async () => { await manager.refreshConfig(); return text({ servers: manager.status() }); });
  server.registerTool('hotload_server_status', { description: 'Show runtime status for a child MCP server.', inputSchema: { server: z.string() } }, async ({ server: name }) => {
    await manager.refreshConfig();
    const item = manager.status().find((server) => server.name === name); return item ? text(item) : fail('NOT_FOUND', `Unknown server: ${name}`);
  });
  server.registerTool('hotload_search_tools', { description: 'Search current tools exposed by child MCP servers.', inputSchema: { query: z.string(), server: z.string().optional(), limit: z.number().int().min(1).max(50).optional() } }, async ({ query, server: name, limit }) => { await manager.refreshConfig(); return text({ matches: searchTools(manager.registry.list(name), query, limit).map((tool) => ({ ...tool })) }); })
  server.registerTool('hotload_reload_server', { description: 'Build (when configured), restart, and re-index one child MCP server.', inputSchema: { server: z.string(), reason: z.string().optional() } }, async ({ server: name }) => {
    await manager.refreshConfig();
    try { return text(await manager.reload(name)); } catch (error) { return fail('RELOAD_FAILED', (error as Error).message); }
  });
  server.registerTool('hotload_call_tool', { description: 'Validate against the current schema and invoke a child MCP tool.', inputSchema: { server: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()).default({}), expectedSchemaHash: z.string().optional() } }, async ({ server: name, tool: toolName, arguments: args, expectedSchemaHash }) => {
    await manager.refreshConfig();
    const record = manager.registry.get(name, toolName); if (!record) return fail('NOT_FOUND', `Unknown tool: ${name}.${toolName}`);
    if (expectedSchemaHash && expectedSchemaHash !== record.schemaHash) return fail('STALE_SCHEMA', 'Tool schema has changed.', { oldSchemaHash: expectedSchemaHash, currentSchemaHash: record.schemaHash, currentSchema: record.inputSchema });
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
