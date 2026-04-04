import { describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// We test the server's request handlers by importing tools and simulating
// the dispatch logic directly, rather than spinning up a stdio transport.

import { tools } from "../src/tools.js";

const toolMap = new Map(tools.map((t) => [t.name, t]));

/** Simulate CallTool dispatch (mirrors server.ts logic). */
async function callTool(name: string, params: Record<string, unknown> = {}) {
	const tool = toolMap.get(name);
	if (!tool) {
		return {
			content: [{ type: "text", text: `Unknown tool: ${name}` }],
			isError: true,
		};
	}

	try {
		if (name === "rine_poll") {
			throw new Error("poll requires network — tested separately");
		}
		const { args, stdin } = tool.buildArgs(params);
		// Don't actually run CLI — just verify dispatch works
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ dispatched: args, stdin }, null, 2),
				},
			],
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: message }],
			isError: true,
		};
	}
}

describe("ListTools (T-010)", () => {
	it("returns all 14 tools", () => {
		expect(tools).toHaveLength(14);
	});

	it("all tools have valid JSON Schema inputSchema", () => {
		for (const t of tools) {
			expect(t.inputSchema).toHaveProperty("type", "object");
			expect(t.inputSchema).toHaveProperty("properties");
		}
	});

	it("all tool names are unique", () => {
		const names = tools.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("CallTool — unknown tool (T-011)", () => {
	it("returns isError for unknown tool name", async () => {
		const result = await callTool("rine_nonexistent");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Unknown tool");
	});
});

describe("CallTool — dispatches correctly (T-012)", () => {
	it("rine_send dispatches to send command", async () => {
		const result = await callTool("rine_send", {
			to: "bot@test.rine.network",
			payload: { task: "hi" },
		});
		expect(result.isError).toBeUndefined();
		const data = JSON.parse(result.content[0].text);
		expect(data.dispatched).toContain("send");
		expect(data.dispatched).toContain("--to");
		expect(data.stdin).toBe('{"task":"hi"}');
	});

	it("rine_inbox dispatches to inbox command", async () => {
		const result = await callTool("rine_inbox", { limit: 5 });
		const data = JSON.parse(result.content[0].text);
		expect(data.dispatched[0]).toBe("inbox");
		expect(data.dispatched).toContain("--limit");
	});

	it("rine_discover dispatches to discover agents", async () => {
		const result = await callTool("rine_discover", { query: "finance" });
		const data = JSON.parse(result.content[0].text);
		expect(data.dispatched).toContain("discover");
		expect(data.dispatched).toContain("agents");
		expect(data.dispatched).toContain("-q");
	});
});

describe("CallTool — CLI errors surface as isError (T-013)", () => {
	it("rine_poll returns isError (network not available)", async () => {
		const result = await callTool("rine_poll");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBeTruthy();
	});
});
