/**
 * End-to-end test: spawns a real MCP stdio mock server and drives the bridge's
 * McpClient against it — tools/list, tools/call, resources/list, resources/read.
 *
 * This exercises the real @modelcontextprotocol/sdk client + server over a
 * stdio subprocess (no network). The mock server lives in the extension's
 * test-fixtures/ directory, which has the SDK in its own node_modules.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/client.ts";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function mockServerConfig() {
	return {
		command: process.execPath,
		args: ["test-fixtures/mock-server.mjs"],
		cwd: extensionDir,
	};
}

describe("MCP bridge end-to-end (real stdio server)", () => {
	it("connects, lists tools, calls a tool, and reads resources", async () => {
		const client = new McpClient("mock", mockServerConfig());
		try {
			await client.connect();
			expect(client.isConnected).toBe(true);

			const tools = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["echo", "fail"]);

			const echo = await client.callTool("echo", { message: "hi" });
			expect(echo.isError).toBe(false);
			expect(echo.content).toEqual([{ type: "text", text: "echo: hi" }]);

			const resources = await client.listResources();
			expect(resources.map((r) => r.uri)).toEqual(["mock://hello"]);

			const read = await client.readResource("mock://hello");
			expect(read[0].text).toBe("hello resource");
		} finally {
			await client.close();
		}
	});

	it("surfaces tool errors", async () => {
		const client = new McpClient("mock", mockServerConfig());
		try {
			await client.connect();
			const result = await client.callTool("fail", {});
			expect(result.isError).toBe(true);
		} finally {
			await client.close();
		}
	});
});
