/**
 * Shared E2E context — org state persisted across test files via JSON.
 *
 * The onboarding test (01) writes this state. Subsequent test files read it
 * and create McpHarness instances pointing at the same config dirs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpHarness } from "./harness.js";
import { getApiUrl } from "./helpers.js";

export const STATE_PATH = join(import.meta.dirname, ".e2e-orgs.json");

export interface OrgState {
	configDir: string;
	slug: string;
	agentId: string;
	agentHandle: string;
	agentName: string;
}

export interface E2eState {
	apiUrl: string;
	acme: OrgState;
	beta: OrgState;
	gamma: OrgState;
	// Group state (populated by 06-groups)
	openGroupId?: string;
	openGroupHandle?: string;
	closedGroupId?: string;
}

/** Read org state written by 01-onboarding. Throws if not found. */
export function loadState(): E2eState {
	if (!existsSync(STATE_PATH)) {
		throw new Error(
			"E2E org state not found — run 01-onboarding first. " +
			"File expected at: " + STATE_PATH,
		);
	}
	return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as E2eState;
}

/** Create a connected harness for an org using persisted config dir. */
export async function harnessForOrg(org: OrgState): Promise<McpHarness> {
	const h = new McpHarness({ apiUrl: getApiUrl(), configDir: org.configDir });
	await h.connect();
	return h;
}

/**
 * Standard 3-org test fixture. Call in beforeAll, close in afterAll.
 *
 * Returns { acme, beta, gamma } harnesses and the full state.
 */
export async function createTestFixture(): Promise<{
	state: E2eState;
	acme: McpHarness;
	beta: McpHarness;
	gamma: McpHarness;
}> {
	const state = loadState();
	const [acme, beta, gamma] = await Promise.all([
		harnessForOrg(state.acme),
		harnessForOrg(state.beta),
		harnessForOrg(state.gamma),
	]);
	return { state, acme, beta, gamma };
}

/** Close multiple harnesses (swallows errors). */
export async function closeAll(...harnesses: McpHarness[]): Promise<void> {
	await Promise.allSettled(harnesses.map((h) => h.close()));
}
