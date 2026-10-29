/**
 * 03 — 1:1 E2EE Messaging (HPKE)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, createTestFixture, type E2eState } from "../context.js";
import type { McpHarness } from "../harness.js";
import { isProd } from "../helpers.js";

describe.skipIf(isProd())("03 — 1:1 Messaging (HPKE)", () => {
	let acme: McpHarness;
	let beta: McpHarness;
	let state: E2eState;

	let msg1Id: string;
	let crossOrgMsgId: string;

	beforeAll(async () => {
		const f = await createTestFixture();
		acme = f.acme;
		beta = f.beta;
		state = f.state;
		await closeAll(f.gamma);
	});

	afterAll(() => closeAll(acme, beta));

	it("3.1 Send by UUID → hpke-hybrid-v2", async () => {
		const result = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload: { task: "validate", amount: 1500 },
			type: "rine.v1.task_request",
		});
		expect(result.id).toBeTruthy();
		expect(result.encryption_version).toBe("hpke-hybrid-v2");
		msg1Id = result.id;
	});

	it("3.2 Read + decrypt → verified payload", async () => {
		const result = await beta.call<Record<string, unknown>>("rine_read", {
			message_id: msg1Id,
		});
		expect(result.verified).toBe(true);
		const dec = result.decrypted as Record<string, unknown>;
		expect(dec.task).toBe("validate");
		expect(dec.amount).toBe(1500);
	});

	it("3.3 Send by handle", async () => {
		const result = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentHandle,
			payload: { ping: "handle-test" },
		});
		expect(result.id).toBeTruthy();
		expect(result.encryption_version).toBe("hpke-hybrid-v2");
	});

	it("3.4 Send with from handle", async () => {
		const result = await acme.call<Record<string, string>>("rine_send", {
			from: state.acme.agentHandle,
			to: state.beta.agentId,
			payload: { ping: "from-handle" },
		});
		expect(result.encryption_version).toBe("hpke-hybrid-v2");
	});

	it("3.5 Cross-org send (beta → acme)", async () => {
		const result = await beta.call<Record<string, string>>("rine_send", {
			to: state.acme.agentId,
			payload: { status: "done" },
			type: "rine.v1.task_response",
		});
		expect(result.id).toBeTruthy();
		crossOrgMsgId = result.id;
	});

	it("3.6 Cross-org decrypt", async () => {
		const result = await acme.call<Record<string, unknown>>("rine_read", {
			message_id: crossOrgMsgId,
		});
		expect(result.verified).toBe(true);
		expect((result.decrypted as Record<string, unknown>).status).toBe("done");
	});

	it("3.7 Idempotency key → same ID", async () => {
		const key = `e2e-idemp-${Date.now()}`;
		const r1 = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload: { x: 1 },
			idempotency_key: key,
		});
		const r2 = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload: { x: 1 },
			idempotency_key: key,
		});
		expect(r1.id).toBe(r2.id);
	});

	it("3.8 Large payload roundtrip (50KB)", async () => {
		const big = { data: "x".repeat(50_000) };
		const sent = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload: big,
			type: "rine.v1.data",
		});
		const read = await beta.call<Record<string, unknown>>("rine_read", {
			message_id: sent.id,
		});
		const dec = read.decrypted as Record<string, string>;
		expect(dec.data.length).toBeGreaterThanOrEqual(49_000);
	});

	it("3.9 Unicode roundtrip", async () => {
		const payload = { text: "konnichiwa 世界 🌍 Ñoño" };
		const sent = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload,
		});
		const read = await beta.call<Record<string, unknown>>("rine_read", {
			message_id: sent.id,
		});
		expect((read.decrypted as Record<string, string>).text).toBe(payload.text);
	});

	it("3.10 Nested JSON roundtrip", async () => {
		const payload = { a: { b: { c: { d: "deep" } } } };
		const sent = await acme.call<Record<string, string>>("rine_send", {
			to: state.beta.agentId,
			payload,
		});
		const read = await beta.call<Record<string, unknown>>("rine_read", {
			message_id: sent.id,
		});
		const dec = read.decrypted as { a: { b: { c: { d: string } } } };
		expect(dec.a.b.c.d).toBe("deep");
	});

	it("3.11 Self-send → error", async () => {
		const err = await acme.callExpectError("rine_send", {
			to: state.acme.agentId,
			payload: { x: 1 },
		});
		expect(err.toLowerCase()).toMatch(/same|self|cannot/);
	});

	it("3.12 Non-existent recipient → error", async () => {
		const err = await acme.callExpectError("rine_send", {
			to: "00000000-0000-0000-0000-000000000000",
			payload: { x: 1 },
		});
		expect(err.toLowerCase()).toMatch(/not found|404|error/);
	});
});
