/**
 * M3 — Bridge core.
 *
 * Registers MCP tools and resources as Pi tools, given an already-connected
 * McpClient. Client lifecycle (connect/close) is owned by the manager in M4;
 * this module is pure registration + call forwarding.
 *
 * Pi has no `unregisterTool`, and `registerTool` overwrites by name, so name
 * ownership is delegated to a `ToolNameRegistry` shared across reloads: it turns
 * cross-server collisions into explicit skips and lets the manager retire a
 * disconnected server's tools from the active set.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { McpClient, McpContentBlock, ToolCallOutcome } from "./client.ts";
import { resourceToolNames, type ToolNameRegistry, toolNameFor } from "./naming.ts";
import { type JsonSchema, jsonSchemaToTypeBox } from "./schema-converter.ts";

/** Map MCP content blocks to Pi content (text + image). */
function toPiContent(blocks: McpContentBlock[]): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			out.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else if (block.type === "resource") {
			// Inline resource content: prefer text, else the base64 blob.
			const text = block.resource.text ?? block.resource.blob ?? "";
			out.push({ type: "text", text });
		}
	}
	return out;
}

/** Minimal shape we need from an MCP tool. */
export interface McpToolLike {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

/** Result of attempting to register one Pi tool. */
export interface RegistrationResult {
	toolName: string;
	registered: boolean;
	/** Why registration was skipped, when it was. */
	reason?: string;
}

/** Everything a bridge pass registered, plus what it had to skip. */
export interface BridgeOutcome {
	registered: string[];
	skipped: RegistrationResult[];
}

/** Synthetic raw-tool markers for the resources tools, used for claim identity. */
const RESOURCES_LIST_RAW = "\u0000resources";
const RESOURCES_READ_RAW = "\u0000resource_read";

function collisionReason(registry: ToolNameRegistry, toolName: string): string {
	const owner = registry.ownerOf(toolName);
	if (!owner) return "tool name is already taken";
	return `tool name already owned by server "${owner.server}" (tool "${owner.raw}")`;
}

/** Register one MCP tool as a Pi tool against an already-connected client. */
export function registerMcpTool(
	pi: ExtensionAPI,
	client: McpClient,
	tool: McpToolLike,
	registry: ToolNameRegistry,
): RegistrationResult {
	const piName = toolNameFor(client.name, tool.name);

	if (registry.claim(piName, client.name, tool.name) === "collision") {
		return { toolName: piName, registered: false, reason: collisionReason(registry, piName) };
	}

	// Convert the MCP JSON Schema input to a TypeBox schema. Guard against a
	// missing/malformed schema so a single bad tool never blocks the rest.
	let params: TSchema;
	try {
		params = jsonSchemaToTypeBox(tool.inputSchema as JsonSchema);
	} catch {
		params = jsonSchemaToTypeBox({ type: "object" });
	}

	pi.registerTool({
		name: piName,
		label: `MCP ${client.name} ${tool.name}`,
		description: tool.description ?? `MCP tool "${tool.name}" from server "${client.name}"`,
		promptSnippet: `Call the MCP tool "${tool.name}" (server: ${client.name})`,
		parameters: params,
		async execute(
			_toolCallId: string,
			args: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
		): Promise<AgentToolResult<Record<string, unknown>>> {
			let outcome: ToolCallOutcome;
			try {
				outcome = await client.callTool(tool.name, args ?? {});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `MCP tool "${tool.name}" failed: ${message}` }],
					details: { error: message },
				};
			}
			return {
				content: toPiContent(outcome.content),
				details: { isError: outcome.isError, tool: tool.name },
			};
		},
	});

	return { toolName: piName, registered: true };
}

/** Register the resources tools (list + read) for an already-connected client. */
export function registerMcpResources(
	pi: ExtensionAPI,
	client: McpClient,
	registry: ToolNameRegistry,
): RegistrationResult[] {
	const names = resourceToolNames(client.name);
	const results: RegistrationResult[] = [];

	const claim = registry.claim(names.list, client.name, RESOURCES_LIST_RAW);
	if (claim === "collision") {
		results.push({ toolName: names.list, registered: false, reason: collisionReason(registry, names.list) });
	} else {
		pi.registerTool({
			name: names.list,
			label: `MCP ${client.name} Resources`,
			description: `List resources exposed by the MCP server "${client.name}"`,
			promptSnippet: `List resources from MCP server "${client.name}"`,
			parameters: jsonSchemaToTypeBox({ type: "object", properties: {} }),
			async execute(): Promise<AgentToolResult<Record<string, unknown>>> {
				try {
					const resources = await client.listResources();
					const text = resources
						.map((r) => `${r.uri}\t${r.name}${r.description ? ` — ${r.description}` : ""}`)
						.join("\n");
					return {
						content: [{ type: "text", text: text || "(no resources)" }],
						details: { resources: resources.length },
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Failed to list resources: ${message}` }],
						details: { error: message },
					};
				}
			},
		});
		results.push({ toolName: names.list, registered: true });
	}

	const readClaim = registry.claim(names.read, client.name, RESOURCES_READ_RAW);
	if (readClaim === "collision") {
		results.push({ toolName: names.read, registered: false, reason: collisionReason(registry, names.read) });
	} else {
		pi.registerTool({
			name: names.read,
			label: `MCP ${client.name} Read Resource`,
			description: `Read a resource from the MCP server "${client.name}" by URI`,
			promptSnippet: `Read a resource URI from MCP server "${client.name}"`,
			parameters: jsonSchemaToTypeBox({
				type: "object",
				properties: { uri: { type: "string", description: "Resource URI to read" } },
				required: ["uri"],
			}),
			async execute(_toolCallId: string, args: { uri?: string }): Promise<AgentToolResult<Record<string, unknown>>> {
				if (!args.uri) {
					return { content: [{ type: "text", text: "Missing resource uri" }], details: {} };
				}
				try {
					const contents = await client.readResource(args.uri);
					const text = contents.map((c) => c.text ?? c.blob ?? "").join("\n");
					return { content: [{ type: "text", text }], details: { uri: args.uri } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Failed to read resource: ${message}` }],
						details: { error: message },
					};
				}
			},
		});
		results.push({ toolName: names.read, registered: true });
	}

	return results;
}

/** Register all tools + resources for a connected client. */
export function bridgeConnectedClient(
	pi: ExtensionAPI,
	client: McpClient,
	tools: McpToolLike[],
	registry: ToolNameRegistry,
): BridgeOutcome {
	const outcome: BridgeOutcome = { registered: [], skipped: [] };

	const record = (result: RegistrationResult): void => {
		if (result.registered) outcome.registered.push(result.toolName);
		else outcome.skipped.push(result);
	};

	for (const tool of tools) {
		try {
			record(registerMcpTool(pi, client, tool, registry));
		} catch (error) {
			// A single tool failing to register must not abort the rest.
			outcome.skipped.push({
				toolName: toolNameFor(client.name, tool.name),
				registered: false,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Tools-only servers are common; registering resource tools for one would
	// only add tools whose every call fails with -32601.
	if (client.supportsResources) {
		try {
			for (const result of registerMcpResources(pi, client, registry)) record(result);
		} catch (error) {
			// Resources are optional: not every server exposes them.
			outcome.skipped.push({
				toolName: resourceToolNames(client.name).list,
				registered: false,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return outcome;
}
