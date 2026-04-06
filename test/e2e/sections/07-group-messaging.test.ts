/**
 * 07 — Group E2EE Messaging (Sender Keys)
 *
 * Requires 06-groups to have run (open group with 3 members).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, loadState, harnessForOrg } from "../context.js";
import type { McpHarness } from "../harness.js";
import { isProd, retryUntil } from "../helpers.js";

interface GroupState {
	openGroupId: string;
	openGroupHandle: string;
}

describe.skipIf(isProd())("07 — Group Messaging (Sender Keys)", () => {
	let acme: McpHarness;
	let beta: McpHarness;
	let gamma: McpHarness;
	let state: ReturnType<typeof loadState> & GroupState;

	let groupMsgId: string;

	beforeAll(async () => {
		const raw = loadState() as ReturnType<typeof loadState> & GroupState;
		if (!raw.openGroupHandle) {
			throw new Error("No open group found — run 06-groups first");
		}
		state = raw;

		[acme, beta, gamma] = await Promise.all([
			harnessForOrg(state.acme),
			harnessForOrg(state.beta),
			harnessForOrg(state.gamma),
		]);
	});

	afterAll(() => closeAll(acme, beta, gamma));

	it("7.1 Send to group → sender-key-v1", async () => {
		const result = await acme.call<Record<string, string>>("rine_send", {
			to: state.openGroupHandle,
			payload: { task: "group-test", priority: "high" },
			type: "rine.v1.task_request",
		});
		expect(result.id).toBeTruthy();
		expect(result.encryption_version).toBe("sender-key-v1");
		groupMsgId = result.id;
	});

	it("7.2 Sender reads own group message", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_read", {
			message_id: groupMsgId,
		});
		const dec = result.decrypted as Record<string, string>;
		expect(dec.task).toBe("group-test");
	});

	it("7.3 Bob ingests SK distributions via inbox", async () => {
		// Bob must call inbox to auto-ingest sender key distributions
		const inbox = await retryUntil(
			() => beta.call<Record<string, unknown>>("rine_inbox", {
				agent: state.beta.agentName,
				limit: 50,
			}),
			(r) => {
				const items = r.items as Array<Record<string, unknown>>;
				return items.some((m) => m.type === "rine.v1.sender_key_distribution");
			},
			{ attempts: 10, delayMs: 500 },
		);

		const items = inbox.items as Array<Record<string, string>>;
		const skDist = items.filter((m) => m.type === "rine.v1.sender_key_distribution");
		expect(skDist.length).toBeGreaterThanOrEqual(1);
	});

	it("7.4 Bob decrypts group message", async () => {
		const result = await beta.call<Record<string, unknown>>("rine_read", {
			message_id: groupMsgId,
		});
		expect(result.verified).toBe(true);
		expect((result.decrypted as Record<string, string>).task).toBe("group-test");
	});

	it("7.5 Carol ingests and decrypts", async () => {
		// Carol also needs to ingest SK distributions
		await retryUntil(
			() => gamma.call<Record<string, unknown>>("rine_inbox", {
				agent: state.gamma.agentName,
				limit: 50,
			}),
			(r) => {
				const items = r.items as Array<Record<string, unknown>>;
				return items.some((m) => m.type === "rine.v1.sender_key_distribution");
			},
		);

		const result = await gamma.call<Record<string, unknown>>("rine_read", {
			message_id: groupMsgId,
		});
		expect((result.decrypted as Record<string, string>).task).toBe("group-test");
	});

	it("7.6 Chain ratchet — 2nd message decrypts", async () => {
		const sent = await acme.call<Record<string, string>>("rine_send", {
			to: state.openGroupHandle,
			payload: { ping: "ratchet" },
		});

		const read = await beta.call<Record<string, unknown>>("rine_read", {
			message_id: sent.id,
		});
		expect((read.decrypted as Record<string, string>).ping).toBe("ratchet");
	});

	it("7.7 Bob sends to group, Alice reads", async () => {
		const sent = await beta.call<Record<string, string>>("rine_send", {
			to: state.openGroupHandle,
			payload: { from: "bob" },
			type: "rine.v1.task_response",
		});
		expect(sent.encryption_version).toBe("sender-key-v1");

		// Alice must ingest Bob's SK distribution
		await acme.call("rine_inbox", {
			agent: state.acme.agentName,
			limit: 50,
		});

		const read = await acme.call<Record<string, unknown>>("rine_read", {
			message_id: sent.id,
		});
		expect((read.decrypted as Record<string, string>).from).toBe("bob");
	});

	it("7.8 Sequential batch all decrypt", async () => {
		const ids: string[] = [];
		for (let i = 1; i <= 3; i++) {
			const sent = await acme.call<Record<string, string>>("rine_send", {
				to: state.openGroupHandle,
				payload: { seq: i },
				from: state.acme.agentName,
			});
			ids.push(sent.id);
		}

		// Bob reads all
		for (const id of ids) {
			const read = await beta.call<Record<string, unknown>>("rine_read", {
				message_id: id,
			});
			expect(read.decrypted).toBeDefined();
		}
	});
});
