/**
 * MCP stdio mock server for end-to-end tests.
 *
 * Exposes:
 *   - tool "echo"       : echoes { message } back (validates input schema)
 *   - tool "fail"       : always throws, to exercise error surfacing
 *   - resource "hello"  : fixed text resource, to exercise resources/list + read
 *
 * Run: `node test-fixtures/mock-server.mjs`
 * Uses the MCP SDK's high-level McpServer + StdioServerTransport over stdin/stdout.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
	name: "pi-mock-server",
	version: "1.0.0",
});

server.registerTool(
	"echo",
	{
		description: "Echo a message back",
		inputSchema: { message: z.string() },
	},
	async ({ message }) => {
		return { content: [{ type: "text", text: `echo: ${message}` }] };
	},
);

server.registerTool(
	"fail",
	{ description: "Always fails" },
	async () => {
		throw new Error("boom");
	},
);

server.registerResource(
	"hello",
	"mock://hello",
	{ description: "A fixed test resource" },
	async (uri) => {
		return { contents: [{ uri: uri.href, text: "hello resource" }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
