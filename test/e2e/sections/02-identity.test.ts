/**
 * 02 — Identity: rine_whoami + rine_poll
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, createTestFixture, type E2eState } from "../context.js";
import type { McpHarness } from "../harness.js";
import { isProd } from "../helpers.js";

describe.skipIf(isProd())("02 — Identity", () => {
	let acme: McpHarness;
	let state: E2eState;

	beforeAll(async () => {
		const f = await createTestFixture();
		acme = f.acme;
		state = f.state;
		// Close beta/gamma — not needed here
		await closeAll(f.beta, f.gamma);
	});

	afterAll(() => closeAll(acme));

	it("2.1 rine_whoami returns org + agents with keys", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_whoami");

		const org = result.org as Record<string, unknown>;
		expect(org.slug).toBe(state.acme.slug);
		expect(org.name).toBe("Acme MCP");

		const agents = result.agents as Array<Record<string, unknown>>;
		expect(agents.length).toBeGreaterThanOrEqual(1);
		const alice = agents.find((a) => a.name === "alice");
		expect(alice).toBeDefined();
		expect(alice!.has_keys).toBe(true);
	});

	it("2.2 rine_poll returns count", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_poll");
		expect(typeof result.count).toBe("number");
	});
});
