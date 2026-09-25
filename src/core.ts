import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';

export type JsonSchema = Record<string, unknown>;
export type ToolRecord = { server: string; name: string; title?: string; description?: string; inputSchema: JsonSchema; outputSchema?: JsonSchema; schemaHash: string; revision: number };
export type CatalogDiff = { revision: number; added: string[]; removed: string[]; changed: string[] };

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function schemaHash(tool: Pick<ToolRecord, 'name' | 'inputSchema' | 'outputSchema'>): string {
  return `sha256:${createHash('sha256').update(`${tool.name}\n${canonicalJson(tool.inputSchema)}\n${canonicalJson(tool.outputSchema ?? {})}`).digest('hex')}`;
}

export class Registry {
  readonly #servers = new Map<string, Map<string, ToolRecord>>();
  readonly #revisions = new Map<string, number>();

  replace(server: string, tools: Array<Omit<ToolRecord, 'server' | 'schemaHash' | 'revision'>>): CatalogDiff {
    const previous = this.#servers.get(server) ?? new Map<string, ToolRecord>();
    const next = new Map<string, ToolRecord>();
    for (const tool of tools) next.set(tool.name, { ...tool, server, schemaHash: schemaHash(tool), revision: this.#revisions.get(server) ?? 0 });
    const added = [...next.keys()].filter((name) => !previous.has(name));
    const removed = [...previous.keys()].filter((name) => !next.has(name));
    const changed = [...next.keys()].filter((name) => previous.has(name) && previous.get(name)!.schemaHash !== next.get(name)!.schemaHash);
    const revision = (this.#revisions.get(server) ?? 0) + (added.length + removed.length + changed.length ? 1 : 0);
    this.#revisions.set(server, revision);
    for (const tool of next.values()) tool.revision = revision;
    this.#servers.set(server, next);
    return { revision, added, removed, changed };
  }

  list(server?: string): ToolRecord[] {
    return [...this.#servers.entries()].filter(([key]) => !server || key === server).flatMap(([, tools]) => [...tools.values()]);
  }

  get(server: string, name: string): ToolRecord | undefined { return this.#servers.get(server)?.get(name); }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
export function validateArguments(schema: JsonSchema, args: unknown): string[] {
  const validate = ajv.compile(schema);
  return validate(args) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
}

export function searchTools(records: ToolRecord[], query: string, limit = 10): ToolRecord[] {
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const score = (tool: ToolRecord) => {
    const name = tool.name.toLocaleLowerCase();
    const desc = (tool.description ?? '').toLocaleLowerCase();
    if (name === query.toLocaleLowerCase()) return 10_000;
    if (name.startsWith(query.toLocaleLowerCase())) return 5_000;
    return terms.reduce((sum, term) => sum + (name.includes(term) ? 20 : 0) + (desc.includes(term) ? 1 : 0), 0);
  };
  return records.map((tool) => ({ tool, score: score(tool) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, Math.max(1, limit)).map(({ tool }) => tool);
}
