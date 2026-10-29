import { describe, expect, it, vi } from "vitest";
import { tools } from "../src/tools/index.js";
import { missingRequired } from "../src/tools/require-args.js";
import type { ToolContext } from "../src/tools/types.js";

const ctx = {} as ToolContext;
const call = (name: string, params: Record<string, unknown>) => {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	return tool.handler(ctx, params);
};

describe("a call that omits a required argument", () => {
	it("is refused by name before rine_send posts anything", async () => {
		const post = vi.fn();
		const withClient = { client: { post } } as unknown as ToolContext;
		const send = tools.find((t) => t.name === "rine_send");
		await expect(send?.handler(withClient, { to: "kofi@acme.rine.network" })).rejects.toThrow(
			"rine_send needs payload",
		);
		expect(post).not.toHaveBeenCalled();
	});

	it("names every missing argument on rine_reply", async () => {
		await expect(call("rine_reply", {})).rejects.toThrow("rine_reply needs message_id, payload");
	});

	it("treats a null argument as missing", async () => {
		await expect(call("rine_send", { to: null, payload: "x" })).rejects.toThrow("rine_send needs to");
	});

	it("still lets a group be named by its id spelling", async () => {
		await expect(call("rine_group_inspect", { group_id: "" })).rejects.toThrow(
			"group is required",
		);
	});

	it("leaves an omitted group to the group reference's own guidance", async () => {
		await expect(call("rine_group_inspect", {})).rejects.toThrow(
			"group is required: a group's whole handle",
		);
	});
});

describe("an argument whose handler already crafts the refusal", () => {
	const tool = (name: string) => {
		const found = tools.find((t) => t.name === name);
		if (!found) throw new Error(`no tool ${name}`);
		return found;
	};

	it("is not reported for an omitted visibility, which the server refuses in its own words", () => {
		expect(missingRequired(tool("rine_group_create"), { name: "ops" })).toEqual([]);
	});

	it("is not reported for an omitted vote, which rine_group_vote refuses by name", () => {
		expect(missingRequired(tool("rine_group_vote"), { group: "g", request_id: "r" })).toEqual([]);
	});

	it("is not reported for an omitted group on any group tool", () => {
		expect(missingRequired(tool("rine_group_remove"), { agent_id: "a" })).toEqual([]);
	});

	it("still reports the arguments that have no crafted refusal beside it", () => {
		expect(missingRequired(tool("rine_group_create"), {})).toEqual(["name"]);
		expect(missingRequired(tool("rine_group_vote"), {})).toEqual(["request_id"]);
	});
});
