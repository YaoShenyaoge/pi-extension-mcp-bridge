/**
 * M4a — MCP server configuration.
 *
 * Reads the global (`<agentDir>/mcp.json`) and project (`<cwd>/.pi/mcp.json`)
 * config files, records which file each server came from, and reports malformed
 * input instead of silently ignoring it.
 *
 * Kept free of the MCP SDK so the rules can be unit-tested without a subprocess.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Configuration for one MCP server. */
export interface McpServerConfig {
	/** stdio transport (local subprocess). */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** streamable HTTP transport (remote server). */
	url?: string;
	/** Optional display name; defaults to the server key. */
	name?: string;
}

/** Which config file a server definition came from. */
export type McpConfigOrigin = "global" | "project";

/** One configured server plus its provenance. */
export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	origin: McpConfigOrigin;
	/** Absolute path of the file that last defined or overrode this server. */
	sourcePath: string;
}

/** A config file that could not be used as written. */
export interface McpConfigDiagnostic {
	path: string;
	message: string;
}

export interface McpConfigResult {
	servers: McpServerEntry[];
	diagnostics: McpConfigDiagnostic[];
}

interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
}

/** Path of the global MCP config file. */
export function globalMcpConfigPath(agentDir: string): string {
	return join(agentDir, "mcp.json");
}

/** Path of the project-local MCP config file. */
export function projectMcpConfigPath(cwd: string): string {
	return join(cwd, ".pi", "mcp.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOneFile(
	path: string,
	origin: McpConfigOrigin,
	servers: Map<string, McpServerEntry>,
	diagnostics: McpConfigDiagnostic[],
): void {
	if (!existsSync(path)) return;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
		return;
	}

	if (!isPlainObject(parsed)) {
		diagnostics.push({ path, message: "expected a JSON object at the top level" });
		return;
	}

	const declared = (parsed as McpConfigFile).mcpServers;
	if (declared === undefined) return;
	if (!isPlainObject(declared)) {
		diagnostics.push({ path, message: '"mcpServers" must be an object' });
		return;
	}

	for (const [name, config] of Object.entries(declared)) {
		if (!isPlainObject(config)) {
			diagnostics.push({ path, message: `server "${name}" must be an object` });
			continue;
		}
		// Project entries override global ones field by field, matching the
		// documented behavior; the surviving entry reports the overriding file.
		const existing = servers.get(name);
		servers.set(name, {
			name,
			config: { ...existing?.config, ...(config as McpServerConfig) },
			origin,
			sourcePath: path,
		});
	}
}

/**
 * Read global then project config. A project entry overrides a global entry with
 * the same name and reports `origin: "project"`, which lets callers apply
 * project-trust gating to exactly the servers a repository can influence.
 */
export function readMcpConfig(cwd: string, agentDir: string): McpConfigResult {
	const servers = new Map<string, McpServerEntry>();
	const diagnostics: McpConfigDiagnostic[] = [];
	readOneFile(globalMcpConfigPath(agentDir), "global", servers, diagnostics);
	readOneFile(projectMcpConfigPath(cwd), "project", servers, diagnostics);
	return { servers: [...servers.values()], diagnostics };
}

/** Why a server cannot be connected, or undefined when its config is usable. */
export function serverConfigError(config: McpServerConfig): string | undefined {
	if (config.url !== undefined) return undefined;
	if (config.command !== undefined) return undefined;
	return 'config needs either "command" (stdio) or "url" (streamable HTTP)';
}
