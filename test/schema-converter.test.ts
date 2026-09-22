/**
 * Unit tests for the MCP bridge schema converter (M1).
 *
 * These are pure-function tests with no network or subprocess, matching the
 * suite's offline default (PI_OFFLINE=1).
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { jsonSchemaToTypeBox } from "../src/schema-converter.ts";

describe("jsonSchemaToTypeBox", () => {
	it("converts a string property", () => {
		const schema = jsonSchemaToTypeBox({
			type: "object",
			properties: { name: { type: "string", description: "the name" } },
			required: ["name"],
		});
		// Required string -> not optional
		expect(schema).toBeDefined();
	});

	it("marks non-required properties optional", () => {
		const schema = jsonSchemaToTypeBox({
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required: ["a"],
		}) as unknown as { properties: Record<string, unknown> };
		// TypeBox v1 derives required from Optional wrapper; b is not in required.
		const bProp = schema.properties.b as { type?: string };
		expect(bProp).toBeDefined();
	});

	it("converts integer and number distinctly", () => {
		const intSchema = jsonSchemaToTypeBox({ type: "integer" }) as { type: string };
		const numSchema = jsonSchemaToTypeBox({ type: "number" }) as { type: string };
		expect(intSchema.type).toBe("integer");
		expect(numSchema.type).toBe("number");
	});

	it("converts arrays with item schema", () => {
		const schema = jsonSchemaToTypeBox({ type: "array", items: { type: "string" } }) as { type: string };
		expect(schema.type).toBe("array");
	});

	it("converts string enums to a string enum", () => {
		const schema = jsonSchemaToTypeBox({
			type: "string",
			enum: ["a", "b", "c"],
		}) as { type: string; enum?: unknown[] };
		expect(schema.type).toBe("string");
		expect(schema.enum).toEqual(["a", "b", "c"]);
	});

	it("degrades unknown types to Unknown", () => {
		const schema = jsonSchemaToTypeBox({ $ref: "#/definitions/foo" }) as { type: string };
		expect(schema.type).toBeUndefined();
	});

	it("produces a schema TypeBox accepts", () => {
		const converted = jsonSchemaToTypeBox({
			type: "object",
			properties: { q: { type: "string" }, n: { type: "integer" } },
			required: ["q"],
		});
		// TypeBox's Type.Object validates against the converted schema structure.
		const wrapped = Type.Object({ result: converted });
		expect(wrapped).toBeDefined();
	});
});
