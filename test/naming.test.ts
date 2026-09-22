/**
 * Unit tests for the MCP bridge naming rules and tool-name ownership.
 */

import { describe, expect, it } from "vitest";
import {
	normalizeName,
	resourceToolNames,
	ToolNameRegistry,
	toolNameFor,
} from "../src/naming.ts";

describe("normalizeName", () => {
	it("lowercases and replaces invalid chars with underscores", () => {
		expect(normalizeName("Get File")).toBe("get_file");
		expect(normalizeName("Get-File")).toBe("get_file");
		expect(normalizeName("get.file")).toBe("get_file");
	});

	it("trims leading and trailing underscores", () => {
		expect(normalizeName("  foo  ")).toBe("foo");
		expect(normalizeName("!!!")).toBe("unnamed");
	});

	it("returns 'unnamed' for empty/whitespace", () => {
		expect(normalizeName("")).toBe("unnamed");
		expect(normalizeName("___")).toBe("unnamed");
	});
});

describe("toolNameFor", () => {
	it("prefixes with mcp_<server>_<tool>", () => {
		expect(toolNameFor("filesystem", "read_file")).toBe("mcp_filesystem_read_file");
	});

	it("normalizes server and tool names", () => {
		expect(toolNameFor("My Server", "Read File")).toBe("mcp_my_server_read_file");
	});
});

describe("resourceToolNames", () => {
	it("derives both resource tool names from the server name", () => {
		expect(resourceToolNames("My Server")).toEqual({
			list: "mcp_my_server_resources",
			read: "mcp_my_server_resource_read",
		});
	});
});

describe("ToolNameRegistry", () => {
	it("reports the first claim as new", () => {
		const registry = new ToolNameRegistry();
		expect(registry.claim("mcp_a_x", "a", "x")).toBe("new");
		expect(registry.activeNames()).toEqual(["mcp_a_x"]);
	});

	it("treats the same server re-registering the same tool as a reregister", () => {
		const registry = new ToolNameRegistry();
		registry.claim("mcp_a_x", "a", "x");
		expect(registry.claim("mcp_a_x", "a", "x")).toBe("reregister");
	});

	it("detects two servers whose names normalize to the same tool name", () => {
		const registry = new ToolNameRegistry();
		// `my-server` and `my_server` both normalize to `my_server`.
		expect(registry.claim(toolNameFor("my-server", "read"), "my-server", "read")).toBe("new");
		const colliding = toolNameFor("my_server", "read");
		expect(registry.claim(colliding, "my_server", "read")).toBe("collision");
		expect(registry.ownerOf(colliding)).toEqual({ server: "my-server", raw: "read" });
	});

	it("detects two tools of one server colliding on a normalized name", () => {
		const registry = new ToolNameRegistry();
		expect(registry.claim(toolNameFor("s", "read file"), "s", "read file")).toBe("new");
		// A different raw tool name that normalizes to the same Pi tool name.
		expect(registry.claim(toolNameFor("s", "read_file"), "s", "read_file")).toBe("collision");
	});

	it("keeps released names known so they can be retired from the active set", () => {
		const registry = new ToolNameRegistry();
		registry.claim("mcp_a_x", "a", "x");
		registry.claim("mcp_b_y", "b", "y");

		expect(registry.releaseServer("a")).toEqual(["mcp_a_x"]);
		expect(registry.activeNames()).toEqual(["mcp_b_y"]);
		// Pi cannot unregister a tool, so the name must stay known.
		expect(registry.knownNames().sort()).toEqual(["mcp_a_x", "mcp_b_y"]);
	});

	it("reactivates a name when its server reconnects", () => {
		const registry = new ToolNameRegistry();
		registry.claim("mcp_a_x", "a", "x");
		registry.releaseServer("a");
		expect(registry.activeNames()).toEqual([]);

		expect(registry.claim("mcp_a_x", "a", "x")).toBe("reregister");
		expect(registry.activeNames()).toEqual(["mcp_a_x"]);
	});

	it("does not release a name twice", () => {
		const registry = new ToolNameRegistry();
		registry.claim("mcp_a_x", "a", "x");
		registry.releaseServer("a");
		expect(registry.releaseServer("a")).toEqual([]);
	});
});
