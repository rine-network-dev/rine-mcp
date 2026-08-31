// rine_pay tests. The thing under test is the tool's wiring of the
// message plane to rine-core's REAL wallet/policy/x402 logic: quote decrypt →
// policy select (deny-by-default + caps) → EIP-3009 sign → in-thread send →
// local spend accounting. Only the NETWORK-coupled crypto boundary is mocked
// (decrypt/encrypt/recipient-key fetch + agentKeysExist); the wallet key,
// policy, signing, marker, and spend journal are exercised for real against a
// throwaway config dir.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockDecryptMessage = vi.fn();
const mockEncryptMessage = vi.fn();
const mockFetchRecipientKeys = vi.fn();
const mockAgentKeysExist = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		decryptMessage: (...a: unknown[]) => mockDecryptMessage(...a),
		encryptMessage: (...a: unknown[]) => mockEncryptMessage(...a),
		fetchRecipientKeys: (...a: unknown[]) => mockFetchRecipientKeys(...a),
		agentKeysExist: (...a: unknown[]) => mockAgentKeysExist(...a),
	};
});

const { createWallet, savePolicy, readDailySpent, X402_QUOTE_REF_KEY } =
	await import("@rine-network/core");
const { paymentTools } = await import("../../src/tools/payments.js");

const rinePay = paymentTools.find((t) => t.name === "rine_pay")!;

const PAYER_ID = "11111111-1111-1111-1111-111111111111";
const PAYEE_ID = "22222222-2222-2222-2222-222222222222";
const QUOTE_ID = "33333333-3333-3333-3333-333333333333";
// base-sepolia EURC contract (from rine-core's asset registry) + payee wallet.
const EURC = "0x808456652fdb597867f38412077a9182bf77359f";
const PAY_TO = "0x1111111111111111111111111111111111111111";

let CONFIG_DIR: string;

function quotePayload(amount = "100000"): Record<string, unknown> {
	return {
		x402Version: 2,
		resource: { description: "translate a document" },
		accepts: [
			{
				scheme: "exact",
				network: "eip155:84532",
				amount, // atomic 6-decimal units (100000 = 0.10 EURC)
				asset: EURC,
				payTo: PAY_TO,
				maxTimeoutSeconds: 60,
				extra: { name: "EURC", version: "2" },
			},
		],
		extensions: {},
	};
}

function quoteMessage(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: QUOTE_ID,
		type: "rine.v1.x402_payment_required",
		conversation_id: "c-1",
		to_agent_id: PAYER_ID,
		from_agent_id: PAYEE_ID,
		encrypted_payload: "CIPHERTEXT",
		encryption_version: "hpke-v1",
		...over,
	};
}

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: CONFIG_DIR,
		apiUrl: "https://api.test",
	};
}

function policy(over: Record<string, unknown> = {}) {
	return {
		perTxCap: "1.00",
		dailyCap: "10.00",
		allowedAssets: ["EURC"],
		allowedNetworks: ["eip155:84532"],
		autoPayThreshold: "0.50",
		...over,
	};
}

/** Wire the ctx so the quote decrypts to `payload` and the send succeeds. */
function primePayable(
	ctx: ToolContext,
	payload: Record<string, unknown>,
): void {
	(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
		quoteMessage(),
	);
	mockAgentKeysExist.mockReturnValue(true);
	mockDecryptMessage.mockResolvedValue({
		plaintext: JSON.stringify(payload),
		senderKid: `rine:${PAYEE_ID}`,
		verified: true,
		verificationStatus: "verified",
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
	(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
		id: "sent-1",
		conversation_id: "c-1",
	});
}

beforeEach(() => {
	CONFIG_DIR = fs.mkdtempSync(join(tmpdir(), "rine-mcp-pay-test-"));
	mockDecryptMessage.mockReset();
	mockEncryptMessage.mockReset();
	mockFetchRecipientKeys.mockReset();
	mockAgentKeysExist.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

describe("rine_pay — happy path", () => {
	it("signs and sends the payment in-thread and returns payment-submitted", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("payment-submitted");
		expect(result.paid).toEqual({
			network: "eip155:84532",
			asset: EURC,
			amount: "100000",
			payTo: PAY_TO,
		});

		// Sent in-thread as a reply, as the payer agent, with the x402_payment type.
		const post = ctx.client.post as ReturnType<typeof vi.fn>;
		const [url, body, headers] = post.mock.calls[0]!;
		expect(url).toBe(`/messages/${QUOTE_ID}/reply`);
		expect(headers).toEqual({ "X-Rine-Agent": PAYER_ID });
		expect((body as Record<string, unknown>).type).toBe("rine.v1.x402_payment");
		expect((body as Record<string, unknown>).content_type).toBe(
			"application/json",
		);
		expect((body as Record<string, unknown>).encrypted_payload).toBe("ENC");
	});

	it("checks the quote envelope against the quote's server-authenticated sender", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		await rinePay.handler(ctx, { message_id: QUOTE_ID });

		// The expected signer is the payee the server says issued the quote —
		// never the kid or the header the sender supplied.
		expect(mockDecryptMessage.mock.calls[0]![4]).toBe(PAYEE_ID);
	});

	it("signs the ACTUAL PaymentPayload (real EIP-3009 signature) before encrypting", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		await rinePay.handler(ctx, { message_id: QUOTE_ID });

		// The object handed to encryptMessage is the verbatim signed PaymentPayload.
		const signed = mockEncryptMessage.mock.calls[0]![3] as {
			accepted: { payTo: string };
			payload: {
				signature: string;
				authorization: { to: string; value: string };
			};
		};
		expect(signed.accepted.payTo).toBe(PAY_TO);
		expect(signed.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
		expect(signed.payload.authorization.to).toBe(PAY_TO);
		expect(signed.payload.authorization.value).toBe("100000");
	});

	it("stamps the answered quote's message-id into the signed payload", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		await rinePay.handler(ctx, { message_id: QUOTE_ID });

		// The payee binds settlement to THIS quote via the signed, E2EE extensions;
		// the ref is the quote message id this tool paid (never a bare string literal).
		const signed = mockEncryptMessage.mock.calls[0]![3] as {
			extensions: Record<string, unknown>;
		};
		expect(signed.extensions[X402_QUOTE_REF_KEY]).toBe(QUOTE_ID);
	});

	it("records the spend locally after a successful send", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(0n);
		await rinePay.handler(ctx, { message_id: QUOTE_ID });
		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(100000n);
	});
});

describe("rine_pay — cleartext marker carries no economics", () => {
	it("attaches only {status,rail} by default and never an amount/asset/address", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		await rinePay.handler(ctx, { message_id: QUOTE_ID });

		const body = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(body.metadata).toEqual({
			"rine.x402": { status: "payment-submitted", rail: "x402" },
		});
		const markerJson = JSON.stringify(body.metadata);
		expect(markerJson).not.toContain("100000");
		expect(markerJson).not.toContain(EURC);
		expect(markerJson).not.toContain(PAY_TO);
	});

	it("omits the marker entirely when emit_marker=false", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		await rinePay.handler(ctx, { message_id: QUOTE_ID, emit_marker: false });

		const body = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(body).not.toHaveProperty("metadata");
	});
});

describe("rine_pay — policy refusals", () => {
	it("refuses over the per-tx cap without sending", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload("2000000")); // 2.00 EURC > 1.00 cap

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("policy-refused");
		expect(result.reason).toBe("per-tx-cap-exceeded");
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("denies by default when no spend policy is configured", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID); // wallet but NO policy
		primePayable(ctx, quotePayload());

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("policy-refused");
		expect(String(result.detail).toLowerCase()).toContain("denied by default");
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("refuses an asset outside the allow-list", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy({ allowedAssets: ["USDC"] }));
		primePayable(ctx, quotePayload());

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("policy-refused");
		expect(ctx.client.post).not.toHaveBeenCalled();
	});
});

describe("rine_pay — auto-pay threshold", () => {
	it("refuses when auto_pay=true and the quote exceeds autoPayThreshold", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy({ autoPayThreshold: "0.05" }));
		primePayable(ctx, quotePayload()); // 0.10 > 0.05

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
			auto_pay: true,
		})) as Record<string, unknown>;

		expect(result.status).toBe("above-auto-pay-threshold");
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("pays when auto_pay=true and the quote is at/below autoPayThreshold", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy({ autoPayThreshold: "0.50" }));
		primePayable(ctx, quotePayload()); // 0.10 <= 0.50

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
			auto_pay: true,
		})) as Record<string, unknown>;

		expect(result.status).toBe("payment-submitted");
		expect(ctx.client.post).toHaveBeenCalledTimes(1);
	});
});

describe("rine_pay — reserve-under-lock + double-pay guard", () => {
	it("returns already-paid on a repeat pay of the same quote, unless allow_repay", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		const first = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;
		expect(first.status).toBe("payment-submitted");
		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(100000n);

		// Re-paying the same quote id is refused and does NOT debit or send again.
		const repeat = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;
		expect(repeat.status).toBe("already-paid");
		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(100000n);
		expect(ctx.client.post).toHaveBeenCalledTimes(1);

		// allow_repay forces a second, deliberate, permanent debit + send.
		const forced = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
			allow_repay: true,
		})) as Record<string, unknown>;
		expect(forced.status).toBe("payment-submitted");
		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(200000n);
		expect(ctx.client.post).toHaveBeenCalledTimes(2);
	});

	it("fail-closed: reservation STANDS when the reply send fails (no refund)", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());
		(ctx.client.post as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("boom"),
		);

		await expect(
			rinePay.handler(ctx, { message_id: QUOTE_ID }),
		).rejects.toThrow("boom");
		// Debit reserved before transmit is permanent — the failed send never refunds.
		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(100000n);
	});
});

describe("rine_pay — guard branches", () => {
	it("returns no-wallet when the agent has no wallet key", async () => {
		const ctx = makeCtx();
		savePolicy(CONFIG_DIR, PAYER_ID, policy()); // policy but NO wallet
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
			quoteMessage(),
		);

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("no-wallet");
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("returns not-payment-required for a non-x402 message", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
			quoteMessage({ type: "rine.v1.dm" }),
		);

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("not-payment-required");
		expect(mockDecryptMessage).not.toHaveBeenCalled();
	});

	it("requires message_id in its input schema", () => {
		const schema = rinePay.inputSchema as { required?: string[] };
		expect(schema.required).toContain("message_id");
	});
});

describe("rine_pay — sender binding on the money path", () => {
	/** A third agent that re-seals the payee's quote and posts it as its own. */
	const RESEALER_ID = "44444444-4444-4444-4444-444444444444";

	/** The quote decrypts to payable terms; only its signer is wrong. */
	function resealedQuote(ctx: ToolContext, status: string): void {
		primePayable(ctx, quotePayload());
		mockDecryptMessage.mockResolvedValue({
			plaintext: JSON.stringify(quotePayload()),
			senderKid: `rine:${RESEALER_ID}`,
			verified: false,
			verificationStatus: status,
		});
	}

	it("returns inauthentic-quote for a quote the payee did not sign, and spends nothing", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		resealedQuote(ctx, "sender-mismatch");

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		// A typed refusal, not a parse complaint: the model must be able to tell a
		// re-sealed quote from a malformed one.
		expect(result.status).toBe("inauthentic-quote");
		expect(result.reason).toBe("inauthentic-sender");
		expect(String(result.detail)).toContain(RESEALER_ID);
		expect(ctx.client.post).not.toHaveBeenCalled();
		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(0n);
	});

	it("returns inauthentic-quote when the quote's signature does not check out", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		resealedQuote(ctx, "invalid");

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("inauthentic-quote");
		expect(ctx.client.post).not.toHaveBeenCalled();
		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(0n);
	});

	it("still pays a quote the payee did sign (false-positive guard)", async () => {
		const ctx = makeCtx();
		createWallet(CONFIG_DIR, PAYER_ID);
		savePolicy(CONFIG_DIR, PAYER_ID, policy());
		primePayable(ctx, quotePayload());

		const result = (await rinePay.handler(ctx, {
			message_id: QUOTE_ID,
		})) as Record<string, unknown>;

		expect(result.status).toBe("payment-submitted");
		expect(readDailySpent(CONFIG_DIR, PAYER_ID)).toBe(100000n);
	});
});

describe("rine_pay — registration", () => {
	it("is registered in the global tools array", async () => {
		const { tools } = await import("../../src/tools/index.js");
		expect(tools.map((t) => t.name)).toContain("rine_pay");
	});
});
