/**
 * 01 — Onboarding: rine_onboard + rine_agent_create
 *
 * Registers 3 fresh orgs (acme, beta, gamma) and persists their state
 * to a JSON file so subsequent test sections can reuse them.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type E2eState, STATE_PATH } from "../context.js";
import { McpHarness } from "../harness.js";
import { getApiUrl, isProd, uniqueSlug } from "../helpers.js";

describe.skipIf(isProd())("01 — Onboarding", () => {
	const apiUrl = getApiUrl();

	// Create persistent temp dirs (not cleaned by harness — cleaned by OS or global teardown)
	const acmeDir = mkdtempSync(join(tmpdir(), "rine-e2e-acme-"));
	const betaDir = mkdtempSync(join(tmpdir(), "rine-e2e-beta-"));
	const gammaDir = mkdtempSync(join(tmpdir(), "rine-e2e-gamma-"));

	let acme: McpHarness;
	let beta: McpHarness;
	let gamma: McpHarness;

	const state: Partial<E2eState> = { apiUrl };

	// Use beforeAll-like pattern via sequential tests (vitest runs tests in order)
	// First 3 tests register orgs; harnesses connect once and persist.

	it("connects harnesses", async () => {
		acme = new McpHarness({ apiUrl, configDir: acmeDir });
		beta = new McpHarness({ apiUrl, configDir: betaDir });
		gamma = new McpHarness({ apiUrl, configDir: gammaDir });
		await Promise.all([acme.connect(), beta.connect(), gamma.connect()]);
	});

	it("1.1 Register acme org", async () => {
		const slug = uniqueSlug("acme-e2e");
		const result = await acme.call<Record<string, unknown>>("rine_onboard", {
			email: "acme-mcp-e2e@gmail.com",
			org_name: "Acme MCP",
			org_slug: slug,
			agent_name: "alice",
		});

		expect(result.status).toBe("registered");
		const agent = result.agent as Record<string, string>;
		expect(agent.handle).toContain("@");
		expect(agent.id).toBeTruthy();
		expect(agent.verification_words).toBeTruthy();

		state.acme = {
			configDir: acmeDir,
			slug,
			agentId: agent.id,
			agentHandle: agent.handle,
			agentName: "alice",
		};
	});

	it("1.2 Register beta org", async () => {
		const slug = uniqueSlug("beta-e2e");
		const result = await beta.call<Record<string, unknown>>("rine_onboard", {
			email: "beta-mcp-e2e@gmail.com",
			org_name: "Beta MCP",
			org_slug: slug,
			agent_name: "bob",
		});

		expect(result.status).toBe("registered");
		const agent = result.agent as Record<string, string>;
		state.beta = {
			configDir: betaDir,
			slug,
			agentId: agent.id,
			agentHandle: agent.handle,
			agentName: "bob",
		};
	});

	it("1.3 Register gamma org", async () => {
		const slug = uniqueSlug("gamma-e2e");
		const result = await gamma.call<Record<string, unknown>>("rine_onboard", {
			email: "gamma-mcp-e2e@gmail.com",
			org_name: "Gamma MCP",
			org_slug: slug,
			agent_name: "carol",
		});

		expect(result.status).toBe("registered");
		const agent = result.agent as Record<string, string>;
		state.gamma = {
			configDir: gammaDir,
			slug,
			agentId: agent.id,
			agentHandle: agent.handle,
			agentName: "carol",
		};
	});

	it("1.4 Idempotent re-onboard → already_registered", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_onboard", {
			email: "acme-mcp-e2e@gmail.com",
			org_name: "Acme MCP",
			org_slug: state.acme!.slug,
			agent_name: "alice",
		});
		expect(result.status).toBe("already_registered");
		expect(result.org).toBeDefined();
	});

	it("1.5 Invalid slug → error", async () => {
		const err = await acme.callExpectError("rine_onboard", {
			email: "bad@gmail.com",
			org_name: "Bad",
			org_slug: "INVALID SLUG!!!",
			agent_name: "x",
		});
		expect(err.toLowerCase()).toMatch(/slug|alphanumeric|lowercase/);
	});

	afterAll(async () => {
		// Persist state for subsequent test files
		if (state.acme && state.beta && state.gamma) {
			writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
		}
		// Close harnesses but DON'T clean config dirs (other files need them)
		await Promise.allSettled([acme?.close(), beta?.close(), gamma?.close()]);
	});
});
