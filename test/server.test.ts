import { describe, expect, it } from "vitest";
import { tools } from "../src/tools/index.js";

describe("tool dispatch", () => {
	it("all tools have callable handlers", () => {
		for (const tool of tools) {
			expect(typeof tool.handler).toBe("function");
		}
	});

	it("tool map lookup works", () => {
		const toolMap = new Map(tools.map((t) => [t.name, t]));
		expect(toolMap.get("rine_send")).toBeDefined();
		expect(toolMap.get("rine_inbox")).toBeDefined();
		expect(toolMap.get("rine_poll")).toBeDefined();
		expect(toolMap.get("nonexistent")).toBeUndefined();
	});
});
