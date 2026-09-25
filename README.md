# codex-mcp-hotload

`codex-mcp-hotload` gives Codex a stable MCP development gateway. Install it once, then rebuild, restart, discover, and test changing MCP servers from the same Codex conversation.

Current Codex versions may not refresh their first-class MCP tool catalog after `notifications/tools/list_changed`. Hotload keeps a stable gateway interface for changing tools. Native Codex refresh is used where supported but is not required. A typical Desktop stdio session cannot be attached to externally; this project does not modify Codex databases, scrape transcripts, delete caches, or terminate Codex.

## Install

Requires Node.js 20 or newer.

```toml
[mcp_servers.codex-mcp-hotload]
command = "npx"
args = ["-y", "codex-mcp-hotload", "serve"]
```

Restart Codex once after adding the bridge.

## Add a child server

```bash
npx codex-mcp-hotload add my-server --cwd ~/Projects/my-server -- node dist/index.js
```

Then use `hotload_search_tools`, `hotload_call_tool`, `hotload_reload_server`, `hotload_list_servers`, and `hotload_server_status` from the same conversation.

For watch mode, configure file globs and an optional build command in `~/.codex-mcp-hotload/config.json`:

```json
{
  "version": 1,
  "servers": {
    "my-server": {
      "transport": "stdio",
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/server",
      "watch": ["src/**/*.ts", "package.json"],
      "build": { "command": "npm", "args": ["run", "build"] },
      "restartDebounceMs": 300,
      "toolTimeoutMs": 60000
    }
  }
}
```

Run `codex-mcp-hotload watch my-server` or ask the bridge to reload after rebuilding. Environment references in HTTP headers use `$VARIABLE_NAME`; values are resolved at runtime and are not included in status output. Child server commands are configured locally and are not model-registerable.

## Other commands

```bash
codex-mcp-hotload init
codex-mcp-hotload list
codex-mcp-hotload reload my-server
codex-mcp-hotload status my-server
codex-mcp-hotload doctor
```

Streamable HTTP children can be configured with `transport: "streamable-http"`, a `url`, and optional headers. HTTP status codes and network exposure remain owned by that child service; the gateway itself listens only on stdio.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Scope

Version 0.1 implements the stable gateway, stdio and Streamable HTTP child connections, local registration, config-based watch/rebuild, schema hashing and validation, search, reload diffing, and basic status. Native app-server control discovery, automatic bounded crash recovery, desktop acceptance, and cross-platform end-to-end fixtures remain follow-up work; this initial version does not claim the full v1 completion criteria in the original project brief.
