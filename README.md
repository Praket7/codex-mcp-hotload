# Codex MCP Hotload

![Codex MCP Hotload connects one stable gateway to changing MCP servers](docs/images/gateway.png)

Develop MCP servers while keeping one stable connection in Codex. Add a server, rebuild it, and discover its current tools from the same conversation.

## Download version 0.2.1

Use Node.js 20 or newer. Codex will download and run the exact published npm release from the configuration below. The latest version is 0.2.1. Pinning the version keeps future releases from changing your setup unexpectedly.

To install the same version globally for terminal use, run this command.

```bash
npm install --global codex-mcp-hotload@0.2.1
```

## Connect Codex

Add this server entry to your Codex configuration file at `~/.codex/config.toml`.

```toml
[mcp_servers.codex-mcp-hotload]
command = "npx"
args = ["--yes", "codex-mcp-hotload@0.2.1", "serve"]
```

Restart Codex once after adding the gateway. The gateway stays connected while you add and reload child servers.

## Add your first server

In a terminal, register the command that starts your MCP server. Replace the example path and command with your own.

```bash
codex-mcp-hotload add my-server --cwd ~/Projects/my-server -- node dist/index.js
```

Then ask Codex to search for the child server tools and call one. When you change its code, rebuild the child and ask Codex to reload it. The gateway reads its configuration when tools are called, so a new child becomes available without restarting Codex or the gateway.

## What it supports

The gateway connects to local stdio servers and Streamable HTTP servers. It lists and searches their tools, checks arguments against the current schema, and detects when a saved schema is stale. It can watch files and rebuild a child when configured. If a stdio child exits unexpectedly, the gateway retries it with bounded backoff and reports its status.

Codex native reload is available when a supported app server endpoint can be reached. A standard Desktop session may not expose an endpoint for external control. The gateway features work without native reload.

## Native Codex controls

Inspect or reload connected MCP servers through the Codex app server when that endpoint is available.

```bash
codex-mcp-hotload codex status
codex-mcp-hotload codex reload --server codex-mcp-hotload
```

## Develop and verify

Contributors need Node.js 20 or newer.

```bash
npm ci
npm run typecheck
npm test
npm run build
node scripts/e2e-app-server.mjs
```

The end to end check starts an isolated Codex app server and a fixture MCP. It verifies tool discovery and calls in one thread, reloads an updated child, rejects a stale schema, and checks crash recovery. It does not make a model request or need a Codex account login.

## Security

Only register child servers you trust because their commands run as your user. Keep credentials out of the configuration file and use environment variables for secrets. The gateway uses stdio and does not open a network listener.

See [SECURITY.md](SECURITY.md) for more information.
