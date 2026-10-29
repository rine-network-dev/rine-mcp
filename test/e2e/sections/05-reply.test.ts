/**
 * 05 — Reply + Conversations
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, createTestFixture, type E2eState } from "../context.js";
import type { McpHarness } from "../harness.js";
import { isProd } from "../helpers.js";

describe.skipIf(isProd())("05 — Reply + Conversations", () => {
	let acme: McpHarness;
	let beta: McpHarness;
	let state: E2eState;

	let origMsgId: string;
	let origConvId: string;

	beforeAll(async () => {
		const f = await createTestFixture();
		acme = f.acme;
		beta = f.beta;
		state = f.state;
		await closeAll(f.gamma);

		// Send initial message for reply tests
		const sent = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload: { task: "review", doc: "contract.pdf" },
			type: "rine.v1.task_request",
		});
		origMsgId = sent.id;
		origConvId = sent.conversation_id;
	});

	afterAll(() => closeAll(acme, beta));

	it("5.1 Reply sends encrypted response", async () => {
		const result = await beta.call<Record<string, string>>("rine_reply", {
			message_id: origMsgId,
			payload: { result: "approved" },
		});
		expect(result.id).toBeTruthy();
		expect(result.encryption_version).toBe("hpke-hybrid-v2");
	});

	it("5.2 Reply preserves conversation_id", async () => {
		const result = await beta.call<Record<string, string>>("rine_reply", {
			message_id: origMsgId,
			payload: { note: "conversation check" },
		});
		expect(result.conversation_id).toBe(origConvId);
	});

	it("5.3 Original sender reads reply", async () => {
		const reply = await beta.call<Record<string, string>>("rine_reply", {
			message_id: origMsgId,
			payload: { verdict: "looks good" },
		});

		const read = await acme.call<Record<string, unknown>>("rine_read", {
			message_id: reply.id,
		});
		expect(read.verified).toBe(true);
		expect((read.decrypted as Record<string, string>).verdict).toBe(
			"looks good",
		);
	});

	it("5.4 Multi-hop reply chain", async () => {
		// A→B
		const m1 = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload: { step: 1 },
			type: "rine.v1.task_request",
		});

		// B replies to A
		const m2 = await beta.call<Record<string, string>>("rine_reply", {
			message_id: m1.id,
			payload: { step: 2 },
		});
		expect(m2.conversation_id).toBe(m1.conversation_id);

		// A reads B's reply
		const read = await acme.call<Record<string, unknown>>("rine_read", {
			message_id: m2.id,
		});
		expect((read.decrypted as Record<string, number>).step).toBe(2);
		expect(read.verified).toBe(true);
	});
});
