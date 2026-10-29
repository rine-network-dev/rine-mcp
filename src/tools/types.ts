import type { HttpClient } from "@rine-network/core";

export interface ToolContext {
	client: HttpClient;
	/** The runtime dir: agent keys, branch key files and the runtime profile. */
	configDir: string;
	/** The owner dir: `root.key` and the recovery phrase. Never read by a tool that acts as an agent. */
	ownerDir: string;
	apiUrl: string;
	/**
	 * Re-read the identity this process acts as. Called after a tool created the
	 * org or an agent, so the next request signs as the new principal and the
	 * new agent ids join the key-chain pins.
	 */
	refreshIdentity(): void;
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
