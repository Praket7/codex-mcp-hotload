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

Run `codex-mcp-hotload watch my-server` or ask the bridge to reload after rebuilding. Stdio child crashes are restarted with 250 ms, 500 ms, 1 s, 2 s, and 5 s backoff, with five attempts by default; set `maxRestartAttempts` to change the bound. `hotload_server_status` reports recovery attempts and the last stderr tail. Environment references in HTTP headers use `$VARIABLE_NAME`; values are resolved at runtime and are not included in status output. Child server commands are configured locally and are not model-registerable.

## Native Codex app-server control

Native control uses Codex's supported app-server JSON-RPC methods, `config/mcpServer/reload` and `mcpServerStatus/list`. It connects to an explicit WebSocket endpoint or the local managed app-server Unix control socket; the default socket is under `$CODEX_HOME/app-server-control/` (or `~/.codex/app-server-control/). Use `--server` to wait for and verify a configured server's live tool catalog after reload:

```bash
codex-mcp-hotload codex status
codex-mcp-hotload codex status --url ws://127.0.0.1:4500
codex-mcp-hotload codex reload --server codex-mcp-hotload
codex-mcp-hotload codex reload --socket ~/.codex/app-server-control/app-server-control.sock --server codex-mcp-hotload
```

This control path works only when a supported app-server endpoint is available. Standard Codex Desktop sessions may keep app-server on private stdio; external software cannot attach to that session, and this tool does not claim otherwise. Gateway mode continues working independently.

## Same-thread acceptance test

With the Codex CLI installed, run `npm run test:e2e`. It starts an isolated app-server and temporary `CODEX_HOME`, creates one thread, discovers/calls a fixture MCP, changes the fixture catalog and schema, invokes native reload, and verifies all calls and stale-schema handling through the same thread ID. It also crashes the child to verify automatic recovery and confirms a repeated crash loop stops at its configured attempt limit. It makes no model inference request and does not require a Codex account login.

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

The gateway rereads its local child-server config on each tool call, so `codex-mcp-hotload add` becomes available without restarting the gateway or Codex. Version 0.2.1 includes the stable gateway, stdio and Streamable HTTP child connections, local registration, config-based watch/rebuild, schema hashing and draft-2020-12 validation, search, reload diffing, bounded stdio crash recovery, supported app-server WebSocket/Unix-socket controls, and a same-thread app-server E2E regression test. Real Desktop UI acceptance still depends on an externally available supported app-server endpoint; ordinary Desktop stdio sessions cannot be externally attached.
