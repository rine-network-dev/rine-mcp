/**
 * Global setup — runs once before any E2E test file.
 *
 * - Isolated mode: starts postgres + uvicorn, writes apiUrl to state file.
 * - Production mode: uses RINE_API_URL or defaults to https://rine.network.
 * - Both: ensures MCP dist is built.
 */

import { execSync } from "node:child_process";
import { existsSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { InfraHandles } from "./infra.js";

const STATE_FILE = join(import.meta.dirname, ".e2e-state.json");
const ORGS_FILE = join(import.meta.dirname, ".e2e-orgs.json");

let infra: InfraHandles | undefined;

export async function setup(): Promise<void> {
	const mcpRoot = join(import.meta.dirname, "../..");
	const distFile = join(mcpRoot, "dist/server.js");

	// Build MCP if dist is missing or stale
	const srcFile = join(mcpRoot, "src/server.ts");
	const needsBuild =
		!existsSync(distFile) ||
		(existsSync(srcFile) &&
			statSync(srcFile).mtimeMs > statSync(distFile).mtimeMs);

	if (needsBuild) {
		console.error("[e2e] Building MCP server...");
		execSync("npm run build", { cwd: mcpRoot, stdio: "inherit" });
	}

	// Clean stale org state from previous runs
	try { unlinkSync(ORGS_FILE); } catch { /* ignore */ }

	const isProd = process.env.RINE_E2E_MODE === "production";

	if (isProd) {
		const apiUrl = process.env.RINE_API_URL ?? "https://rine.network";
		writeFileSync(STATE_FILE, JSON.stringify({ apiUrl }));
		console.error(`[e2e] Production mode — ${apiUrl}`);
		return;
	}

	// Isolated mode: start fresh infrastructure
	// Dynamic import to avoid loading infra module in production mode
	const { startInfra } = await import("./infra.js");
	infra = await startInfra("mcp");
	writeFileSync(STATE_FILE, JSON.stringify({ apiUrl: infra.apiUrl }));
	console.error(`[e2e] Isolated mode — ${infra.apiUrl}`);
}

export async function teardown(): Promise<void> {
	if (infra) {
		await infra.cleanup();
		infra = undefined;
	}
	for (const f of [STATE_FILE, ORGS_FILE]) {
		try { unlinkSync(f); } catch { /* ignore */ }
	}
}
