import type { ToolDef } from "./types.js";

/**
 * Required arguments whose omission a tool already answers in words of its own, so the
 * generic refusal below must not pre-empt them:
 * - `group`: `groupRefArgument` explains the spellings a group may take, and reads
 *   `group_id` as well.
 * - `visibility`: `rine_group_create` leaves it to the server, whose refusal names both
 *   choices and what each does.
 * - `vote`: `rine_group_vote` names the two accepted values.
 */
const REFUSED_BY_HANDLER: ReadonlySet<string> = new Set(["group", "visibility", "vote"]);

const isGiven = (value: unknown) => value !== undefined && value !== null;

/**
 * The arguments a tool declares `required` that a call left out, minus the ones a
 * handler refuses in its own words ({@link REFUSED_BY_HANDLER}). The MCP server does
 * not validate a call against `inputSchema`, so without this a send with no `payload`
 * seals `JSON.stringify(undefined)`, an empty message, and reports success.
 */
export function missingRequired(
	tool: Pick<ToolDef, "inputSchema">,
	params: Record<string, unknown>,
): string[] {
	const required = tool.inputSchema.required;
	if (!Array.isArray(required)) return [];
	return required.filter(
		(name): name is string =>
			typeof name === "string" && !REFUSED_BY_HANDLER.has(name) && !isGiven(params[name]),
	);
}

/** The same tool, refusing a call that omits an argument its schema requires. */
export function withRequiredArgs(tool: ToolDef): ToolDef {
	return {
		...tool,
		handler: async (ctx, params) => {
			const missing = missingRequired(tool, params);
			if (missing.length > 0) {
				throw new Error(`${tool.name} needs ${missing.join(", ")}`);
			}
			return tool.handler(ctx, params);
		},
	};
}
