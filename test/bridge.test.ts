/**
 * Bridge core: registering MCP tools as pi tools and forwarding execute().
 *
 * Uses a structural mock of McpClient (no subprocess, no network). Registration
 * is captured through a stub ExtensionAPI so `execute` can be invoked directly,
 * which tests the forwarding path without driving a whole agent session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { bridgeConnectedClient } from "../src/bridge.ts";
import type { McpClient } from "../src/client.ts";
import { ToolNameRegistry } from "../src/naming.ts";

interface CapturedTool {
  name: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;
}

/** Structural mock of McpClient for offline testing. */
function mockClient(name: string) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fake: McpClient = {
    name,
    async callTool(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      return {
        content: [{ type: "text", text: `result-of-${tool}` }],
        isError: false,
      };
    },
    async listResources() {
      return [{ uri: "file:///a", name: "A" }];
    },
    async readResource(uri: string) {
      return [{ uri, text: `content-of-${uri}` }];
    },
  } as unknown as McpClient;

  return { fake, calls };
}

/** Minimal ExtensionAPI stub that records registered tools. */
function stubApi() {
  const tools: CapturedTool[] = [];
  const pi = {
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  const byName = (name: string) => tools.find((tool) => tool.name === name);
  return { pi, tools, byName, names: () => tools.map((tool) => tool.name) };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

const ECHO_TOOL = { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } };

describe("MCP bridge core", () => {
  it("registers MCP tools and resources and reports the outcome", () => {
    const api = stubApi();
    const outcome = bridgeConnectedClient(api.pi, mockClient("fs").fake, [ECHO_TOOL], new ToolNameRegistry());

    expect(outcome.skipped).toEqual([]);
    expect(outcome.registered).toEqual(["mcp_fs_read_file", "mcp_fs_resources", "mcp_fs_resource_read"]);
    expect(api.names()).toEqual(outcome.registered);
  });

  it("forwards execute() to the MCP client and maps content back", async () => {
    const { fake, calls } = mockClient("fs");
    const api = stubApi();
    bridgeConnectedClient(api.pi, fake, [ECHO_TOOL], new ToolNameRegistry());

    const tool = api.byName("mcp_fs_read_file");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call-1", { path: "/tmp/x" });

    expect(calls).toEqual([{ tool: "read_file", args: { path: "/tmp/x" } }]);
    expect(textOf(result)).toContain("result-of-read_file");
  });

  it("surfaces MCP tool errors as text content instead of throwing", async () => {
    const failing = mockClient("bad");
    failing.fake.callTool = (async () => {
      throw new Error("boom");
    }) as unknown as McpClient["callTool"];

    const api = stubApi();
    bridgeConnectedClient(api.pi, failing.fake, [{ name: "will_fail", inputSchema: { type: "object" } }], new ToolNameRegistry());

    const result = await api.byName("mcp_bad_will_fail")!.execute("call-1", {});
    expect(textOf(result)).toContain("failed");
    expect(textOf(result)).toContain("boom");
  });

  it("exposes resources as a list tool and a read tool", async () => {
    const api = stubApi();
    bridgeConnectedClient(api.pi, mockClient("fs").fake, [], new ToolNameRegistry());

    const listed = await api.byName("mcp_fs_resources")!.execute("call-1", {});
    expect(textOf(listed)).toContain("file:///a");

    const read = await api.byName("mcp_fs_resource_read")!.execute("call-1", { uri: "file:///a" });
    expect(textOf(read)).toContain("content-of-file:///a");
  });

  it("skips a tool whose name is already owned by another server", () => {
    const api = stubApi();
    const registry = new ToolNameRegistry();

    // `my-server` and `my_server` both normalize to `my_server`, so the second
    // server must not silently shadow the first.
    const first = bridgeConnectedClient(
      api.pi,
      mockClient("my-server").fake,
      [{ name: "read", inputSchema: { type: "object" } }],
      registry,
    );
    const second = bridgeConnectedClient(
      api.pi,
      mockClient("my_server").fake,
      [{ name: "read", inputSchema: { type: "object" } }],
      registry,
    );

    expect(first.registered).toEqual([
      "mcp_my_server_read",
      "mcp_my_server_resources",
      "mcp_my_server_resource_read",
    ]);
    expect(second.registered).toEqual([]);
    expect(second.skipped.map((entry) => entry.toolName)).toEqual(first.registered);
    expect(second.skipped[0].reason).toContain('server "my-server"');
    // Nothing was registered twice: the first server keeps the names.
    expect(api.names()).toEqual(first.registered);
  });

  it("treats two tools of one server as a collision when they normalize alike", () => {
    const api = stubApi();
    const registry = new ToolNameRegistry();
    const outcome = bridgeConnectedClient(
      api.pi,
      mockClient("s").fake,
      [
        { name: "read file", inputSchema: { type: "object" } },
        { name: "read_file", inputSchema: { type: "object" } },
      ],
      registry,
    );

    expect(outcome.registered).toContain("mcp_s_read_file");
    expect(outcome.skipped.map((entry) => entry.toolName)).toContain("mcp_s_read_file");
  });

  it("allows the same server to re-register the same tool", () => {
    const api = stubApi();
    const registry = new ToolNameRegistry();

    bridgeConnectedClient(api.pi, mockClient("fs").fake, [ECHO_TOOL], registry);
    const second = bridgeConnectedClient(api.pi, mockClient("fs").fake, [ECHO_TOOL], registry);

    // A reconnect re-registers idempotently; pi overwrites by name.
    expect(second.skipped).toEqual([]);
    expect(second.registered).toEqual(["mcp_fs_read_file", "mcp_fs_resources", "mcp_fs_resource_read"]);
    expect(api.tools).toHaveLength(6);
  });

  it("degrades gracefully when a tool has no usable input schema", () => {
    const api = stubApi();
    const outcome = bridgeConnectedClient(
      api.pi,
      mockClient("fs").fake,
      [{ name: "no_schema", inputSchema: {} as Record<string, unknown> }],
      new ToolNameRegistry(),
    );

    expect(outcome.registered).toContain("mcp_fs_no_schema");
    expect(api.byName("mcp_fs_no_schema")!.parameters).toBeDefined();
  });
});
