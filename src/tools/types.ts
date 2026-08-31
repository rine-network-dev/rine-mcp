import type { HttpClient } from "@rine-network/core";

export interface ToolContext {
	client: HttpClient;
	configDir: string;
	apiUrl: string;
}

/** The arguments one tool call carried, as the MCP server hands them over. */
export type ToolParams = Record<string, unknown>;

export type ToolHandler = (
	ctx: ToolContext,
	params: ToolParams,
) => Promise<unknown>;

export interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: ToolHandler;
}
