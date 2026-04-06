/**
 * 10 — Production Smoke Tests
 *
 * Only runs when RINE_E2E_MODE=production.
 * Uses pre-existing credential dirs for janitors orgs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../context.js";
import { McpHarness } from "../harness.js";
import { credDir, getApiUrl, isProd } from "../helpers.js";

describe.skipIf(!isProd())("10 — Production Smoke", () => {
	let leon: McpHarness;
	let artemis: McpHarness;
	let hermes: McpHarness;
	let apiUrl: string;

	beforeAll(async () => {
		apiUrl = getApiUrl();

		leon = new McpHarness({
			apiUrl,
			configDir: credDir("RINE_JANITORS_DIR", ".rine-janitors"),
		});
		artemis = new McpHarness({
			apiUrl,
			configDir: credDir("RINE_JANITORS_BETA_DIR", ".rine-janitors-beta"),
		});
		hermes = new McpHarness({
			apiUrl,
			configDir: credDir("RINE_JANITORS_GAMMA_DIR", ".rine-janitors-gamma"),
		});

		await Promise.all([leon.connect(), artemis.connect(), hermes.connect()]);
	});

	afterAll(() => closeAll(leon, artemis, hermes));

	it("10.1 rine_whoami — janitors", async () => {
		const result = await leon.call<Record<string, unknown>>("rine_whoami");
		const org = result.org as Record<string, string>;
		expect(org.slug).toBe("janitors");
	});

	it("10.2 rine_whoami — janitors-beta", async () => {
		const result = await artemis.call<Record<string, unknown>>("rine_whoami");
		const org = result.org as Record<string, string>;
		expect(org.slug).toBe("janitors-beta");
	});

	it("10.3 Send leon → artemis + read", async () => {
		const sent = await leon.call<Record<string, string>>("rine_send", {
			to: "artemis@janitors-beta.rine.network",
			payload: { smoke: "test", ts: Date.now() },
			type: "rine.v1.ping",
		});
		expect(sent.id).toBeTruthy();
		expect(sent.encryption_version).toBe("hpke-v1");

		const read = await artemis.call<Record<string, unknown>>("rine_read", {
			message_id: sent.id,
		});
		expect(read.verified).toBe(true);
		expect((read.decrypted as Record<string, string>).smoke).toBe("test");
	});

	it("10.4 Reply artemis → leon", async () => {
		// Get the latest message in artemis's inbox
		const inbox = await artemis.call<Record<string, unknown>>("rine_inbox", {
			limit: 1,
		});
		const items = inbox.items as Array<Record<string, string>>;
		expect(items.length).toBeGreaterThanOrEqual(1);

		const msgId = items[0].id;
		const reply = await artemis.call<Record<string, string>>("rine_reply", {
			message_id: msgId,
			payload: { ack: true },
		});
		expect(reply.id).toBeTruthy();

		const read = await leon.call<Record<string, unknown>>("rine_read", {
			message_id: reply.id,
		});
		expect(read.verified).toBe(true);
	});

	it("10.5 rine_discover returns results", async () => {
		const result = await leon.call<Record<string, unknown>>("rine_discover");
		const items = result.items as Array<Record<string, unknown>>;
		expect(items.length).toBeGreaterThanOrEqual(3);
	});

	it("10.6 rine_inspect known agent", async () => {
		const result = await leon.call<Record<string, unknown>>("rine_inspect", {
			agent: "leon@janitors.rine.network",
		});
		expect(result).toBeDefined();
	});

	it("10.7 rine_groups for leon", async () => {
		const result = await leon.call<Record<string, unknown>>("rine_groups");
		const items = result.items as Array<Record<string, string>>;
		expect(items.length).toBeGreaterThanOrEqual(1);
	});

	it("10.8 rine_discover_groups returns results", async () => {
		const result = await leon.call<Record<string, unknown>>("rine_discover_groups");
		const items = result.items as Array<Record<string, unknown>>;
		expect(items.length).toBeGreaterThanOrEqual(1);
	});
});
