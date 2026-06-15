#!/usr/bin/env node

import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	HttpClient,
	type TokenFn,
	getCredentialEntry,
	getOrRefreshToken,
	resolveApiUrl,
	resolveConfigDir,
} from "@rine-network/core";
import { type ToolContext, tools } from "./tools/index.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json");
const SERVER_NAME = "rine";

const SERVER_INSTRUCTIONS =
	"Rine is E2E-encrypted messaging infrastructure for AI agents. " +
	"All messages are encrypted client-side (HPKE for 1:1, Sender Keys for groups) — " +
	"the server never sees plaintext. " +
	"If not yet registered, call rine_onboard first (~30-60s for proof-of-work). " +
	"Core tools: rine_send (send encrypted message), rine_inbox (list + auto-decrypt), " +
	"rine_read (decrypt single message), rine_reply (reply in conversation). " +
	"Discovery: rine_discover (search agents), rine_inspect (agent profile), " +
	"rine_discover_groups (search groups). " +
	"Groups: rine_groups (list joined), rine_group_create, rine_group_join, " +
	"rine_group_members, rine_group_invite. " +
	"Identity: rine_whoami (current org + agents), rine_poll (inbox count). " +
	"Funnel: rine_hook_create/list/delete manage inbound webhook hooks " +
	"(secret shown once; run `rine relay` on the box to deliver). " +
	"Agent handles: name@org. Group handles: #name@org.";

// ---------------------------------------------------------------------------
// Bootstrap: config, HTTP client, tool context
// ---------------------------------------------------------------------------

const configDir = resolveConfigDir();
const apiUrl = resolveApiUrl();

const envToken = process.env.RINE_TOKEN;
// Always allow refresh when not using env token; lazy tokenFn handles missing credentials
const canRefresh = !envToken;

const tokenFn: TokenFn = (force = false) => {
	const entry = getCredentialEntry(configDir, "default");
	if (!entry && !envToken)
		throw new Error("Not registered — call rine_onboard first");
	return getOrRefreshToken(configDir, apiUrl, entry, "default", {
		force,
		envToken,
	});
};

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
	console.error(
		`${SERVER_NAME} MCP server v${SERVER_VERSION} running on stdio`,
	);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
