import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export type ChildConfig = {
  transport: 'stdio' | 'streamable-http'; command?: string; args?: string[]; cwd?: string;
  url?: string; headers?: Record<string, string>; env?: Record<string, string>;
  watch?: string[]; build?: { command: string; args?: string[] };
  restartDebounceMs?: number; startupTimeoutMs?: number; toolTimeoutMs?: number;
};
export type Config = { version: 1; servers: Record<string, ChildConfig> };
export const configPath = () => process.env.CODEX_MCP_HOTLOAD_CONFIG ?? join(homedir(), '.codex-mcp-hotload', 'config.json');

export async function readConfig(path = configPath()): Promise<Config> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Config;
    if (value.version !== 1 || !value.servers || typeof value.servers !== 'object') throw new Error('expected version 1 and a servers object');
    for (const [name, server] of Object.entries(value.servers)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`invalid server name: ${name}`);
      if (!['stdio', 'streamable-http'].includes(server.transport)) throw new Error(`invalid transport for ${name}`);
      if (server.transport === 'stdio' && !server.command) throw new Error(`stdio server ${name} needs a command`);
      if (server.transport === 'streamable-http' && !server.url) throw new Error(`HTTP server ${name} needs a URL`);
      if (server.url && !['http:', 'https:'].includes(new URL(server.url).protocol)) throw new Error(`invalid URL for ${name}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: {} };
    throw new Error(`Invalid config ${path}: ${(error as Error).message}`);
  }
}

export async function writeConfig(config: Config, path = configPath()): Promise<void> {
  const absolute = resolve(path);
  await mkdir(join(absolute, '..'), { recursive: true, mode: 0o700 });
  await writeFile(absolute, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
