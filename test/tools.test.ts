import { describe, expect, it } from "vitest";
import { ACTING_AGENT_PARAM } from "../src/tools/group-actors.js";
import { tools } from "../src/tools/index.js";

/**
 * The tools whose `agent` is NOT the acting agent.
 *
 * `rine_inspect` looks an agent UP — its `agent` is the subject of the lookup,
 * is required, and takes no auth at all. It is the one place where the same
 * word means something else, so it is named here rather than left to be
 * discovered.
 */
const NON_ACTOR_AGENT_TOOLS = ["rine_inspect"];

describe("tool definitions", () => {
	it("exports 32 tools", () => {
		expect(tools).toHaveLength(32);
	});

	it("all tools have unique names", () => {
		const names = tools.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("all tool names start with rine_", () => {
		for (const t of tools) {
			expect(t.name).toMatch(/^rine_/);
		}
	});

	it("all tools have description and inputSchema", () => {
		for (const t of tools) {
			expect(t.description).toBeTruthy();
			expect(t.inputSchema).toBeDefined();
			expect(typeof t.handler).toBe("function");
		}
	});

	// `agent` is the acting agent on the group verbs, which the message and hook
	// tools already spelled that way with words of their own. One name
	// for one concept is only worth having if an agent reading the manifest sees
	// one explanation of it, so the description is a single constant and this is
	// what keeps a new tool from quietly minting a second wording.
	it("describes the acting agent identically on every tool that takes one", () => {
		const actors = tools.filter(
			(t) =>
				!NON_ACTOR_AGENT_TOOLS.includes(t.name) &&
				(t.inputSchema as { properties?: Record<string, unknown> }).properties
					?.agent !== undefined,
		);
		// Guards the guard: a rename that dropped the parameter everywhere would
		// otherwise leave this test iterating an empty list and passing.
		expect(actors.length).toBeGreaterThan(10);

		for (const t of actors) {
			const props = (
				t.inputSchema as {
					properties: Record<string, { description?: string }>;
				}
			).properties;
			expect(
				props.agent.description,
				`${t.name} describes the acting agent in words of its own`,
			).toBe(ACTING_AGENT_PARAM.description);
		}
	});
});
