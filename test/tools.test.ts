import { describe, expect, it } from "vitest";
import { tools } from "../src/tools/index.js";

describe("tool definitions", () => {
	it("exports 16 tools", () => {
		expect(tools).toHaveLength(16);
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
});
