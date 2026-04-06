/**
 * McpHarness — spawns an MCP server process and drives it via protocol.
 *
 * Each harness instance gets its own RINE_CONFIG_DIR (temp or provided),
 * so cross-org tests simply use multiple harnesses against the same backend.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface HarnessOptions {
	apiUrl: string;
	configDir?: string; // pre-loaded creds (production mode)
}

export class McpToolError extends Error {
	constructor(
		public tool: string,
		message: string,
	) {
		super(`[${tool}] ${message}`);
		this.name = "McpToolError";
	}
}

export class McpHarness {
	readonly configDir: string;
	private client!: Client;
	private transport!: StdioClientTransport;
	private readonly ownedDir: boolean;
	private readonly apiUrl: string;

	constructor(opts: HarnessOptions) {
		this.apiUrl = opts.apiUrl;
		if (opts.configDir) {
			this.configDir = resolve(opts.configDir);
			this.ownedDir = false;
		} else {
			this.configDir = mkdtempSync(join(tmpdir(), "rine-e2e-"));
			this.ownedDir = true;
		}
	}

	async connect(): Promise<void> {
		const bin = process.env.RINE_MCP_BIN;
		const projectRoot = resolve(import.meta.dirname, "../..");

		// If RINE_MCP_BIN is set, use it as the command with no args.
		// Otherwise, use node + dist/server.js from the local build.
		const command = bin ?? "node";
		const args = bin ? [] : [join(projectRoot, "dist/server.js")];

		this.transport = new StdioClientTransport({
			command,
			args,
			env: {
				...process.env,
				RINE_CONFIG_DIR: this.configDir,
				RINE_API_URL: this.apiUrl,
			},
			stderr: "pipe",
		});

		this.client = new Client({ name: "e2e-test", version: "0.0.1" });
		await this.client.connect(this.transport);
	}

	/** Call a tool and return parsed JSON result. Throws McpToolError on isError. */
	async call<T = unknown>(
		toolName: string,
		args: Record<string, unknown> = {},
	): Promise<T> {
		const result = await this.client.callTool({
			name: toolName,
			arguments: args,
		});
		const text = extractText(result);
		if (result.isError) {
			throw new McpToolError(toolName, text);
		}
		return JSON.parse(text) as T;
	}

	/** Call a tool expecting it to fail. Returns the error message string. */
	async callExpectError(
		toolName: string,
		args: Record<string, unknown> = {},
	): Promise<string> {
		const result = await this.client.callTool({
			name: toolName,
			arguments: args,
		});
		if (!result.isError) {
			throw new Error(
				`Expected error from ${toolName} but got success: ${extractText(result)}`,
			);
		}
		return extractText(result);
	}

	async listTools(): Promise<string[]> {
		const r = await this.client.listTools();
		return r.tools.map((t) => t.name);
	}

	async close(): Promise<void> {
		try {
			await this.client?.close();
		} catch {
			// ignore close errors
		}
		if (this.ownedDir) {
			rmSync(this.configDir, { recursive: true, force: true });
		}
	}
}

function extractText(result: unknown): string {
	const r = result as { content: Array<{ type: string; text: string }> };
	return r.content?.find((c) => c.type === "text")?.text ?? "";
}
