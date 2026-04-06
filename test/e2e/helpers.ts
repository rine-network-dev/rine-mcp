/**
 * Shared helpers for MCP E2E tests.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Path where global setup writes the API URL for test files to read. */
const STATE_FILE = join(import.meta.dirname, ".e2e-state.json");

/** Read apiUrl written by global setup. Falls back to env var. */
export function getApiUrl(): string {
	if (process.env.RINE_API_URL) return process.env.RINE_API_URL;
	if (existsSync(STATE_FILE)) {
		const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
		return state.apiUrl;
	}
	if (isProd()) return "https://rine.network";
	throw new Error("No API URL available — run global setup first");
}

export function isProd(): boolean {
	return process.env.RINE_E2E_MODE === "production";
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

/** Resolve a credential dir relative to the main project root. */
export function credDir(envVar: string, fallback: string): string {
	return resolve(
		process.env[envVar] ?? join(projectRoot(), fallback),
	);
}
