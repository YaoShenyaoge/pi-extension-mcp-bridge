/**
 * Unit tests for MCP config reading: provenance, override, and diagnostics.
 *
 * `src/config.ts` deliberately has no MCP SDK import, so this runs without a
 * subprocess and under the suite's offline default (PI_OFFLINE=1).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	globalMcpConfigPath,
	projectMcpConfigPath,
	readMcpConfig,
	serverConfigError,
} from "../src/config.ts";

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mcp-config-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeGlobalFile(contents: string): void {
	writeFileSync(globalMcpConfigPath(agentDir), contents, "utf-8");
}

function writeProjectFile(contents: string): void {
	writeFileSync(projectMcpConfigPath(cwd), contents, "utf-8");
}

function serversByName(result: ReturnType<typeof readMcpConfig>): Record<string, { origin: string }> {
	return Object.fromEntries(result.servers.map((entry) => [entry.name, { origin: entry.origin }]));
}

describe("readMcpConfig", () => {
	it("returns nothing when neither file exists", () => {
		const result = readMcpConfig(cwd, agentDir);
		expect(result.servers).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});

	it("reads a global server and marks it global", () => {
		writeGlobalFile(JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["-y", "fs"] } } }));

		const result = readMcpConfig(cwd, agentDir);
		expect(result.diagnostics).toEqual([]);
		expect(result.servers).toEqual([
			{
				name: "filesystem",
				config: { command: "npx", args: ["-y", "fs"] },
				origin: "global",
				sourcePath: globalMcpConfigPath(agentDir),
			},
		]);
	});

	it("marks a project-only server as project origin", () => {
		writeProjectFile(JSON.stringify({ mcpServers: { repo: { command: "node", args: ["server.mjs"] } } }));

		const result = readMcpConfig(cwd, agentDir);
		expect(serversByName(result)).toEqual({ repo: { origin: "project" } });
	});

	it("lets a project entry override a global one and reports project origin", () => {
		writeGlobalFile(JSON.stringify({ mcpServers: { shared: { command: "global-cmd", args: ["a"] } } }));
		writeProjectFile(JSON.stringify({ mcpServers: { shared: { args: ["b"] } } }));

		const result = readMcpConfig(cwd, agentDir);
		expect(result.servers).toHaveLength(1);
		// Fields merge, so an override can retarget just one field...
		expect(result.servers[0].config).toEqual({ command: "global-cmd", args: ["b"] });
		// ...but the entry is project-influenced, so it must be trust-gated.
		expect(result.servers[0].origin).toBe("project");
	});

	it("keeps global and project servers that do not collide", () => {
		writeGlobalFile(JSON.stringify({ mcpServers: { a: { command: "a" } } }));
		writeProjectFile(JSON.stringify({ mcpServers: { b: { command: "b" } } }));

		const result = readMcpConfig(cwd, agentDir);
		expect(serversByName(result)).toEqual({ a: { origin: "global" }, b: { origin: "project" } });
	});

	it("reports malformed JSON instead of throwing, and still reads the other file", () => {
		writeGlobalFile("{ not json");
		writeProjectFile(JSON.stringify({ mcpServers: { ok: { command: "ok" } } }));

		const result = readMcpConfig(cwd, agentDir);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].path).toBe(globalMcpConfigPath(agentDir));
		// The usable file is still applied.
		expect(serversByName(result)).toEqual({ ok: { origin: "project" } });
	});

	it("reports a non-object top level", () => {
		writeGlobalFile("[]");
		const result = readMcpConfig(cwd, agentDir);
		expect(result.diagnostics).toEqual([
			{ path: globalMcpConfigPath(agentDir), message: "expected a JSON object at the top level" },
		]);
		expect(result.servers).toEqual([]);
	});

	it("reports a non-object mcpServers value", () => {
		writeGlobalFile(JSON.stringify({ mcpServers: [] }));
		const result = readMcpConfig(cwd, agentDir);
		expect(result.diagnostics).toEqual([
			{ path: globalMcpConfigPath(agentDir), message: '"mcpServers" must be an object' },
		]);
	});

	it("reports one bad server without dropping the others", () => {
		writeGlobalFile(JSON.stringify({ mcpServers: { good: { command: "good" }, bad: "not-an-object", worse: null } }));

		const result = readMcpConfig(cwd, agentDir);
		expect(serversByName(result)).toEqual({ good: { origin: "global" } });
		expect(result.diagnostics.map((entry) => entry.message)).toEqual([
			'server "bad" must be an object',
			'server "worse" must be an object',
		]);
	});

	it("ignores a file without an mcpServers key", () => {
		writeGlobalFile(JSON.stringify({ somethingElse: true }));
		const result = readMcpConfig(cwd, agentDir);
		expect(result.servers).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("serverConfigError", () => {
	it("accepts a stdio command", () => {
		expect(serverConfigError({ command: "npx" })).toBeUndefined();
	});

	it("accepts a streamable HTTP url", () => {
		expect(serverConfigError({ url: "https://example.com/mcp" })).toBeUndefined();
	});

	it("rejects a config with neither", () => {
		expect(serverConfigError({})).toContain("command");
		expect(serverConfigError({ name: "display-only" })).toContain("url");
	});
});
