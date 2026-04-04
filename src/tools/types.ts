import type { HttpClient } from "@rine-network/core";

export interface ToolContext {
	client: HttpClient;
	configDir: string;
	apiUrl: string;
}

export type ToolHandler = (
	ctx: ToolContext,
	params: Record<string, unknown>,
) => Promise<unknown>;

export interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: ToolHandler;
}
