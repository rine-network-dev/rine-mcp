// MCP x402 payee tool: rine_fulfill. Thin adapter that
// wires the message plane to rine-core's SHARED payee-settle orchestration
// (reconcile against the payee's own referenced quote → verify → settle →
// receipt). The payee NEVER settles the payer-echoed `accepted` block —
// it binds the payment to the ONE quote it references (the signed
// `extensions["rine.quoteMessageId"]`, proven payee-issued + same-conversation) or
// explicit operator expected terms, fails closed on a missing/forged ref, and
// forwards only the payee-owned requirement to the facilitator. A fail-closed
// refusal still threads a terminal payment-failed receipt (settling NOTHING) so the
// payer's thread never hangs open — parity with the malformed-payload branch and
// both SDK payees. A malformed payload is a typed refusal (graceful receipt),
// never a stack trace. Every branch returns a TYPED `status`; the full contract
// lives in the tool `description`.

import {
	type ExpectedTermsInput,
	type MessageRead,
	type PaymentPayload,
	X402Error,
	X402FacilitatorError,
	X402_MESSAGE_TYPE,
	agentKeysExist,
	decryptMessage,
	matchedQuoteToWire,
	parseX402Payload,
	refusalReceiptBody,
	resolveFacilitatorConfig,
	resolvePayeeRequirement,
	sendReceipt,
	settleToReceipt,
} from "@rine-network/core";
import type { ToolContext, ToolDef } from "./types.js";

const rineFulfill: ToolDef = {
	name: "rine_fulfill",
	description:
		"Settle a received x402 payment (rine.v1.x402_payment) and reply with an " +
		"x402 receipt in-thread. Binds the payment to the ONE quote it answers: the " +
		"payer stamps that quote's message-id into the signed payload, and the payee " +
		"loads THAT quote (proven payee-issued in this conversation) and reconciles " +
		"against its terms (never the payer's echoed `accepted`), then verifies and " +
		"settles via the configured facilitator (plain external HTTP, never a rine " +
		"endpoint) and threads the rine.v1.x402_receipt in the same conversation. " +
		"FAIL-CLOSED: a payment with no quote reference (older payer / out-of-band), " +
		"a reference that is not a payee-issued quote in this conversation, or terms " +
		"that do not match the quote (wrong payTo/asset/network/scheme or " +
		"underpayment) make the payee REFUSE to settle. Supply explicit expected " +
		"terms (pay_to + expect_amount + expect_asset + expect_network, scheme=exact) " +
		"to authorize an out-of-band quote; the explicit expectation is authoritative " +
		"and needs no reference. On success the result surfaces `matched_quote` (the " +
		"reconciled quote's message-id + amount + asset + network) so the integration " +
		"can confirm the paid quote corresponds to the good it delivers. Returns a " +
		"typed `status` — `settled`, `settlement-failed`, " +
		"`verification-failed`, `payment-refused` (no/forged quote reference or bad " +
		"expected terms; the typed `code` is included and a failure receipt is " +
		"threaded so the payer reaches a terminal state, but nothing is settled), " +
		"`malformed-payload` (undecodable payload; a failure receipt is threaded), " +
		"`facilitator-error` (no receipt), `no-keys`, or `not-payment`. It does NOT " +
		"sign anything and returns no key material.",
	inputSchema: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description:
					"UUID of the received rine.v1.x402_payment message to settle.",
			},
			facilitator: {
				type: "string",
				description:
					"Facilitator preset ('cdp' | 'payai' | 'x402-rs') or an http(s):// " +
					"base URL. Defaults to 'payai' (keyless). verify/settle is plain " +
					"external HTTP; rine never touches funds.",
			},
			facilitator_headers: {
				type: "object",
				description:
					"Optional auth headers for the facilitator (e.g. CDP credentials). " +
					"Passed verbatim as request headers.",
			},
			verify_path: {
				type: "string",
				description: "Override the facilitator's /verify path.",
			},
			settle_path: {
				type: "string",
				description: "Override the facilitator's /settle path.",
			},
			pay_to: {
				type: "string",
				description:
					"Expected-terms override: the payee wallet (0x) the payment must pay. " +
					"Requires expect_amount + expect_asset + expect_network together; " +
					"authorizes an out-of-band quote and is authoritative, needing no " +
					"stamped quote reference.",
			},
			expect_amount: {
				type: "string",
				description:
					"Expected-terms override: minimum amount in MAJOR units (e.g. '1.00'). " +
					"Overpayment is allowed, underpayment refused.",
			},
			expect_asset: {
				type: "string",
				description:
					"Expected-terms override: the token contract address (0x) required.",
			},
			expect_network: {
				type: "string",
				description:
					"Expected-terms override: the CAIP-2 network (e.g. 'eip155:8453') required.",
			},
			emit_marker: {
				type: "boolean",
				description:
					"Attach the cleartext status marker (metadata['rine.x402']). " +
					"Default true. The marker carries only coarse lifecycle state " +
					"(never amounts/assets/addresses/tx-hashes).",
			},
		},
		required: ["message_id"],
	},
	async handler(ctx: ToolContext, p) {
		const messageId = String(p.message_id);
		const message = (await ctx.client.get(
			`/messages/${messageId}`,
		)) as MessageRead;

		if (message.type !== X402_MESSAGE_TYPE.PAYMENT) {
			return {
				status: "not-payment",
				detail: `Message ${messageId} is type '${message.type}', not ${X402_MESSAGE_TYPE.PAYMENT}.`,
			};
		}

		// The payer (who receives the receipt) is the payment's sender; the payee
		// (this agent, which decrypts + settles) is its recipient.
		const payeeAgentId = message.to_agent_id;
		const payerAgentId = message.from_agent_id;
		if (!payeeAgentId || !payerAgentId) {
			throw new Error("Payment is missing sender/recipient — cannot fulfill.");
		}
		if (!agentKeysExist(ctx.configDir, payeeAgentId)) {
			return {
				status: "no-keys",
				detail: `No local E2EE keys for agent ${payeeAgentId} — cannot decrypt the payment.`,
			};
		}

		const facilitator = resolveFacilitatorConfig(String(p.facilitator ?? "payai"), {
			headers: p.facilitator_headers as Record<string, string> | undefined,
			verifyPath: p.verify_path as string | undefined,
			settlePath: p.settle_path as string | undefined,
		});

		const { plaintext } = await decryptMessage(
			ctx.configDir,
			payeeAgentId,
			message.encrypted_payload,
			ctx.client,
		);

		// A structurally malformed payment (no `accepted` / no signed
		// authorization) is a typed, catchable refusal — thread a graceful
		// payment-failed receipt so the payer reaches a terminal state, never a
		// stack trace.
		let pp: PaymentPayload;
		try {
			pp = parseX402Payload(message.type, plaintext) as PaymentPayload;
		} catch (err) {
			if (!(err instanceof X402Error)) throw err;
			const sent = await sendReceipt({
				client: ctx.client,
				configDir: ctx.configDir,
				payeeAgentId,
				payerAgentId,
				messageId,
				receiptBody: refusalReceiptBody("", "", err.code),
				emitMarker: p.emit_marker !== false,
			});
			return {
				status: "malformed-payload",
				code: err.code,
				detail: err.message,
				receipt: sent,
			};
		}

		// Reconcile the payment against the payee's OWN quote — the ONE
		// it references, or explicit expected terms, and forward the payee-owned requirement —
		// never the payer-echoed `pp.accepted` — to the facilitator. A missing/forged
		// reference or a mismatch ⇒ REFUSE: settle NOTHING (the payer-authored terms are
		// never forwarded), but still thread a `payment-failed` refusal receipt so the
		// payer's thread reaches a terminal state — parity with the malformed-payload
		// branch and both SDK payees. A malicious payer can never coax a settlement.
		const expected: ExpectedTermsInput = {
			payTo: p.pay_to as string | undefined,
			expectAmount: p.expect_amount as string | undefined,
			expectAsset: p.expect_asset as string | undefined,
			expectNetwork: p.expect_network as string | undefined,
		};
		let resolved: Awaited<ReturnType<typeof resolvePayeeRequirement>>;
		try {
			resolved = await resolvePayeeRequirement({
				payment: pp,
				expected,
				client: ctx.client,
				configDir: ctx.configDir,
				payeeAgentId,
				conversationId: message.conversation_id,
			});
		} catch (err) {
			if (!(err instanceof X402Error)) throw err;
			const sent = await sendReceipt({
				client: ctx.client,
				configDir: ctx.configDir,
				payeeAgentId,
				payerAgentId,
				messageId,
				receiptBody: refusalReceiptBody(
					pp.accepted.network,
					pp.payload.authorization.from,
					err.code,
				),
				emitMarker: p.emit_marker !== false,
			});
			return {
				status: "payment-refused",
				code: err.code,
				detail: err.message,
				receipt: sent,
			};
		}

		let outcome: Awaited<ReturnType<typeof settleToReceipt>>;
		try {
			outcome = await settleToReceipt(pp, resolved, facilitator);
		} catch (err) {
			if (err instanceof X402FacilitatorError) {
				return {
					status: "facilitator-error",
					facilitator_status: err.status ?? null,
					detail: err.message,
				};
			}
			throw err;
		}

		const sent = await sendReceipt({
			client: ctx.client,
			configDir: ctx.configDir,
			payeeAgentId,
			payerAgentId,
			messageId,
			receiptBody: outcome.receiptBody,
			emitMarker: p.emit_marker !== false,
		});

		// The settlement's `network` is the facilitator's verbatim v1 slug —
		// echoed through, never re-derived or CAIP-2 matched.
		return {
			status: outcome.status,
			receipt: sent,
			settlement: {
				success: outcome.receiptBody.success,
				transaction: outcome.receiptBody.transaction || null,
				network: outcome.receiptBody.network,
				payer: outcome.receiptBody.payer,
			},
			// The payee-owned quote this payment was bound to (its message-id is
			// null for an operator `--expect` override). The integration owns the
			// good<->quote correspondence — it confirms the paid quote is the one it
			// delivers against.
			matched_quote: matchedQuoteToWire(outcome.matchedQuote),
		};
	},
};

export const fulfillTools: ToolDef[] = [rineFulfill];
