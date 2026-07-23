// rine_fulfill tests. The thing under test is the
// tool's SURFACE wiring: fetch the payment, guard (not-payment / no-keys), decrypt
// + parse it, hand it to rine-core's SHARED payee-settle orchestration
// (`resolvePayeeRequirement` → `settleToReceipt`), thread the receipt via the shared
// `sendReceipt`, and map the outcome to a TYPED status while surfacing the reconciled
// `matched_quote`. The ref binding + reconcile depth is owned by rine-core's own
// unit tests (payee-settle / quote-ref); the receipt-plane crypto + marker economics
// are owned by rine-core's payee-receipt / messages tests. Here those shared
// functions are stubbed at the MCP import boundary so the surface contract — status
// routing, refusal fail-closed WITH a terminal receipt, facilitator resolution,
// override plumbing, and marker-toggle forwarding — is exercised for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockDecryptMessage = vi.fn();
const mockAgentKeysExist = vi.fn();
const mockResolvePayeeRequirement = vi.fn();
const mockSettleToReceipt = vi.fn();
const mockSendReceipt = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		decryptMessage: (...a: unknown[]) => mockDecryptMessage(...a),
		agentKeysExist: (...a: unknown[]) => mockAgentKeysExist(...a),
		resolvePayeeRequirement: (...a: unknown[]) =>
			mockResolvePayeeRequirement(...a),
		settleToReceipt: (...a: unknown[]) => mockSettleToReceipt(...a),
		sendReceipt: (...a: unknown[]) => mockSendReceipt(...a),
	};
});

const { X402Error, X402FacilitatorError, X402_ERROR } = await import(
	"@rine-network/core"
);
const { fulfillTools } = await import("../../src/tools/x402-fulfill.js");

const rineFulfill = fulfillTools.find((t) => t.name === "rine_fulfill")!;

const PAYER_ID = "11111111-1111-1111-1111-111111111111";
const PAYEE_ID = "22222222-2222-2222-2222-222222222222";
const PAYMENT_ID = "33333333-3333-3333-3333-333333333333";
const QUOTE_ID = "44444444-4444-4444-4444-444444444444";
// EURC on Base Sepolia — in the known-asset registry (6 decimals).
const EURC = "0x808456652fdb597867f38412077a9182bf77359f";
const PAY_TO = "0x1111111111111111111111111111111111111111";

/** A payee-authored requirement (the honest, reconciled quote terms). */
function requirement(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		scheme: "exact",
		network: "eip155:84532",
		amount: "100000",
		asset: EURC,
		payTo: PAY_TO,
		maxTimeoutSeconds: 60,
		extra: { name: "EURC", version: "2" },
		...over,
	};
}

/** A structurally valid signed payment (its `accepted` block is payer-authored). */
function payment(): Record<string, unknown> {
	return {
		x402Version: 2,
		resource: { description: "translate a document" },
		accepted: requirement(),
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
		extensions: {},
	};
}

/** The `ResolvedPayeeRequirement` the shared resolver returns for a bound quote. */
function resolved(
	quoteMessageId: string | null = QUOTE_ID,
): Record<string, unknown> {
	return {
		requirement: requirement(),
		match: {
			quoteMessageId,
			amount: "100000",
			asset: EURC,
			network: "eip155:84532",
		},
	};
}

// The facilitator echoes the v1 network SLUG (never CAIP-2) into the settlement.
const SETTLEMENT = {
	success: true,
	transaction: "0xdeadbeef",
	network: "base-sepolia",
	payer: PAYER_ID,
};

/** A `settled` FulfillReceipt carrying the matched-quote provenance. */
function settledReceipt(
	quoteMessageId: string | null = QUOTE_ID,
): Record<string, unknown> {
	return {
		status: "settled",
		receiptBody: SETTLEMENT,
		matchedQuote: {
			quoteMessageId,
			amount: "100000",
			asset: EURC,
			network: "eip155:84532",
		},
	};
}

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

/** The last object argument handed to the shared `sendReceipt`. */
function lastReceiptCall(): Record<string, unknown> {
	const calls = mockSendReceipt.mock.calls;
	return calls[calls.length - 1]![0] as Record<string, unknown>;
}

/**
 * Wire the ctx so `/messages/{PAYMENT_ID}` returns the payment, it decrypts to a
 * valid PaymentPayload, the shared resolver binds it to the honest quote, the
 * shared ladder settles it, and the shared receipt send succeeds. Each test then
 * swaps in a specific resolver/settle behaviour for the branch under test.
 */
function primeFulfillable(
	ctx: ToolContext,
	opts: {
		pp?: Record<string, unknown>;
	} = {},
): void {
	const pp = opts.pp ?? payment();
	(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
		paymentMessage(),
	);
	mockAgentKeysExist.mockReturnValue(true);
	mockDecryptMessage.mockResolvedValue({
		plaintext: JSON.stringify(pp),
		verificationStatus: "valid",
	});
	mockResolvePayeeRequirement.mockResolvedValue(resolved());
	mockSettleToReceipt.mockResolvedValue(settledReceipt());
	mockSendReceipt.mockResolvedValue({ id: "receipt-1", conversation_id: "c-1" });
}

beforeEach(() => {
	mockDecryptMessage.mockReset();
	mockAgentKeysExist.mockReset();
	mockResolvePayeeRequirement.mockReset();
	mockSettleToReceipt.mockReset();
	mockSendReceipt.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("rine_fulfill — happy ref-bind (settles the referenced quote)", () => {
	it("resolves, settles, threads the receipt, and surfaces the matched quote", async () => {
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
		// The reconciled quote's provenance is surfaced (id + economic terms).
		expect(result.matched_quote).toEqual({
			message_id: QUOTE_ID,
			amount: "100000",
			asset: EURC,
			network: "eip155:84532",
		});

		// The settlement receipt is threaded to the payer via the shared sendReceipt.
		expect(mockSendReceipt).toHaveBeenCalledTimes(1);
		const call = lastReceiptCall();
		expect(call.client).toBe(ctx.client);
		expect(call.configDir).toBe(ctx.configDir);
		expect(call.payeeAgentId).toBe(PAYEE_ID);
		expect(call.payerAgentId).toBe(PAYER_ID);
		expect(call.messageId).toBe(PAYMENT_ID);
		expect(call.receiptBody).toEqual(SETTLEMENT);
		expect(call.emitMarker).toBe(true);
		expect(result.receipt).toEqual({ id: "receipt-1", conversation_id: "c-1" });
	});

	it("binds via the payee id + conversation of the payment, not the payer's terms", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);

		await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		});

		// The shared resolver is asked to bind THIS payment for THIS payee in THIS
		// conversation — the surface never re-derives terms from `pp.accepted`.
		const resolveArgs = mockResolvePayeeRequirement.mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect(resolveArgs.payeeAgentId).toBe(PAYEE_ID);
		expect(resolveArgs.conversationId).toBe("c-1");
		expect(resolveArgs.expected).toEqual({
			payTo: undefined,
			expectAmount: undefined,
			expectAsset: undefined,
			expectNetwork: undefined,
		});
		// The resolved payee-owned struct (not `pp.accepted`) is handed to the ladder.
		const [pp, resolvedArg, facilitator] = mockSettleToReceipt.mock.calls[0]!;
		expect((pp as Record<string, unknown>).accepted).toBeDefined();
		expect(resolvedArg).toEqual(resolved());
		expect((facilitator as Record<string, unknown>).url).toBe(
			"https://fac.test",
		);
	});

	it("defaults to the keyless payai preset when no facilitator is given", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		await rineFulfill.handler(ctx, { message_id: PAYMENT_ID });
		const facilitator = mockSettleToReceipt.mock.calls[0]![2] as {
			url: string;
		};
		expect(facilitator.url).toBe("https://facilitator.payai.network");
	});

	it("threads the receipt to the PAYER (the payment's sender)", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		});
		expect(lastReceiptCall().payerAgentId).toBe(PAYER_ID);
	});
});

describe("rine_fulfill — fail-closed refusals from the shared resolver (no settle, but terminal receipt)", () => {
	async function expectRefused(
		err: InstanceType<typeof X402Error>,
		expectedCode: string,
	): Promise<void> {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		mockResolvePayeeRequirement.mockRejectedValue(err);
		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;
		expect(result.status).toBe("payment-refused");
		expect(result.code).toBe(expectedCode);
		// Fail closed: never settle payer-authored terms.
		expect(mockSettleToReceipt).not.toHaveBeenCalled();
		// But STILL thread a terminal payment-failed refusal receipt so the payer's
		// thread does not hang open. The receipt body is a synthesised refusal carrying
		// the typed code, the payer address, and the network — never a success.
		expect(mockSendReceipt).toHaveBeenCalledTimes(1);
		const call = lastReceiptCall();
		expect(call.payeeAgentId).toBe(PAYEE_ID);
		expect(call.payerAgentId).toBe(PAYER_ID);
		expect(call.emitMarker).toBe(true);
		expect(call.receiptBody).toEqual({
			success: false,
			transaction: "",
			network: "eip155:84532",
			payer: PAYER_ID,
			errorReason: expectedCode,
		});
		expect(result.receipt).toEqual({ id: "receipt-1", conversation_id: "c-1" });
	}

	it("refuses a payment with no/forged/cross-conversation quote reference (no-quote)", async () => {
		await expectRefused(
			new X402Error(X402_ERROR.NO_QUOTE, "no ref"),
			"no-quote",
		);
	});

	it("refuses a payment whose terms mismatch the referenced quote (requirement-mismatch)", async () => {
		await expectRefused(
			new X402Error(X402_ERROR.REQUIREMENT_MISMATCH, "underpay"),
			"requirement-mismatch",
		);
	});

	it("refuses a partial expected-terms override (invalid-requirement)", async () => {
		await expectRefused(
			new X402Error(X402_ERROR.INVALID_REQUIREMENT, "partial"),
			"invalid-requirement",
		);
	});

	it("refuses an unknown-decimals expected asset (unknown-asset-decimals)", async () => {
		await expectRefused(
			new X402Error(X402_ERROR.UNKNOWN_ASSET_DECIMALS, "no decimals"),
			"unknown-asset-decimals",
		);
	});
});

describe("rine_fulfill — expected-terms override (out-of-band quote)", () => {
	it("passes the operator override through to the resolver and surfaces a null quote id", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		// The override path resolves with no quote message id (operator-authored).
		mockResolvePayeeRequirement.mockResolvedValue(resolved(null));
		mockSettleToReceipt.mockResolvedValue(settledReceipt(null));

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
			pay_to: PAY_TO,
			expect_amount: "0.1",
			expect_asset: EURC,
			expect_network: "eip155:84532",
		})) as Record<string, unknown>;

		expect(result.status).toBe("settled");
		expect((result.matched_quote as Record<string, unknown>).message_id).toBe(
			null,
		);
		// The four override fields are forwarded verbatim as the `expected` terms.
		const resolveArgs = mockResolvePayeeRequirement.mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect(resolveArgs.expected).toEqual({
			payTo: PAY_TO,
			expectAmount: "0.1",
			expectAsset: EURC,
			expectNetwork: "eip155:84532",
		});
	});
});

describe("rine_fulfill — cleartext marker toggle forwarded to the shared receipt", () => {
	it("forwards emit_marker=true by default (marker economics discipline is core's)", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		});
		expect(lastReceiptCall().emitMarker).toBe(true);
	});

	it("forwards emit_marker=false when the caller opts out", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
			emit_marker: false,
		});
		expect(lastReceiptCall().emitMarker).toBe(false);
	});
});

describe("rine_fulfill — failure branches (typed outcomes)", () => {
	it("threads the verification-failed receipt body when the shared ladder reports it", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		const verificationFailed = {
			status: "verification-failed",
			receiptBody: {
				success: false,
				transaction: "",
				network: "eip155:84532",
				payer: PAYER_ID,
				errorReason: "signature_mismatch",
			},
			matchedQuote: resolved().match,
		};
		mockSettleToReceipt.mockResolvedValue(verificationFailed);

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("verification-failed");
		expect(mockSendReceipt).toHaveBeenCalledTimes(1);
		expect(lastReceiptCall().receiptBody).toEqual(
			verificationFailed.receiptBody,
		);
	});

	it("returns settlement-failed when the shared ladder settle is unsuccessful", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		mockSettleToReceipt.mockResolvedValue({
			status: "settlement-failed",
			receiptBody: {
				success: false,
				transaction: "",
				network: "base-sepolia",
				payer: PAYER_ID,
				errorReason: "insufficient_funds",
			},
			matchedQuote: resolved().match,
		});

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("settlement-failed");
		expect(mockSendReceipt).toHaveBeenCalledTimes(1);
	});

	it("returns facilitator-error and sends NO receipt on a facilitator HTTP failure", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		mockSettleToReceipt.mockRejectedValue(
			new X402FacilitatorError("verify 400", 400, { error: "no resource" }),
		);

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("facilitator-error");
		expect(result.facilitator_status).toBe(400);
		expect(mockSendReceipt).not.toHaveBeenCalled();
	});

	it("returns malformed-payload and threads a failure receipt on an undecodable payment", async () => {
		const ctx = makeCtx();
		primeFulfillable(ctx);
		// Decrypts to a body with no `accepted` and no signed authorization: the REAL
		// parseX402Payload raises a typed MALFORMED_PAYLOAD before any resolve/settle.
		mockDecryptMessage.mockResolvedValue({
			plaintext: JSON.stringify({ payload: {} }),
			verificationStatus: "valid",
		});

		const result = (await rineFulfill.handler(ctx, {
			message_id: PAYMENT_ID,
			facilitator: "https://fac.test",
		})) as Record<string, unknown>;

		expect(result.status).toBe("malformed-payload");
		expect(result.code).toBe("malformed-payload");
		expect(mockResolvePayeeRequirement).not.toHaveBeenCalled();
		expect(mockSettleToReceipt).not.toHaveBeenCalled();
		// A graceful failure receipt is still threaded (no payer/network known yet).
		expect(mockSendReceipt).toHaveBeenCalledTimes(1);
		expect(lastReceiptCall().receiptBody).toEqual({
			success: false,
			transaction: "",
			network: "",
			payer: "",
			errorReason: "malformed-payload",
		});
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
		expect(mockSendReceipt).not.toHaveBeenCalled();
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
		expect(mockResolvePayeeRequirement).not.toHaveBeenCalled();
	});

	it("requires message_id in its input schema", () => {
		const schema = rineFulfill.inputSchema as { required?: string[] };
		expect(schema.required).toContain("message_id");
	});

	it("exposes the expected-terms override params in its input schema", () => {
		const schema = rineFulfill.inputSchema as {
			properties?: Record<string, unknown>;
		};
		for (const k of [
			"pay_to",
			"expect_amount",
			"expect_asset",
			"expect_network",
		])
			expect(schema.properties).toHaveProperty(k);
	});
});

describe("rine_fulfill — registration", () => {
	it("is registered in the global tools array", async () => {
		const { tools } = await import("../../src/tools/index.js");
		expect(tools.map((t) => t.name)).toContain("rine_fulfill");
	});
});
