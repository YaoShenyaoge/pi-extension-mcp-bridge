/**
 * M2 — MCP client wrapper.
 *
 * Wraps the `@modelcontextprotocol/sdk` Client for both stdio and streamable
 * HTTP transports. The bridge core (M3) depends only on this clean interface,
 * so transport wiring stays isolated here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	type CallToolResult,
	CallToolResultSchema,
	type Resource,
	type ResourceTemplate,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { type McpServerConfig, serverConfigError } from "./config.ts";

/** The content blocks we actually consume (text / image / resource). */
export type McpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } };

/** Normalized result of a tool call, ready for the bridge to map to a Pi result. */
export interface ToolCallOutcome {
	content: McpContentBlock[];
	isError: boolean;
}

/** Narrow an SDK content block (with optional annotations/_meta) to the fields we consume. */
function narrowContentBlock(block: {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri: string; text?: string; blob?: string; mimeType?: string };
}): McpContentBlock {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text ?? "" };
		case "image":
			return { type: "image", data: block.data ?? "", mimeType: block.mimeType ?? "application/octet-stream" };
		case "resource":
			return {
				type: "resource",
				resource: {
					uri: block.resource?.uri ?? "",
					text: block.resource?.text,
					blob: block.resource?.blob,
					mimeType: block.resource?.mimeType,
				},
			};
		default:
			// Unknown content types (audio, resource_link, future) degrade to text.
			return { type: "text", text: JSON.stringify(block) };
	}
}

/** How much trailing stderr to retain per server for diagnostics. */
const STDERR_TAIL_LIMIT = 4096;

export class McpClient {
	readonly name: string;
	private readonly config: McpServerConfig;
	private readonly client: Client;
	private connected = false;
	private stderrText = "";

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
		this.client = new Client({ name: `pi-mcp-bridge/${name}`, version: "0.1.0" });
	}

	get isConnected(): boolean {
		return this.connected;
	}

	/** Trailing stderr of the stdio child, retained for error reporting. */
	get stderrTail(): string {
		return this.stderrText;
	}

	/**
	 * Whether the connected server advertises the `resources` capability.
	 *
	 * Servers are free to implement tools only. Registering resource tools
	 * against such a server would produce tools whose every call fails with
	 * -32601, so the bridge asks before it registers them.
	 */
	get supportsResources(): boolean {
		return this.client.getServerCapabilities()?.resources !== undefined;
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		if (this.config.url !== undefined) {
			await this.client.connect(new StreamableHTTPClientTransport(new URL(this.config.url)));
			this.connected = true;
			return;
		}

		const command = this.config.command;
		if (command === undefined) {
			throw new Error(`MCP server "${this.name}": ${serverConfigError(this.config) ?? "invalid config"}`);
		}

		const transport = new StdioClientTransport({
			command,
			args: this.config.args,
			env: this.config.env,
			cwd: this.config.cwd,
			stderr: "pipe",
		});
		this.drainStderr(transport);
		await this.client.connect(transport);
		this.connected = true;
	}

	/**
	 * Consume the child's stderr.
	 *
	 * With `stderr: "pipe"` the SDK pipes the child's stderr into a PassThrough.
	 * An unread PassThrough fills its buffer and then applies backpressure, which
	 * blocks the child as soon as it logs more than a buffer's worth — a verbose
	 * server would hang. Retaining a bounded tail both prevents that and gives
	 * `/mcp status` something to show when a server misbehaves.
	 */
	private drainStderr(transport: StdioClientTransport): void {
		const stream = transport.stderr;
		if (!stream) return;
		stream.on("data", (chunk: Buffer | string) => {
			const next = this.stderrText + chunk.toString();
			this.stderrText = next.length > STDERR_TAIL_LIMIT ? next.slice(-STDERR_TAIL_LIMIT) : next;
		});
		// A broken stderr pipe is diagnostic-only and must never fail the bridge.
		stream.on("error", () => {});
	}

	async close(): Promise<void> {
		if (!this.connected) return;
		await this.client.close();
		this.connected = false;
	}

	async listTools(): Promise<Tool[]> {
		const result = await this.client.listTools();
		return result.tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
		const result = (await this.client.callTool({ name, arguments: args }, CallToolResultSchema)) as CallToolResult;
		return {
			content: result.content.map(narrowContentBlock),
			isError: result.isError === true,
		};
	}

	async listResources(): Promise<Resource[]> {
		const result = await this.client.listResources();
		return result.resources;
	}

	async listResourceTemplates(): Promise<ResourceTemplate[]> {
		const result = await this.client.listResourceTemplates();
		return result.resourceTemplates;
	}

	async readResource(
		uri: string,
	): Promise<ReadonlyArray<{ uri: string; text?: string; blob?: string; mimeType?: string }>> {
		const result = await this.client.readResource({ uri });
		return result.contents;
	}
}
