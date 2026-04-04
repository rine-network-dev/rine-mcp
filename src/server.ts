#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	HttpClient,
	getCredentialEntry,
	getOrRefreshToken,
	resolveApiUrl,
	resolveConfigDir,
	type TokenFn,
} from "@rine-network/core";
import { tools, type ToolContext } from "./tools/index.js";

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

// ---------------------------------------------------------------------------
// Bootstrap: config, HTTP client, tool context
// ---------------------------------------------------------------------------

const configDir = resolveConfigDir();
const apiUrl = resolveApiUrl();

const profileName = "default";
const entry = getCredentialEntry(configDir, profileName);
const envToken = process.env.RINE_TOKEN;
const canRefresh = !envToken && entry !== undefined;

const tokenFn: TokenFn = (force = false) =>
	getOrRefreshToken(configDir, apiUrl, entry, profileName, { force, envToken });

const client = new HttpClient({ tokenFn, apiUrl, canRefresh });
const toolCtx: ToolContext = { client, configDir, apiUrl };

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const toolMap = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
	{ name: SERVER_NAME, version: SERVER_VERSION },
	{
		capabilities: { tools: {} },
		instructions: SERVER_INSTRUCTIONS,
	},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	})),
}));

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
		const result = await tool.handler(
			toolCtx,
			(params as Record<string, unknown>) ?? {},
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
	console.error(`${SERVER_NAME} MCP server v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
