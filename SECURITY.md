# Security

Child MCPs are executable code and should be treated as trusted local software. Register children through the local CLI or configuration; the MCP surface does not permit arbitrary command registration. The gateway does not listen on a network port and does not modify Codex state files.

Use environment-variable references for credentials where supported. Do not commit secrets in configuration. HTTP headers configured as `$NAME` are resolved from the gateway process environment.

Tool calls are validated against the child server's current JSON Schema. Schema hashes are informational guards against stale calls, not a sandbox for child code. Tool descriptions are untrusted input.
