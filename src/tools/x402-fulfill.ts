// REQ-M04 — MCP x402 payee tool: rine_fulfill. Request/response-shaped (NO
// long-running watcher, same rule as rine_pay). rine_fulfill consumes a RECEIVED
// `rine.v1.x402_payment`, verifies + settles it via the configured facilitator
// (plain external HTTP — never a rine endpoint), and sends the signed
// `rine.v1.x402_receipt` back IN-THREAD (reply, so conversation_id is preserved).
// Settle-first: on an invalid verification, settlement is skipped and a
// `success:false` receipt is sent so the payer still reaches `payment-failed`.
//
// Every terminal branch returns a TYPED `status` (never throws for an expected
// outcome): `settled` / `settlement-failed` / `verification-failed` /
// `facilitator-error` / `no-keys` / `not-payment`. The payee signs nothing (it
// holds no payer wallet); it only needs its E2EE keys to decrypt the payment and
// encrypt the receipt. The settlement's `network` is the facilitator's verbatim
// v1 slug — echoed through, NEVER CAIP-2 string-matched. No key material is
// returned.

import {
	agentKeysExist,
	buildReceiptMessage,
	decryptMessage,
	encryptMessage,
	fetchRecipientKeys,
	type MessageRead,
	type PaymentPayload,
	parseX402Payload,
	X402_MESSAGE_TYPE,
	X402FacilitatorError,
} from "@rine-network/core";
import type { ToolContext, ToolDef } from "./types.js";
import { resolveFacilitator, settleToReceipt } from "./x402-facilitator.js";

const rineFulfill: ToolDef = {
	name: "rine_fulfill",
	description:
		"Settle a received x402 payment (rine.v1.x402_payment) and reply with an " +
		"x402 receipt in-thread. Decrypts the signed payment, verifies then " +
		"settles it via the configured facilitator (plain external HTTP, never a " +
		"rine endpoint), and sends the rine.v1.x402_receipt back in the same " +
		"conversation so the payer's thread reaches a terminal state. Settle-first: " +
		"an invalid verification skips settlement and sends a failure receipt. " +
		"Returns a typed `status` — `settled` when the payment settled on-chain, " +
		"`settlement-failed` when the facilitator settle returned unsuccessful, " +
		"`verification-failed` when the signed payment was invalid, " +
		"`facilitator-error` when the facilitator call itself failed (no receipt " +
		"sent), `no-keys`, or `not-payment`. It does NOT sign anything and returns " +
		"no key material.",
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

		const facilitator = resolveFacilitator(String(p.facilitator ?? "payai"), {
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
		const pp = parseX402Payload(message.type, plaintext) as PaymentPayload;

		let outcome: Awaited<ReturnType<typeof settleToReceipt>>;
		try {
			outcome = await settleToReceipt(pp, facilitator);
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

		const built = buildReceiptMessage(outcome.receiptBody, {
			emitMarker: p.emit_marker !== false,
		});
		const recipientKeys = await fetchRecipientKeys(ctx.client, payerAgentId);
		const encrypted = await encryptMessage(
			ctx.configDir,
			payeeAgentId,
			recipientKeys.encryption,
			built.payload,
			recipientKeys.pqEncryption,
		);
		const body: Record<string, unknown> = {
			type: built.type,
			content_type: built.content_type,
			payload_schema: built.payload_schema,
			...encrypted,
		};
		if (built.metadata) body.metadata = built.metadata;

		const sent = await ctx.client.post(`/messages/${messageId}/reply`, body, {
			"X-Rine-Agent": payeeAgentId,
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
		};
	},
};

export const fulfillTools: ToolDef[] = [rineFulfill];
