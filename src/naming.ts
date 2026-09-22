/**
 * Tool-name normalization and ownership tracking for the MCP bridge.
 *
 * Kept dependency-free so the naming rules can be unit-tested without loading
 * the MCP SDK.
 */

/** Normalize a raw name to the `[a-z0-9_]+` form Pi requires. */
export function normalizeName(input: string): string {
	const normalized = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_");
	return normalized.replace(/^_+|_+$/g, "") || "unnamed";
}

/** Build the Pi tool name for an MCP tool: `mcp_<server>_<tool>`. */
export function toolNameFor(serverName: string, toolName: string): string {
	return `mcp_${normalizeName(serverName)}_${normalizeName(toolName)}`;
}

/** The two Pi tool names that expose an MCP server's resources. */
export function resourceToolNames(serverName: string): { list: string; read: string } {
	const prefix = `mcp_${normalizeName(serverName)}`;
	return { list: `${prefix}_resources`, read: `${prefix}_resource_read` };
}

/** Outcome of claiming a Pi tool name for a server. */
export type ToolNameClaim = "new" | "reregister" | "collision";

interface Claim {
	server: string;
	/** Raw MCP tool name, or a synthetic marker for the resources tools. */
	raw: string;
	active: boolean;
}

/**
 * Tracks which server owns each Pi tool name.
 *
 * Two properties of the host make this necessary:
 *
 * 1. Normalization is lossy — `my-server` and `my_server` both become
 *    `my_server` — so distinct servers can derive the same tool name.
 * 2. Pi's tool registry is a Map keyed by name and `registerTool` overwrites
 *    silently, and there is no `unregisterTool`. A collision would therefore let
 *    one server shadow another with no diagnostic, and a disconnected server's
 *    tools would linger in the registry.
 *
 * Claiming the name up front turns both cases into explicit outcomes.
 */
export class ToolNameRegistry {
	private readonly owners = new Map<string, Claim>();

	/**
	 * Claim `toolName` for one server/tool pair.
	 *
	 * - `new`: nobody owned the name.
	 * - `reregister`: the same server re-registering the same tool. Idempotent,
	 *   and the intended way to refresh a tool after a reconnect.
	 * - `collision`: a different server, or a different tool of the same server,
	 *   already owns the name. The caller must skip registration.
	 */
	claim(toolName: string, serverName: string, rawToolName: string): ToolNameClaim {
		const existing = this.owners.get(toolName);
		if (existing === undefined) {
			this.owners.set(toolName, { server: serverName, raw: rawToolName, active: true });
			return "new";
		}
		if (existing.server === serverName && existing.raw === rawToolName) {
			existing.active = true;
			return "reregister";
		}
		return "collision";
	}

	/** The server and raw tool currently owning `toolName`, if any. */
	ownerOf(toolName: string): { server: string; raw: string } | undefined {
		const claim = this.owners.get(toolName);
		return claim ? { server: claim.server, raw: claim.raw } : undefined;
	}

	/** Mark every name owned by `serverName` inactive. Returns the names. */
	releaseServer(serverName: string): string[] {
		const released: string[] = [];
		for (const [toolName, claim] of this.owners) {
			if (claim.server !== serverName || !claim.active) continue;
			claim.active = false;
			released.push(toolName);
		}
		return released;
	}

	/** Names currently owned by a connected server. */
	activeNames(): string[] {
		return [...this.owners].filter(([, claim]) => claim.active).map(([toolName]) => toolName);
	}

	/**
	 * Every name ever claimed, including inactive ones.
	 *
	 * Pi cannot unregister a tool, so this is the set a caller must exclude from
	 * the active tool list to retire a server.
	 */
	knownNames(): string[] {
		return [...this.owners.keys()];
	}
}
