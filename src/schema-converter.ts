/**
 * M1 — JSON Schema to TypeBox converter.
 *
 * MCP tools declare parameters as JSON Schema (`inputSchema`). Pi tools require a
 * TypeBox `TSchema` for `parameters`. This module maps the common JSON Schema
 * subset to TypeBox constructors.
 *
 * Unsupported constructs degrade gracefully to `Type.Unknown` rather than
 * throwing, so a tool with an exotic schema still registers (the LLM just gets a
 * loose schema).
 */

import { type TSchema, Type } from "typebox";

/**
 * A JSON Schema object as returned by MCP `tools/list`. We only rely on the
 * fields we map; anything unknown is ignored.
 */
export interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	const?: unknown;
	description?: string;
	default?: unknown;
	format?: string;
	// oneOf / anyOf / allOf — treated as union / unknown
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
	allOf?: JsonSchema[];
	$ref?: string;
	additionalProperties?: boolean | JsonSchema;
}

/** Copy common schema options that TypeBox accepts on every constructor. */
function commonOptions(schema: JsonSchema): Record<string, unknown> {
	const opts: Record<string, unknown> = {};
	if (schema.description !== undefined) opts.description = schema.description;
	if (schema.default !== undefined) opts.default = schema.default;
	return opts;
}

function convertString(schema: JsonSchema): TSchema {
	const opts = commonOptions(schema);
	// enum on a string -> string enum (matches MCP's string enums)
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const values = schema.enum.filter((v): v is string => typeof v === "string");
		if (values.length === schema.enum.length) {
			return Type.Unsafe({ type: "string", enum: values, ...opts });
		}
	}
	if (schema.format !== undefined) {
		// Type.String accepts `format` as a string union; unknown formats are
		// tolerated by TypeBox as custom format names.
		(opts as Record<string, unknown>).format = schema.format;
	}
	return Type.String(opts as never);
}

function convertNumber(schema: JsonSchema, integer: boolean): TSchema {
	const opts = commonOptions(schema);
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const values = schema.enum.filter((v): v is number => typeof v === "number");
		if (values.length === schema.enum.length) {
			return Type.Enum(values, opts as never);
		}
	}
	return integer ? Type.Integer(opts as never) : Type.Number(opts as never);
}

function convertArray(schema: JsonSchema): TSchema {
	const opts = commonOptions(schema);
	const items = schema.items ? convertSchema(schema.items) : Type.Unknown();
	return Type.Array(items, opts as never);
}

function convertObject(schema: JsonSchema): TSchema {
	const opts = commonOptions(schema);
	const properties: Record<string, TSchema> = {};
	const required = new Set(schema.required ?? []);

	for (const [key, value] of Object.entries(schema.properties ?? {})) {
		const converted = convertSchema(value);
		// TypeBox v1 derives `required` from non-Optional properties.
		properties[key] = required.has(key) ? converted : Type.Optional(converted);
	}

	// additionalProperties: false -> reject extra keys. Otherwise leave open.
	if (schema.additionalProperties === false) {
		(opts as Record<string, unknown>).additionalProperties = false;
	}

	return Type.Object(properties, opts as never);
}

function convertConst(schema: JsonSchema): TSchema {
	const v = schema.const;
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
		return Type.Literal(v, commonOptions(schema) as never);
	}
	return Type.Unknown(commonOptions(schema) as never);
}

/**
 * Convert a JSON Schema object into a TypeBox schema.
 *
 * Supported: string (with enum/format), number/integer, boolean, object,
 * array, enum, const, oneOf/anyOf (as union). `$ref`, `allOf`, and other
 * advanced constructs degrade to `Type.Unknown`.
 */
export function jsonSchemaToTypeBox(schema: JsonSchema): TSchema {
	if (!schema || typeof schema !== "object") {
		return Type.Unknown();
	}

	if (schema.$ref !== undefined) {
		// We don't resolve references; degrade.
		return Type.Unknown(commonOptions(schema) as never);
	}

	// enum at the top level (no type, or type string/number)
	if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.type === undefined) {
		const allString = schema.enum.every((v) => typeof v === "string");
		const allNumber = schema.enum.every((v) => typeof v === "number");
		if (allString) {
			return Type.Unsafe({ type: "string", enum: schema.enum, ...commonOptions(schema) });
		}
		if (allNumber) {
			return Type.Enum(schema.enum as number[], commonOptions(schema) as never);
		}
	}

	if (schema.const !== undefined && schema.type === undefined) {
		return convertConst(schema);
	}

	// oneOf / anyOf -> union
	const union = schema.oneOf ?? schema.anyOf;
	if (Array.isArray(union) && union.length > 0) {
		const members = union.map(convertSchema);
		if (members.length === 1) return members[0];
		return Type.Union(members as [TSchema, ...TSchema[]], commonOptions(schema) as never);
	}

	// allOf — unsupported, degrade
	if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
		return Type.Unknown(commonOptions(schema) as never);
	}

	// type can be an array (e.g. ["string", "null"]) — take the first
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

	switch (type) {
		case "string":
			return convertString(schema);
		case "number":
			return convertNumber(schema, false);
		case "integer":
			return convertNumber(schema, true);
		case "boolean":
			return Type.Boolean(commonOptions(schema) as never);
		case "null":
			return Type.Null(commonOptions(schema) as never);
		case "array":
			return convertArray(schema);
		case "object":
			return convertObject(schema);
		default:
			return Type.Unknown(commonOptions(schema) as never);
	}
}

/** Alias kept for call-site clarity. */
export function convertSchema(schema: JsonSchema): TSchema {
	return jsonSchemaToTypeBox(schema);
}
