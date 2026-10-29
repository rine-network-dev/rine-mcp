/**
 * 10 — Production Smoke Tests
 *
 * Only runs when RINE_E2E_MODE=production.
 * Uses the pre-enrolled janitors accounts in the accounts folder (helpers.ts accountDir). Every
 * agent there is unlisted, so the discovery checks prove the directory hides them and read the
 * public group this section creates for itself (10.7-10.8).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../context.js";
import { McpHarness } from "../harness.js";
import { accountDir, getApiUrl, isProd, uniqueSlug } from "../helpers.js";

/** `rine group delete` as the account whose cred dir `configDir` is: the MCP server has no group delete. */
function deleteGroup(configDir: string, apiUrl: string, groupId: string): void {
	const ownerDir = mkdtempSync(join(tmpdir(), "rine-e2e-owner-"));
	try {
		execFileSync(process.env.RINE_CLI ?? "rine", ["--json", "group", "delete", groupId], {
			env: {
				...process.env,
				RINE_CONFIG_DIR: configDir,
				RINE_OWNER_DIR: ownerDir,
				RINE_API_URL: apiUrl,
			},
			stdio: "ignore",
		});
	} finally {
		rmSync(ownerDir, { recursive: true, force: true });
	}
}

describe.skipIf(!isProd())("10 — Production Smoke", () => {
	let apollo: McpHarness;
	let artemis: McpHarness;
	let hermes: McpHarness;
	let apiUrl: string;
	let sentId: string;
	let groupId: string | undefined;
	let groupName: string;

	beforeAll(async () => {
		apiUrl = getApiUrl();

		apollo = new McpHarness({ apiUrl, configDir: accountDir("janitors-alpha") });
		artemis = new McpHarness({ apiUrl, configDir: accountDir("janitors-beta") });
		hermes = new McpHarness({ apiUrl, configDir: accountDir("janitors-gamma") });

		await Promise.all([apollo.connect(), artemis.connect(), hermes.connect()]);
	});

	afterAll(async () => {
		try {
			if (groupId) deleteGroup(apollo.configDir, apiUrl, groupId);
		} finally {
			await closeAll(apollo, artemis, hermes);
		}
	});

	it("10.1 rine_whoami — janitors-alpha", async () => {
		const result = await apollo.call<Record<string, unknown>>("rine_whoami");
		const org = result.org as Record<string, string>;
		expect(org.slug).toBe("janitors-alpha");
	});

	it("10.2 rine_whoami — janitors-beta", async () => {
		const result = await artemis.call<Record<string, unknown>>("rine_whoami");
		const org = result.org as Record<string, string>;
		expect(org.slug).toBe("janitors-beta");
	});

	it("10.3 Send apollo → artemis + read", async () => {
		const sent = await apollo.call<Record<string, string>>("rine_send", {
			to: "artemis@janitors-beta.rine.network",
			payload: { smoke: "test", ts: Date.now() },
			type: "rine.v1.ping",
		});
		expect(sent.id).toBeTruthy();
		sentId = sent.id;
		expect(sent.encryption_version).toBe("hpke-hybrid-v2");

		// janitors-beta holds two agents, so the reader is named
		const read = await artemis.call<Record<string, unknown>>("rine_read", {
			message_id: sent.id,
			agent: "artemis",
		});
		expect(read.verified).toBe(true);
		expect((read.decrypted as Record<string, string>).smoke).toBe("test");
	});

	it("10.4 Reply artemis → apollo", async () => {
		// Reply to the message 10.3 sent and read: the default inbox lists unread items only, and that one is read now
		const reply = await artemis.call<Record<string, string>>("rine_reply", {
			message_id: sentId,
			payload: { ack: true },
		});
		expect(reply.id).toBeTruthy();

		const read = await apollo.call<Record<string, unknown>>("rine_read", {
			message_id: reply.id,
		});
		expect(read.verified).toBe(true);
	});

	it("10.5 rine_discover answers a list that holds no janitors agent", async () => {
		// Every janitors agent is unlisted: a well-formed answer without any of them is the proof.
		const result = await apollo.call<Record<string, unknown>>("rine_discover");
		const items = result.items as Array<Record<string, string>>;
		expect(Array.isArray(items)).toBe(true);
		expect(items.filter((a) => /@janitors-/.test(a.handle ?? ""))).toEqual([]);
	});

	it("10.6 rine_inspect refuses an unlisted agent", async () => {
		// rine_inspect resolves the handle through WebFinger, which answers for any live agent, then reads
		// GET /directory/agents/{id}, which is a 404 for a card that is not public (directory.py:
		// get_agent_profile). So an unlisted agent cannot be inspected by anyone, its own caller
		// included, and the 404 is by design: asserting it proves the unlisted property. A handle that
		// failed to resolve would say "Cannot resolve", not "not found", and fail this match.
		const err = await apollo.callExpectError("rine_inspect", {
			agent: "apollo@janitors-alpha.rine.network",
		});
		expect(err).toMatch(/not found|404/i);
	});

	it("10.7 rine_groups lists a public group apollo created", async () => {
		groupName = uniqueSlug("mcp-smoke");
		const created = await apollo.call<Record<string, string>>("rine_group_create", {
			name: groupName,
			enrollment: "open",
			visibility: "public",
		});
		groupId = created.id;
		expect(groupId).toBeTruthy();

		const result = await apollo.call<Record<string, unknown>>("rine_groups");
		const items = result.items as Array<Record<string, string>>;
		expect(items.some((g) => g.id === groupId)).toBe(true);
	});

	it("10.8 rine_discover_groups finds that public group", async () => {
		const result = await apollo.call<Record<string, unknown>>("rine_discover_groups", {
			query: groupName,
		});
		const items = result.items as Array<Record<string, string>>;
		expect(items.some((g) => g.id === groupId)).toBe(true);
	});
});
