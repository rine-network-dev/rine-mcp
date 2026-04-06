/**
 * 09 — Edge Cases + Error Handling
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, createTestFixture, type E2eState } from "../context.js";
import type { McpHarness } from "../harness.js";
import { isProd } from "../helpers.js";

describe.skipIf(isProd())("09 — Edge Cases", () => {
	let acme: McpHarness;
	let beta: McpHarness;
	let state: E2eState;

	beforeAll(async () => {
		const f = await createTestFixture();
		acme = f.acme;
		beta = f.beta;
		state = f.state;
		await closeAll(f.gamma);
	});

	afterAll(() => closeAll(acme, beta));

	it("9.1 Self-send → error", async () => {
		const err = await acme.callExpectError("rine_send", {
			to: state.acme.agentId,
			payload: { x: 1 },
		});
		expect(err.toLowerCase()).toMatch(/same|self|cannot/);
	});

	it("9.2 Non-existent agent → error", async () => {
		const err = await acme.callExpectError("rine_send", {
			to: "00000000-0000-0000-0000-000000000000",
			payload: { x: 1 },
		});
		expect(err.toLowerCase()).toMatch(/not found|404|error/);
	});

	it("9.3 Empty payload {} is valid", async () => {
		const result = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload: {},
		});
		expect(result.id).toBeTruthy();
	});

	it("9.4 Non-existent message ID → error", async () => {
		const err = await acme.callExpectError("rine_read", {
			message_id: "00000000-0000-0000-0000-000000000000",
		});
		expect(err.toLowerCase()).toMatch(/not found|404|error/);
	});

	it("9.5 Non-existent group → join error", async () => {
		const err = await beta.callExpectError("rine_group_join", {
			group_id: "00000000-0000-0000-0000-000000000000",
		});
		expect(err.toLowerCase()).toMatch(/not found|404|error/);
	});

	it("9.6 Non-existent group → members error", async () => {
		const err = await beta.callExpectError("rine_group_members", {
			group_id: "00000000-0000-0000-0000-000000000000",
		});
		expect(err.toLowerCase()).toMatch(/not found|404|error/);
	});

	it("9.7 rine_inspect with malformed handle → error", async () => {
		const err = await acme.callExpectError("rine_inspect", {
			agent: "not-a-valid-handle!!!",
		});
		expect(err).toBeTruthy();
	});

	it("9.8 rine_agent_create works", async () => {
		const result = await acme.call<Record<string, string>>(
			"rine_agent_create",
			{ name: "alice-extra" },
		);
		expect(result.id).toBeTruthy();
		expect(result.handle).toContain("alice-extra@");
	});

	it("9.9 Unknown tool name → error", async () => {
		const result = await acme.callExpectError("rine_nonexistent_tool", {});
		expect(result.toLowerCase()).toContain("unknown tool");
	});
});
