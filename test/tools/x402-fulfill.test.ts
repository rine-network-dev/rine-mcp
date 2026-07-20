// REQ-M04 tests — rine_fulfill. The thing under test is the tool's wiring of the
// message plane to rine-core's REAL receipt-build + marker logic: payment decrypt
// → facilitator verify → settle → in-thread receipt send → typed status. Only
// the NETWORK-coupled boundary is mocked (decrypt/encrypt/recipient-key fetch +
// agentKeysExist + the facilitator verify/settle HTTP); the receipt builder,
// marker discipline, and status routing run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockDecryptMessage = vi.fn();
const mockEncryptMessage = vi.fn();
const mockFetchRecipientKeys = vi.fn();
const mockAgentKeysExist = vi.fn();
const mockVerifyPayment = vi.fn();
const mockSettlePayment = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		decryptMessage: (...a: unknown[]) => mockDecryptMessage(...a),
		encryptMessage: (...a: unknown[]) => mockEncryptMessage(...a),
		fetchRecipientKeys: (...a: unknown[]) => mockFetchRecipientKeys(...a),
		agentKeysExist: (...a: unknown[]) => mockAgentKeysExist(...a),
		verifyPayment: (...a: unknown[]) => mockVerifyPayment(...a),
		settlePayment: (...a: unknown[]) => mockSettlePayment(...a),
	};
});

const { X402FacilitatorError } = await import("@rine-network/core");
const { fulfillTools } = await import("../../src/tools/x402-fulfill.js");

const rineFulfill = fulfillTools.find((t) => t.name === "rine_fulfill")!;

const PAYER_ID = "11111111-1111-1111-1111-111111111111";
const PAYEE_ID = "22222222-2222-2222-2222-222222222222";
const PAYMENT_ID = "33333333-3333-3333-3333-333333333333";
const EURC = "0x808456652fdb597867f38412077a9182bf77359f";
const PAY_TO = "0x1111111111111111111111111111111111111111";

const PAYMENT = {
	x402Version: 2,
	resource: { description: "translate a document" },
	accepted: {
		scheme: "exact",
		network: "eip155:84532",
		amount: "100000",
		asset: EURC,
		payTo: PAY_TO,
		maxTimeoutSeconds: 60,
		extra: { name: "EURC", version: "2" },
	},
	payload: {
		signature: `0x${"ab".repeat(65)}`,
		authorization: {
			from: PAYER_ID,
			to: PAY_TO,
			value: "100000",
			validAfter: "0",
			validBefore: "9999999999",
			nonce: `0x${"00".repeat(32)}`,
		},
	},
};

// The facilitator echoes the v1 network SLUG (never CAIP-2) into the settlement.
const SETTLEMENT = {
	success: true,
	transaction: "0xdeadbeef",
	network: "base-sepolia",
	payer: PAYER_ID,
};

function paymentMessage(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: PAYMENT_ID,
		type: "rine.v1.x402_payment",
		conversation_id: "c-1",
		to_agent_id: PAYEE_ID,
		from_agent_id: PAYER_ID,
		encrypted_payload: "CIPHERTEXT",
		encryption_version: "hpke-v1",
		...over,
	};
}

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: "/tmp/mcp-fulfill",
		apiUrl: "https://api.test",
	};
}

/** Wire the ctx so the payment decrypts to PAYMENT and the receipt send succeeds. */
function primeFulfillable(ctx: ToolContext): void {
	(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
		paymentMessage(),
	);
	mockAgentKeysExist.mockReturnValue(true);
	mockDecryptMessage.mockResolvedValue({
		plaintext: JSON.stringify(PAYMENT),
		verified: "verified",
	});
	mockFetchRecipientKeys.mockResolvedValue({
		encryption: {},
		pqEncryption: {},
	});
	mockEncryptMessage.mockResolvedValue({
		encrypted_payload: "ENC",
		encryption_version: "hpke-v1",
		sender_signing_kid: "kid-1",
	});
	mockVerifyPayment.mockResolvedValue({ isValid: true });
	mockSettlePayment.mockResolvedValue(SETTLEMENT);
	(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
		id: "receipt-1",
		conversation_id: "c-1",
	});
}

beforeEach(() => {
	mockDecryptMessage.mockReset();
	mockEncryptMessage.mockReset();
	mockFetchRecipientKeys.mockReset();
	mockAgentKeysExist.mockReset();
	mockVerifyPayment.mockReset();
	mockSettlePayment.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("rine_fulfill — happy path (REQ-M04)", () => {
	it("verifies, settles, sends the receipt in-thread, returns settled", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("settled");
		expect((result.settlement as Record<string, unknown>).network).toBe(
			"base-sepolia",
		);

		const post = ctx.client.post as ReturnType<typeof vi.fn>;
		const [url, body, headers] = post.mock.calls[0]!;
		expect(url).toBe(`/messages/${PAYMENT_ID}/reply`);
		expect(headers).toEqual({ "X-Rine-Agent": PAYEE_ID });
		expect((body as Record<string, unknown>).type).toBe("rine.v1.x402_receipt");
		expect((body as Record<string, unknown>).encrypted_payload).toBe("ENC");
		expect(mockVerifyPayment).toHaveBeenCalledTimes(1);
		expect(mockSettlePayment).toHaveBeenCalledTimes(1);
	});

	it("defaults to the keyless payai preset when no facilitator is given", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		await rineFulfill.handler(ctx, { message_id: PAYMENT_ID });
		const opts = mockVerifyPayment.mock.calls[0]![1] as {
			facilitator: { url: string };
		};
		expect(opts.facilitator.url).toBe("https://facilitator.payai.network");
	});

	it("encrypts the receipt to the PAYER (the payment's sender)", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		});
		expect(mockFetchRecipientKeys).toHaveBeenCalledWith(
			expect.anything(),
			PAYER_ID,
		);
	});
});

describe("rine_fulfill — cleartext marker carries no economics (REQ-X03)", () => {
	it("attaches only the payment-completed {status,rail} marker on success", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		});
		const body = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(body.metadata).toEqual({
			"rine.x402": { status: "payment-completed", rail: "x402" },
		});
		const markerJson = JSON.stringify(body.metadata);
		expect(markerJson).not.toContain("0xdeadbeef");
		expect(markerJson).not.toContain("100000");
		expect(markerJson).not.toContain("base-sepolia");
	});

	it("omits the marker entirely when emit_marker=false", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
			emit_marker: false,
		});
		const body = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(body).not.toHaveProperty("metadata");
	});
});

describe("rine_fulfill — failure branches (typed outcomes, REQ-M04)", () => {
	it("skips settlement and sends a failure receipt on invalid verification", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		mockVerifyPayment.mockResolvedValue({
			isValid: false,
			invalidReason: "signature_mismatch",
		});

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("verification-failed");
		expect(mockSettlePayment).not.toHaveBeenCalled();
		const body = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect((body.metadata as Record<string, unknown>)["rine.x402"]).toEqual({
			status: "payment-failed",
			rail: "x402",
		});
	});

	it("returns settlement-failed when the facilitator settle is unsuccessful", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		mockSettlePayment.mockResolvedValue({
			success: false,
			transaction: "",
			network: "base-sepolia",
			payer: PAYER_ID,
			errorReason: "insufficient_funds",
		});

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("settlement-failed");
		expect(ctx.client.post).toHaveBeenCalledTimes(1);
	});

	it("returns facilitator-error and sends NO receipt on a facilitator HTTP failure", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		mockVerifyPayment.mockRejectedValue(
			new X402FacilitatorError("verify 400", 400, { error: "no resource" }),
		);

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("facilitator-error");
		expect(result.facilitator_status).toBe(400);
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("returns no-keys when the payee has no local E2EE keys", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
			paymentMessage(),
		);
		mockAgentKeysExist.mockReturnValue(false);

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("no-keys");
		expect(mockDecryptMessage).not.toHaveBeenCalled();
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("returns not-payment for a non-x402_payment message", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
			paymentMessage({ type: "rine.v1.dm" }),
		);

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("not-payment");
		expect(mockVerifyPayment).not.toHaveBeenCalled();
	});

	it("requires message_id in its input schema", () => {
		const schema = rineFulfill.inputSchema as { required?: string[] };
		expect(schema.required).toContain("message_id");
	});
});

describe("rine_fulfill — registration", () => {
	it("is registered in the global tools array", async () => {
		const { tools } = await import("../../src/tools/index.js");
		expect(tools.map((t) => t.name)).toContain("rine_fulfill");
	});
});
