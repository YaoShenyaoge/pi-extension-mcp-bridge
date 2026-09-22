/**
 * Integration tests for the MCP bridge extension entry (M4).
 *
 * These drive the real `session_start` / `/mcp reload` handlers through a stub
 * ExtensionAPI and context, so the config -> spawn -> tools/list -> registerTool
 * path, the project-trust gate, and tool retirement are all exercised. The stdio
 * server is the local mock fixture used by the e2e test; no network is involved.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import mcpBridgeExtension from "../index.ts";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `getAgentDir()` reads this, so the test never touches the developer's real config. */
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

interface Notice {
	message: string;
	type?: string;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function createStub() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const tools: string[] = [];
	const notices: Notice[] = [];
	let activeTools: string[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
			commands.set(name, options);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	} as unknown as ExtensionAPI;

	mcpBridgeExtension(pi);

	const contextFor = (cwd: string, trusted: boolean) => ({
		cwd,
		ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
		isProjectTrusted: () => trusted,
	});

	const requireHandler = (event: string): Handler => {
		const handler = handlers.get(event);
		if (!handler) throw new Error(`extension did not register a ${event} handler`);
		return handler;
	};

	return {
		tools,
		notices,
		activeTools: () => [...activeTools],
		async startSession(cwd: string, trusted: boolean) {
			await requireHandler("session_start")({ type: "session_start", reason: "startup" }, contextFor(cwd, trusted));
		},
		async runCommand(args: string, cwd: string, trusted: boolean) {
			const command = commands.get("mcp");
			if (!command) throw new Error("extension did not register the /mcp command");
			await command.handler(args, contextFor(cwd, trusted));
		},
		async shutdown() {
			await requireHandler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, undefined);
		},
	};
}

/** Config for the shared mock MCP server fixture. */
function mockServerConfig() {
	return {
		command: process.execPath,
		args: ["test-fixtures/mock-server.mjs"],
		cwd: extensionDir,
	};
}

let root: string;
let agentDir: string;
let cwd: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mcp-bridge-ext-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

function writeProjectConfig(servers: unknown): void {
	writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf-8");
}

function writeGlobalConfig(servers: unknown): void {
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf-8");
}

const MOCK_TOOLS = ["mcp_mock_echo", "mcp_mock_fail", "mcp_mock_resources", "mcp_mock_resource_read"];

describe("MCP bridge extension entry", () => {
	it("starts a trusted project server and registers its tools", async () => {
		writeProjectConfig({ mock: mockServerConfig() });
		const stub = createStub();
		try {
			await stub.startSession(cwd, true);

			expect(new Set(stub.tools)).toEqual(new Set(MOCK_TOOLS));
			expect(stub.activeTools()).toEqual(expect.arrayContaining(MOCK_TOOLS));
			// The server's tools are also active in Pi's tool set.
			expect(stub.notices.some((notice) => notice.message.includes("1 server(s) connected"))).toBe(true);
		} finally {
			await stub.shutdown();
		}
	}, 30000);

	it("does not start a project server when the project is untrusted", async () => {
		const sentinel = join(root, "spawned.txt");
		writeProjectConfig({
			evil: {
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "spawned")`],
			},
		});

		const stub = createStub();
		await stub.startSession(cwd, false);

		// The command must never have run, and nothing may be registered.
		expect(existsSync(sentinel)).toBe(false);
		expect(stub.tools).toEqual([]);
		expect(stub.notices.some((notice) => notice.type === "warning" && notice.message.includes("not trusted"))).toBe(
			true,
		);
	}, 30000);

	it("still starts a global server when the project is untrusted", async () => {
		// The gate must be scoped to project-origin config, not disable MCP wholesale.
		writeGlobalConfig({ mock: mockServerConfig() });

		const stub = createStub();
		try {
			await stub.startSession(cwd, false);

			expect(new Set(stub.tools)).toEqual(new Set(MOCK_TOOLS));
		} finally {
			await stub.shutdown();
		}
	}, 30000);

	it("spawns the same project command when the project is trusted", async () => {
		// Positive control for the untrusted test above: it proves the sentinel
		// would be written if the trust gate were missing, so that test cannot pass
		// just because the project config is never read.
		const sentinel = join(root, "spawned-trusted.txt");
		writeProjectConfig({
			control: {
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "spawned")`],
			},
		});

		const stub = createStub();
		await stub.startSession(cwd, true);

		expect(existsSync(sentinel)).toBe(true);
		// It is not an MCP server, so connecting must fail and be reported.
		expect(stub.tools).toEqual([]);
		expect(stub.notices.some((notice) => notice.type === "error" && notice.message.includes("control"))).toBe(true);
	}, 30000);

	it("reports malformed project config instead of failing the session", async () => {
		writeFileSync(join(cwd, ".pi", "mcp.json"), "{ not json", "utf-8");

		const stub = createStub();
		await stub.startSession(cwd, true);

		expect(stub.tools).toEqual([]);
		const error = stub.notices.find((notice) => notice.type === "error");
		expect(error?.message).toContain("MCP config");
		expect(error?.message).toContain("mcp.json");
	}, 30000);

	it("retires the tools of a server removed from config on reload", async () => {
		writeProjectConfig({ mock: mockServerConfig() });
		const stub = createStub();
		try {
			await stub.startSession(cwd, true);
			expect(stub.activeTools()).toEqual(expect.arrayContaining(MOCK_TOOLS));

			// Drop the server, then reload. Pi has no unregisterTool, so the tools
			// must at least be removed from the active set instead of lingering as
			// callable tools that forward to a closed client.
			writeProjectConfig({});
			await stub.runCommand("reload", cwd, true);

			for (const tool of MOCK_TOOLS) {
				expect(stub.activeTools()).not.toContain(tool);
			}
		} finally {
			await stub.shutdown();
		}
	}, 30000);

	it("reconnects a retained server in place on reload", async () => {
		// Reusing the client instance is what keeps already-registered tools valid
		// (Pi cannot unregister them, and their closures capture the instance).
		writeProjectConfig({ mock: mockServerConfig() });
		const stub = createStub();
		try {
			await stub.startSession(cwd, true);
			const before = stub.notices.filter((notice) => notice.message.includes("connected")).length;

			await stub.runCommand("reload", cwd, true);

			// The second pass must have connected again...
			const after = stub.notices.filter((notice) => notice.message.includes("connected")).length;
			expect(after).toBeGreaterThan(before);
			// ...and the tools must still be registered and active.
			expect(new Set(stub.tools)).toEqual(new Set(MOCK_TOOLS));
			for (const tool of MOCK_TOOLS) {
				expect(stub.activeTools()).toContain(tool);
			}
			// No failure was reported for the retained server.
			expect(stub.notices.some((notice) => notice.type === "error")).toBe(false);
		} finally {
			await stub.shutdown();
		}
	}, 30000);

	it("reports status through /mcp", async () => {
		writeProjectConfig({ mock: mockServerConfig() });
		const stub = createStub();
		try {
			await stub.startSession(cwd, true);
			await stub.runCommand("status", cwd, true);

			const report = stub.notices.at(-1);
			expect(report?.message).toContain("mock");
			expect(report?.message).toContain("connected");
			expect(report?.message).toContain("project");
		} finally {
			await stub.shutdown();
		}
	}, 30000);

	it("rejects an unknown /mcp argument", async () => {
		const stub = createStub();
		await stub.runCommand("bogus", cwd, true);

		const notice = stub.notices.at(-1);
		expect(notice?.type).toBe("warning");
		expect(notice?.message).toContain("Usage");
	});
});
