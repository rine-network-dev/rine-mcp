/**
 * 08 — Discovery: rine_discover, rine_inspect, rine_discover_groups
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, createTestFixture, type E2eState } from "../context.js";
import type { McpHarness } from "../harness.js";
import { isProd } from "../helpers.js";

describe.skipIf(isProd())("08 — Discovery", () => {
	let acme: McpHarness;
	let state: E2eState;

	beforeAll(async () => {
		const f = await createTestFixture();
		acme = f.acme;
		state = f.state;
		await closeAll(f.beta, f.gamma);
	});

	afterAll(() => closeAll(acme));

	it("8.1 rine_discover returns agents", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_discover");
		const items = result.items as Array<Record<string, unknown>>;
		expect(items.length).toBeGreaterThanOrEqual(1);
	});

	it("8.2 rine_discover with query filter", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_discover", {
			query: "alice",
		});
		const items = result.items as Array<Record<string, unknown>>;
		// Should find at least alice (may find others with "alice" in name)
		expect(items.length).toBeGreaterThanOrEqual(1);
	});

	it("8.3 rine_inspect by handle", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_inspect", {
			agent: state.acme.agentHandle,
		});
		// Agent card should include name and encryption info
		expect(result).toBeDefined();
		const card = (result as Record<string, Record<string, unknown>>).card ?? result;
		expect(card.name ?? (result as Record<string, string>).name).toBeTruthy();
	});

	it("8.4 rine_inspect by UUID", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_inspect", {
			agent: state.acme.agentId,
		});
		expect(result).toBeDefined();
	});

	it("8.5 rine_discover_groups returns public groups", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_discover_groups");
		const items = result.items as Array<Record<string, unknown>>;
		expect(items.length).toBeGreaterThanOrEqual(1);
	});

	it("8.6 Private groups excluded from discovery", async () => {
		// The closed group created in 06 is private — shouldn't appear
		const raw = await import("node:fs").then((fs) =>
			JSON.parse(fs.readFileSync(
				new URL("../.e2e-orgs.json", import.meta.url),
				"utf-8",
			)),
		);
		const closedGroupId = raw.closedGroupId;
		if (!closedGroupId) return; // skip if no closed group

		const result = await acme.call<Record<string, unknown>>("rine_discover_groups");
		const items = result.items as Array<Record<string, string>>;
		const found = items.find((g) => g.id === closedGroupId);
		expect(found).toBeUndefined();
	});

	it("8.7 Pagination with limit", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_discover", {
			limit: 2,
		});
		const items = result.items as Array<Record<string, unknown>>;
		expect(items.length).toBeLessThanOrEqual(2);
	});
});
