#!/usr/bin/env node
import { Command } from 'commander';
import { readConfig, writeConfig } from './config.js';
import { Manager } from './manager.js';
import { serve } from './server.js';
import { nativeReload, nativeStatus } from './codex.js';

const program = new Command().name('codex-mcp-hotload').description('A stable MCP gateway for hot-reloading child MCP servers.').version('0.2.1');
program.command('init').description('Create an empty configuration.').action(async () => { await writeConfig(await readConfig()); console.log('Created', process.env.CODEX_MCP_HOTLOAD_CONFIG ?? '~/.codex-mcp-hotload/config.json'); });
program.command('add <name>').argument('[command...]').option('--cwd <path>').option('--watch <glob...>').option('--build <command>').description('Register a stdio child MCP server.').allowUnknownOption().action(async (name: string, command: string[], options) => {
  const config = await readConfig(); const split = command.indexOf('--'); const actual = split >= 0 ? command.slice(split + 1) : command;
  if (!actual.length) throw new Error('Provide the child command after --.');
  config.servers[name] = { transport: 'stdio', command: actual[0]!, args: actual.slice(1), ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.watch ? { watch: options.watch } : {}), ...(options.build ? { build: { command: options.build, args: ['run', 'build'] } } : {}) };
  await writeConfig(config); console.log(`Added ${name}`);
});
program.command('remove <name>').description('Remove a child MCP server.').action(async (name: string) => { const config = await readConfig(); if (!config.servers[name]) throw new Error(`Unknown server: ${name}`); delete config.servers[name]; await writeConfig(config); console.log(`Removed ${name}`); });
program.command('list').description('List configured child servers.').action(async () => console.log(JSON.stringify((await readConfig()).servers, null, 2)));
program.command('serve').description('Run the stable MCP gateway over stdio.').action(async () => { const manager = new Manager((await readConfig()).servers); await serve(manager); });
for (const verb of ['reload', 'watch', 'status'] as const) program.command(`${verb} <name>`).description(`${verb} a child MCP server.`).action(async (name: string) => {
  const manager = new Manager((await readConfig()).servers);
  try {
    if (verb === 'watch') { await manager.startAll(); await manager.watch(name); console.log(`Watching ${name}; press Ctrl-C to stop.`); await new Promise<void>((resolve) => { process.once('SIGINT', resolve); }); }
    else if (verb === 'reload') console.log(JSON.stringify(await manager.reload(name), null, 2));
    else { await manager.startAll(); console.log(JSON.stringify(manager.status().find((item) => item.name === name) ?? { error: 'NOT_FOUND' }, null, 2)); }
  } finally { await manager.close(); }
});
const codex = program.command('codex').description('Inspect or reload MCP configuration through a supported Codex app-server endpoint.');
const nativeOptions = (command: Command) => command.option('--url <url>', 'App-server WebSocket URL').option('--socket <path>', 'App-server Unix control socket').option('--server <name>', 'Verify a named MCP server reached connected state');
nativeOptions(codex.command('status')).action(async (options) => { const status = await nativeStatus({ ...(options.url ? { url: options.url } : {}), ...(options.socket ? { socketPath: options.socket } : {}) }); const result = status as { data?: Array<{ name: string }> }; console.log(JSON.stringify(options.server ? { ...result, data: result.data?.filter((item) => item.name === options.server) } : status, null, 2)); });
nativeOptions(codex.command('reload')).action(async (options) => { const result = await nativeReload({ ...(options.url ? { url: options.url } : {}), ...(options.socket ? { socketPath: options.socket } : {}) }, options.server); console.log(JSON.stringify(result, null, 2)); if (!result.verified) process.exitCode = 2; });
program.command('doctor').description('Check local prerequisites and configuration.').action(async () => {
  console.log(`Node ${process.versions.node} ${Number(process.versions.node.split('.')[0]) >= 20 ? '✓' : '✗ Node 20+ required'}`);
  const config = await readConfig(); console.log(`Configuration valid: ${Object.keys(config.servers).length} child server(s)`);
  console.log(`Config path: ${process.env.CODEX_MCP_HOTLOAD_CONFIG ?? '~/.codex-mcp-hotload/config.json'}`);
});
await program.parseAsync(process.argv);
