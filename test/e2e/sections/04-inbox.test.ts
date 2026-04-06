/**
 * 04 — Inbox + Pagination
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, createTestFixture, type E2eState } from "../context.js";
import type { McpHarness } from "../harness.js";
import { isProd } from "../helpers.js";

describe.skipIf(isProd())("04 — Inbox + Pagination", () => {
	let acme: McpHarness;
	let beta: McpHarness;
	let state: E2eState;

	beforeAll(async () => {
		const f = await createTestFixture();
		acme = f.acme;
		beta = f.beta;
		state = f.state;
		await closeAll(f.gamma);

		// Send a few messages to populate Bob's inbox
		for (let i = 0; i < 3; i++) {
			await acme.call("rine_send", {
				to: state.beta.agentId,
				payload: { inbox_test: i },
			});
		}
	});

	afterAll(() => closeAll(acme, beta));

	it("4.1 Inbox returns decrypted items", async () => {
		const result = await beta.call<Record<string, unknown>>("rine_inbox", {
			agent: state.beta.agentName,
		});
		const items = result.items as Array<Record<string, unknown>>;
		expect(items.length).toBeGreaterThanOrEqual(3);

		const decrypted = items.filter((m) => m.decrypted);
		expect(decrypted.length).toBeGreaterThan(0);
	});

	it("4.2 HPKE items are verified", async () => {
		const result = await beta.call<Record<string, unknown>>("rine_inbox", {
			agent: state.beta.agentName,
			limit: 10,
		});
		const items = result.items as Array<Record<string, unknown>>;
		const hpke = items.filter(
			(m) => m.encryption_version === "hpke-v1" && m.decrypted,
		);
		for (const msg of hpke) {
			expect(msg.verified).toBe(true);
		}
	});

	it("4.3 Limit parameter respected", async () => {
		const result = await beta.call<Record<string, unknown>>("rine_inbox", {
			agent: state.beta.agentName,
			limit: 2,
		});
		const items = result.items as Array<Record<string, unknown>>;
		expect(items.length).toBeLessThanOrEqual(2);
	});

	it("4.4 Cursor pagination", async () => {
		const page1 = await beta.call<Record<string, unknown>>("rine_inbox", {
			agent: state.beta.agentName,
			limit: 2,
		});
		const cursor = page1.next_cursor as string | undefined;

		if (cursor) {
			const page2 = await beta.call<Record<string, unknown>>("rine_inbox", {
				agent: state.beta.agentName,
				limit: 2,
				cursor,
			});
			const items2 = page2.items as Array<Record<string, unknown>>;
			expect(items2.length).toBeGreaterThanOrEqual(1);
		}
	});

	it("4.5 Agent parameter routes correctly", async () => {
		const result = await beta.call<Record<string, unknown>>("rine_inbox", {
			agent: state.beta.agentName,
			limit: 5,
		});
		const items = result.items as Array<Record<string, unknown>>;
		for (const msg of items) {
			if (msg.to_agent_id) {
				expect(msg.to_agent_id).toBe(state.beta.agentId);
			}
		}
	});
});
