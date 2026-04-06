/**
 * 06 — Groups: create, join, members, invite, enrollment policies
 */

import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, createTestFixture, STATE_PATH, type E2eState } from "../context.js";
import type { McpHarness } from "../harness.js";
import { isProd } from "../helpers.js";

describe.skipIf(isProd())("06 — Groups", () => {
	let acme: McpHarness;
	let beta: McpHarness;
	let gamma: McpHarness;
	let state: E2eState;

	let openGroupId: string;
	let openGroupHandle: string;
	let closedGroupId: string;

	beforeAll(async () => {
		const f = await createTestFixture();
		acme = f.acme;
		beta = f.beta;
		gamma = f.gamma;
		state = f.state;
	});

	afterAll(async () => {
		// Persist group IDs into state for group messaging tests
		if (openGroupId) {
			const updated = { ...state, openGroupId, openGroupHandle, closedGroupId };
			writeFileSync(STATE_PATH, JSON.stringify(updated, null, 2));
		}
		await closeAll(acme, beta, gamma);
	});

	it("6.1 Create open public group", async () => {
		const result = await acme.call<Record<string, string>>("rine_group_create", {
			name: "test-open",
			enrollment: "open",
			visibility: "public",
			as: state.acme.agentName,
		});
		expect(result.id).toBeTruthy();
		expect(result.handle).toContain("#test-open@");
		openGroupId = result.id;
		openGroupHandle = result.handle;
	});

	it("6.2 Create closed private group", async () => {
		const result = await beta.call<Record<string, string>>("rine_group_create", {
			name: "test-closed",
			enrollment: "closed",
			visibility: "private",
		});
		expect(result.id).toBeTruthy();
		closedGroupId = result.id;
	});

	it("6.3 List groups includes created group", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_groups");
		const items = result.items as Array<Record<string, string>>;
		expect(items.length).toBeGreaterThanOrEqual(1);
		const found = items.find((g) => g.id === openGroupId);
		expect(found).toBeDefined();
	});

	it("6.4 Bob joins open group", async () => {
		const result = await beta.call<Record<string, string>>("rine_group_join", {
			group_id: openGroupId,
		});
		expect(result.role).toBe("member");
	});

	it("6.5 Carol joins open group", async () => {
		const result = await gamma.call<Record<string, string>>("rine_group_join", {
			group_id: openGroupId,
		});
		expect(result.role).toBe("member");
	});

	it("6.6 Group has 3 members", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_group_members", {
			group_id: openGroupId,
		});
		const items = result.items as Array<Record<string, unknown>>;
		expect(items.length).toBe(3);
	});

	it("6.7 Join closed group without invite → error", async () => {
		const err = await gamma.callExpectError("rine_group_join", {
			group_id: closedGroupId,
		});
		expect(err.toLowerCase()).toMatch(/invite|403|closed|error|denied/);
	});

	it("6.8 Invite to closed group + join", async () => {
		// Beta (admin) invites Carol
		await beta.call("rine_group_invite", {
			group_id: closedGroupId,
			agent: state.gamma.agentId,
		});

		// Carol joins after invite
		const result = await gamma.call<Record<string, string>>("rine_group_join", {
			group_id: closedGroupId,
		});
		expect(result.role).toBe("member");
	});
});
