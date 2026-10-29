/**
 * Shared helpers for MCP E2E tests.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The one origin production mode targets by default. */
export const PRODUCTION_ORIGIN = "https://rine.network";

/** The only shared server remote mode may target; production has its own janitor-only suite (section 10). */
export const STAGING_ORIGIN = "https://staging.rine.network";

/** Path where global setup writes the API URL for test files to read. */
const STATE_FILE = join(import.meta.dirname, ".e2e-state.json");

/** Read apiUrl written by global setup. Falls back to env var. */
export function getApiUrl(): string {
	if (process.env.RINE_API_URL) return process.env.RINE_API_URL;
	if (existsSync(STATE_FILE)) {
		const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
		return state.apiUrl;
	}
	if (isProd()) return PRODUCTION_ORIGIN;
	throw new Error("No API URL available — run global setup first");
}

export function isProd(): boolean {
	return process.env.RINE_E2E_MODE === "production";
}

/** A server somebody else owns (staging): sections 01-09 and 11 run against it, and teardown erases their orgs. */
export function isRemote(): boolean {
	return process.env.RINE_E2E_MODE === "remote";
}

/** Generate a unique slug for test isolation. Max 32 chars. */
export function uniqueSlug(prefix: string): string {
	const suffix = Date.now().toString(36);
	return `${prefix}-${suffix}`.slice(0, 32);
}

/**
 * Retry an async function until a predicate passes.
 * Used for eventually-consistent operations (SK distribution arrival).
 */
export async function retryUntil<T>(
	fn: () => Promise<T>,
	predicate: (v: T) => boolean,
	opts: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
	const { attempts = 10, delayMs = 500 } = opts;
	for (let i = 0; i < attempts; i++) {
		const result = await fn();
		if (predicate(result)) return result;
		if (i < attempts - 1) {
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}
	// One last try — let it throw naturally if it fails
	return fn();
}

/** Project root (rine-mcp/) */
export function mcpRoot(): string {
	return resolve(import.meta.dirname, "../..");
}

/** Main project root (rine/) */
export function projectRoot(): string {
	return resolve(import.meta.dirname, "../../..");
}

/**
 * The folder holding every long-lived test account: RINE_ACCOUNTS_DIR if set, else `.rine-accounts`
 * beside the git common dir, i.e. the MAIN checkout's folder even from a linked worktree. One rule in
 * three languages: scripts/lib/test-accounts.sh, rine-sdk/e2e/config.py and this.
 */
export function accountsRoot(): string {
	if (process.env.RINE_ACCOUNTS_DIR) return resolve(process.env.RINE_ACCOUNTS_DIR);
	const common = execFileSync(
		"git",
		["-C", import.meta.dirname, "rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ encoding: "utf-8" },
	).trim();
	return join(dirname(common), ".rine-accounts");
}

/** The cred dir of one test account, named by its org slug. */
export function accountDir(slug: string): string {
	return join(accountsRoot(), slug);
}
