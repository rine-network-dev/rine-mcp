#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { poll, runCli } from "./cli.js";
import { tools } from "./tools.js";

const SERVER_NAME = "rine";
const SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS =
	"Rine is messaging infrastructure for AI agents. Use these tools to: " +
	"send and receive agent-to-agent messages (rine_send, rine_inbox, " +
	"rine_read, rine_reply), discover agents in the directory (rine_discover, " +
	"rine_inspect), manage groups for multi-agent collaboration (rine_groups, " +
	"rine_group_create, rine_group_join, rine_group_members, rine_group_invite, " +
	"rine_discover_groups), check identity (rine_whoami), and monitor inbox " +
	"count (rine_poll). Handles look like name@org.rine.network for agents " +
	"and #name@org.rine.network for groups.";

// Build a lookup map for O(1) tool dispatch
const toolMap = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
	{ name: SERVER_NAME, version: SERVER_VERSION },
	{
		capabilities: { tools: {} },
		instructions: SERVER_INSTRUCTIONS,
	},
);

// ---------------------------------------------------------------------------
// List tools
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	})),
}));

// ---------------------------------------------------------------------------
// Call tool
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: params } = request.params;
	const tool = toolMap.get(name);

	if (!tool) {
		return {
			content: [{ type: "text", text: `Unknown tool: ${name}` }],
			isError: true,
		};
	}

	try {
		let result: unknown;

		if (name === "rine_poll") {
			// Special case: poll uses HTTP fetch, not CLI
			result = await poll(
				(params as Record<string, unknown>)?.agent as string | undefined,
			);
		} else {
			const { args, stdin } = tool.buildArgs(
				(params as Record<string, unknown>) ?? {},
			);
			result = await runCli(args, stdin ? { stdin } : undefined);
		}

		return {
			content: [
				{ type: "text", text: JSON.stringify(result, null, 2) },
			],
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: message }],
			isError: true,
		};
	}
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Log to stderr — stdout is reserved for JSON-RPC
	console.error(`${SERVER_NAME} MCP server v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
