/**
 * M4 — Configuration, client lifecycle, /mcp command, and extension entry.
 *
 * Reads server config from `<cwd>/.pi/mcp.json` (project) and
 * `<agentDir>/mcp.json` (global). Owns the McpClient lifecycle: connect on
 * session_start, close on session_shutdown.
 *
 * Two constraints shape the lifecycle code below:
 *
 * - Pi has no `unregisterTool`, and `registerTool` overwrites by name. So a
 *   client instance is reused across reloads (already-registered tools close over
 *   it, and recreating it would leave them pointing at a closed client), and
 *   retiring a server is done by dropping its names from the active tool set.
 * - Project config can spawn an arbitrary command, so project-origin servers are
 *   gated behind project trust. The global config is always trusted.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type BridgeOutcome, bridgeConnectedClient, type RegistrationResult } from "./src/bridge.ts";
import { McpClient } from "./src/client.ts";
import {
	type McpConfigDiagnostic,
	type McpConfigOrigin,
	type McpServerEntry,
	readMcpConfig,
	serverConfigError,
} from "./src/config.ts";
import { ToolNameRegistry } from "./src/naming.ts";

type ServerState = "connected" | "disconnected" | "skipped" | "failed";

interface ServerStatus {
	name: string;
	origin: McpConfigOrigin;
	sourcePath: string;
	state: ServerState;
	detail?: string;
	/** Trailing stderr of a failed stdio server, when there is any. */
	stderrTail?: string;
	tools: string[];
	skipped: RegistrationResult[];
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameToolSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const seen = new Set(a);
	return b.every((name) => seen.has(name));
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export default function mcpBridgeExtension(pi: ExtensionAPI) {
	/** Stable per-server instances, reused across reloads. */
	const clients = new Map<string, McpClient>();
	/** Name ownership across reloads; the single source of truth for retirement. */
	const registry = new ToolNameRegistry();
	let diagnostics: McpConfigDiagnostic[] = [];
	const statuses = new Map<string, ServerStatus>();

	/**
	 * Drop retired MCP tools from the active set.
	 *
	 * `setActiveTools` ignores names that are not in Pi's registry, and only names
	 * this bridge ever claimed are removed, so the user's other enabled tools are
	 * preserved.
	 */
	function syncActiveTools(): void {
		const known = new Set(registry.knownNames());
		const current = pi.getActiveTools();
		const next = [...new Set([...current.filter((name) => !known.has(name)), ...registry.activeNames()])];
		if (sameToolSet(current, next)) return;
		pi.setActiveTools(next);
	}

	function connectOne(entry: McpServerEntry, trusted: boolean): Promise<ServerStatus> {
		const status: ServerStatus = {
			name: entry.name,
			origin: entry.origin,
			sourcePath: entry.sourcePath,
			state: "disconnected",
			tools: [],
			skipped: [],
		};

		if (entry.origin === "project" && !trusted) {
			status.state = "skipped";
			status.detail = "project is not trusted; project MCP servers are not started";
			return Promise.resolve(status);
		}

		const invalid = serverConfigError(entry.config);
		if (invalid !== undefined) {
			status.state = "skipped";
			status.detail = invalid;
			return Promise.resolve(status);
		}

		let client = clients.get(entry.name);
		if (client === undefined) {
			client = new McpClient(entry.name, entry.config);
			clients.set(entry.name, client);
		}
		const target = client;

		return (async () => {
			try {
				// Reconnect in place: the instance identity is what keeps previously
				// registered tools valid.
				if (target.isConnected) await target.close();
				await target.connect();
				const tools = await target.listTools();
				const outcome: BridgeOutcome = bridgeConnectedClient(pi, target, tools, registry);
				status.state = "connected";
				status.tools = outcome.registered;
				status.skipped = outcome.skipped;
			} catch (error) {
				await target.close().catch(() => {});
				clients.delete(entry.name);
				registry.releaseServer(entry.name);
				status.state = "failed";
				status.detail = describeError(error);
				status.stderrTail = target.stderrTail;
			}
			return status;
		})();
	}

	async function connectServers(ctx: ExtensionContext): Promise<void> {
		const config = readMcpConfig(ctx.cwd, getAgentDir());
		diagnostics = config.diagnostics;
		statuses.clear();

		const trusted = ctx.isProjectTrusted();
		const configured = new Set(config.servers.map((entry) => entry.name));

		// Retire servers that are no longer configured.
		for (const [name, client] of [...clients]) {
			if (configured.has(name)) continue;
			await client.close().catch(() => {});
			clients.delete(name);
			registry.releaseServer(name);
		}

		for (const entry of config.servers) {
			statuses.set(entry.name, await connectOne(entry, trusted));
		}

		syncActiveTools();
		report(ctx);
	}

	/** Surface config problems and skipped registrations; stay quiet when clean. */
	function report(ctx: ExtensionContext): void {
		for (const diagnostic of diagnostics) {
			ctx.ui.notify(`MCP config ${diagnostic.path}: ${diagnostic.message}`, "error");
		}

		const connected = [...statuses.values()].filter((status) => status.state === "connected");
		if (connected.length > 0) {
			const toolCount = connected.reduce((total, status) => total + status.tools.length, 0);
			const names = connected.map((status) => status.name).join(", ");
			ctx.ui.notify(`MCP: ${connected.length} server(s) connected (${names}); ${toolCount} tools`, "info");
		}

		for (const status of statuses.values()) {
			if (status.state === "skipped") {
				ctx.ui.notify(`MCP "${status.name}" skipped: ${status.detail ?? "unusable config"}`, "warning");
			} else if (status.state === "failed") {
				ctx.ui.notify(`MCP "${status.name}" failed to connect: ${status.detail ?? "unknown error"}`, "error");
			}
			for (const skipped of status.skipped) {
				ctx.ui.notify(`MCP "${status.name}": skipped ${skipped.toolName} (${skipped.reason})`, "warning");
			}
		}
	}

	/** Multi-line report for `/mcp status`. */
	function statusReport(): string {
		const lines: string[] = [];

		for (const status of statuses.values()) {
			const origin = status.origin === "project" ? "project" : "global";
			let line = `- ${status.name} [${origin}]: ${status.state}, ${status.tools.length} tools`;
			if (status.detail !== undefined) line += ` — ${oneLine(status.detail)}`;
			lines.push(line);
			for (const skipped of status.skipped) {
				lines.push(`    skipped ${skipped.toolName}: ${oneLine(skipped.reason ?? "unknown")}`);
			}
			if (status.stderrTail !== undefined && status.stderrTail.trim() !== "") {
				lines.push(`    stderr: ${oneLine(status.stderrTail).slice(-400)}`);
			}
		}

		for (const diagnostic of diagnostics) {
			lines.push(`- config error in ${diagnostic.path}: ${oneLine(diagnostic.message)}`);
		}

		if (lines.length === 0) return "No MCP servers configured.";

		const retired = registry.knownNames().length - registry.activeNames().length;
		if (retired > 0) {
			lines.push(`(${retired} retired tool name(s) deactivated; restart pi to drop them entirely)`);
		}
		return lines.join("\n");
	}

	async function disconnectAll(): Promise<void> {
		await Promise.all([...clients.values()].map((client) => client.close().catch(() => {})));
		clients.clear();
		for (const name of [...statuses.keys()]) registry.releaseServer(name);
		statuses.clear();
		diagnostics = [];
	}

	pi.on("session_start", (_event, ctx) => {
		// Return the promise so the runner awaits connection before proceeding
		// (matters in print/RPC modes where the session may otherwise finish
		// before tools are registered).
		return connectServers(ctx);
	});

	pi.on("session_shutdown", () => {
		return disconnectAll();
	});

	pi.registerCommand("mcp", {
		description: "Manage MCP bridge servers: /mcp [status|reload]",
		handler: async (args, ctx) => {
			if (args.trim() === "reload") {
				// Reuses the live client instances; re-registration is idempotent.
				await connectServers(ctx);
				ctx.ui.notify("MCP servers reloaded.", "info");
				return;
			}
			if (args.trim() !== "" && args.trim() !== "status") {
				ctx.ui.notify("Usage: /mcp [status|reload]", "warning");
				return;
			}
			ctx.ui.notify(statusReport(), "info");
		},
	});
}
