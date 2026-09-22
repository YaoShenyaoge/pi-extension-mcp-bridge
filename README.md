# pi-extension-mcp-bridge

An [MCP](https://modelcontextprotocol.io) bridge for [pi](https://pi.dev): connect MCP servers and expose their **tools** and **resources** as pi tools.

Configure a server once and the agent can call it like any built-in tool.

## Install

```bash
pi install npm:pi-extension-mcp-bridge
```

Or try it without installing:

```bash
pi -e npm:pi-extension-mcp-bridge
```

Requires Node.js 22.19.0 or newer.

## Configuration

Servers are declared in `mcp.json`, either globally or per project:

| Scope | Path |
| --- | --- |
| Global | `<agentDir>/mcp.json` (defaults to `~/.pi/agent/mcp.json`) |
| Project | `<cwd>/.pi/mcp.json` |

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." },
      "cwd": "/path/to/repo"
    },
    "remote": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Project entries override global entries with the same name, field by field.

### Server fields

| Field | Meaning |
| --- | --- |
| `command` | stdio transport: the executable to spawn |
| `args` | stdio transport: arguments |
| `env` | stdio transport: extra environment variables |
| `cwd` | stdio transport: working directory |
| `url` | streamable HTTP transport: the server URL |

Set exactly one of `command` or `url`. A malformed entry is skipped and reported rather than crashing the session.

## Security: project servers require project trust

An MCP `command` is spawned as a local process, so a project-level `mcp.json` is equivalent to letting a repository run code on this machine.

Project-origin servers are therefore gated behind pi's project-trust state:

- **Global** `<agentDir>/mcp.json` is always trusted and always starts.
- **Project** `<cwd>/.pi/mcp.json` starts only when the project is trusted (`isProjectTrusted()`). Otherwise the server is skipped with a warning and no process is spawned.

Ordinary projects are trusted by default, so this gate does not affect day-to-day use. It applies when a project contains trust-requiring resources and the user has declined trust.

Because override is resolved per entry, a project entry that overrides a global server makes that server project-origin and therefore gated too — this fails closed.

## Usage

Servers are connected at session start. Their tools are registered as:

- Tools: `mcp_<server>_<tool>` (for example `mcp_filesystem_read_file`)
- Resources: `mcp_<server>_resources` (list) and `mcp_<server>_resource_read` (read one URI)

Two commands are available:

```
/mcp            # status: per-server origin, state, tool count, skip reasons, config errors, stderr tail
/mcp reload     # re-read config and reconnect
```

`/mcp reload` reuses the existing client instances: pi has no `unregisterTool`, and recreating a client would leave already-registered tools pointing at a closed connection. Servers removed from config have their tools dropped from the active tool set; the registrations themselves remain until pi restarts.

## Tool naming

MCP tool names are normalized to `[a-z0-9_]+` and prefixed with `mcp_<server>_`.

Normalization is lossy — `my-server` and `my_server` both become `my_server` — so the bridge tracks name ownership explicitly:

- Two servers claiming the same name: the later one is **skipped** with a warning naming the current owner.
- The same server re-registering the same tool after a reconnect: idempotent, allowed.
- Two tools of one server normalizing to the same name: treated as a collision.

## Development

```bash
npm install
npm test          # 50 tests
npm run check     # tsc --noEmit
```

Test layout:

| File | Scope |
| --- | --- |
| `test/naming.test.ts` | name normalization and ownership (no SDK needed) |
| `test/config.test.ts` | config reading, provenance, diagnostics (no SDK needed) |
| `test/schema-converter.test.ts` | JSON Schema to TypeBox |
| `test/bridge.test.ts` | registration, forwarding, collisions (mock client) |
| `test/extension.test.ts` | the real `session_start` / `/mcp` handlers, incl. the trust gate |
| `test/e2e.test.ts` | a real stdio MCP server subprocess |

`test-fixtures/mock-server.mjs` is a small MCP server used by the end-to-end tests.

## Limitations

- `$ref`, `allOf`, and other advanced JSON Schema constructs degrade to a permissive schema; references are not resolved.
- Image content blocks pass through as pi images; audio degrades to text.
- Tool `structuredContent` is not handled separately; content blocks are passed through.
- pi cannot unregister a tool, so a removed server's registrations only disappear after a pi restart.
- At most the last 4096 characters of each server's stderr are retained.

## License

MIT
