// MCP x402 payment tool: rine_pay. Request/response-shaped (NO
// long-running watcher — a settlement watcher would hang the stdio transport,
// same rule as the relay in hooks.ts). rine_pay consumes a RECEIVED
// `rine.v1.x402_payment_required`, applies the wallet + spend policy via
// rine-core, and sends the signed `rine.v1.x402_payment` IN-THREAD (reply, so
// conversation_id is preserved). The settlement receipt arrives later as an
// ordinary inbox message (rine_read / rine_inbox / rine_thread) — this tool
// never blocks waiting for it.
//
// Every terminal branch returns a TYPED `status` (never throws for an expected
// refusal): the agent reasons over the outcome. Deny-by-default and all cap
// enforcement live in rine-core (`selectRequirement`); this tool only wires the
// message plane to it. No key material is ever returned.

import {
	ACTING_AGENT_HEADER,
	type MessageRead,
	type PaymentRequired,
	X402Error,
	X402_ERROR,
	X402_MESSAGE_TYPE,
	buildPaymentMessage,
	buildPaymentPayload,
	isAutoPayable,
	loadPolicy,
	loadWalletKey,
	readDailySpent,
	reserveSpend,
	sealForAgent,
	selectRequirement,
	walletKeyExists,
} from "@rine-network/core";
import { actingHeaders } from "./tool-actors.js";
import type { ToolDef } from "./types.js";
import { PAY_STATUS, quoteRefusal, readQuote } from "./x402-quote.js";

const rinePay: ToolDef = {
	name: "rine_pay",
	description:
		"Pay a received x402 payment request (rine.v1.x402_payment_required) " +
		"in-thread. Decrypts the quote, selects an acceptable requirement under " +
		"the agent's local spend policy (deny-by-default), signs an EIP-3009 " +
		"stablecoin authorization with the agent's wallet, and sends the signed " +
		"rine.v1.x402_payment back in the same conversation, stamping the quote's " +
		"message-id into the signed payload so the payee can bind settlement to this " +
		"exact quote. The spend is reserved " +
		"under a cross-process lock as the last act before the send (fail-closed: " +
		"the debit stands even if the send then fails, and there is no refund). " +
		"Returns a typed `status` — `payment-submitted` on success, or `no-wallet` / " +
		"`not-payment-required` / `policy-refused` / `above-auto-pay-threshold` / " +
		"`already-paid` / `wallet-busy` / `inauthentic-quote` (the quote's envelope was " +
		"not signed by the agent the server authenticated as its sender — nothing is " +
		"signed and nothing is spent) / `sender-unverifiable` (the sender's signing key " +
		"could not be read, so the quote could not be checked — nothing is signed and " +
		"nothing is spent; retry later). It does NOT wait for settlement: the receipt " +
		"arrives later as an ordinary inbox message (read it with rine_read / " +
		"rine_inbox / rine_thread).",
	inputSchema: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description:
					"UUID of the received rine.v1.x402_payment_required message to pay.",
			},
			auto_pay: {
				type: "boolean",
				description:
					"If true, pay ONLY when the quote is at/below the policy's " +
					"autoPayThreshold; otherwise return `above-auto-pay-threshold` " +
					"without paying. Default false (an explicit rine_pay call is the " +
					"authorization, still bounded by the spend caps).",
			},
			emit_marker: {
				type: "boolean",
				description:
					"Attach the cleartext status marker (metadata['rine.x402']). " +
					"Default true. The marker carries only coarse lifecycle state " +
					"(never amounts/assets/addresses). Set false for a fully-sealed send.",
			},
			allow_repay: {
				type: "boolean",
				description:
					"If true, re-pay a quote already paid today, bypassing the " +
					"once-per-message guard (a deliberate second, permanent debit). " +
					"Default false — a repeat pay of the same message_id returns " +
					"`already-paid` without spending.",
			},
		},
		required: ["message_id"],
	},
	async handler(ctx, p) {
		const messageId = String(p.message_id);
		// The payer is read OUT of the quote below (`original.to_agent_id`), so
		// the read cannot name the actor from its arguments — hence the lazy rung
		// (`actingHeaders`, see its JSDoc in `tool-actors.ts`).
		const original = (await ctx.client.get(
			`/messages/${messageId}`,
			{},
			await actingHeaders(ctx, p),
		)) as MessageRead;

		if (original.type !== X402_MESSAGE_TYPE.PAYMENT_REQUIRED) {
			return {
				status: PAY_STATUS.NOT_PAYMENT_REQUIRED,
				detail: `Message ${messageId} is type '${original.type}', not ${X402_MESSAGE_TYPE.PAYMENT_REQUIRED}.`,
			};
		}

		// The payer is definitionally the recipient of the quote; the payee (who
		// gets the signed payment) is its sender. Mirrors rine_reply's routing.
		const agentId = original.to_agent_id;
		const recipientId = original.from_agent_id;
		if (!agentId || !recipientId) {
			throw new Error("Quote is missing sender/recipient — cannot pay.");
		}

		if (!walletKeyExists(ctx.configDir, agentId)) {
			return {
				status: PAY_STATUS.NO_WALLET,
				detail: `No wallet for agent ${agentId}. Create one with 'rine wallet create' before paying.`,
			};
		}

		let pr: PaymentRequired;
		try {
			pr = await readQuote(ctx, agentId, original, recipientId);
		} catch (err) {
			const refusal = quoteRefusal(err);
			if (refusal) return refusal;
			return {
				status: PAY_STATUS.NOT_PAYMENT_REQUIRED,
				detail: `Could not parse a PaymentRequired from ${messageId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			};
		}

		const policy = loadPolicy(ctx.configDir, agentId);
		const dailySpent = readDailySpent(ctx.configDir, agentId);

		let requirement: ReturnType<typeof selectRequirement>;
		try {
			requirement = selectRequirement(pr, policy, dailySpent);
		} catch (err) {
			if (err instanceof X402Error) {
				// `selectRequirement` wraps the specific per-candidate rejection
				// (per-tx-cap-exceeded / no-policy / asset-not-allowed / …) in
				// `details.reason`; surface that actionable code, not the generic
				// `no-acceptable-requirement` wrapper.
				const reason =
					typeof err.details?.reason === "string"
						? err.details.reason
						: err.code;
				return {
					status: PAY_STATUS.POLICY_REFUSED,
					reason,
					detail: err.message,
				};
			}
			throw err;
		}

		// `policy` is non-null here (selectRequirement denies a null policy).
		if (p.auto_pay === true && policy && !isAutoPayable(policy, requirement)) {
			return {
				status: PAY_STATUS.ABOVE_AUTO_PAY_THRESHOLD,
				detail: `Quote exceeds autoPayThreshold (${policy.autoPayThreshold}). Re-run without auto_pay to authorize explicitly.`,
				requirement: {
					network: requirement.network,
					asset: requirement.asset,
					amount: requirement.amount,
					payTo: requirement.payTo,
				},
			};
		}

		const walletKey = loadWalletKey(ctx.configDir, agentId);
		// Stamp the answered quote's message-id into the SIGNED payload so the
		// payee can bind this payment to the ONE quote it authored (never the
		// payer-echoed terms). `messageId` IS that quote's id — this tool pays a
		// specific received rine.v1.x402_payment_required.
		const payment = buildPaymentPayload(pr, requirement, walletKey, {
			quoteMessageId: messageId,
		});
		const built = buildPaymentMessage(payment, {
			emitMarker: p.emit_marker !== false,
		});

		const encrypted = await sealForAgent(
			ctx.client,
			ctx.configDir,
			{ senderAgentId: agentId, recipientAgentId: recipientId },
			built.payload,
		);

		const body: Record<string, unknown> = {
			type: built.type,
			content_type: built.content_type,
			payload_schema: built.payload_schema,
			...encrypted,
		};
		if (built.metadata) body.metadata = built.metadata;

		// Last local act before transmit: reserve the spend under the cross-process
		// lock (re-runs the full policy against the fresh daily total; refuses a
		// same-message re-pay unless allow_repay). The debit is permanent — the send
		// below never refunds it. Reserve refusals map to their own typed statuses.
		try {
			await reserveSpend(ctx.configDir, agentId, policy, requirement, {
				messageId,
				force: p.allow_repay === true,
			});
		} catch (err) {
			if (err instanceof X402Error) {
				if (err.code === X402_ERROR.ALREADY_PAID) {
					return { status: PAY_STATUS.ALREADY_PAID, detail: err.message };
				}
				if (err.code === X402_ERROR.WALLET_BUSY) {
					return { status: PAY_STATUS.WALLET_BUSY, detail: err.message };
				}
				return {
					status: PAY_STATUS.POLICY_REFUSED,
					reason: err.code,
					detail: err.message,
				};
			}
			throw err;
		}

		const sent = await ctx.client.post(`/messages/${messageId}/reply`, body, {
			[ACTING_AGENT_HEADER]: agentId,
		});

		return {
			status: PAY_STATUS.SUBMITTED,
			message: sent,
			paid: {
				network: requirement.network,
				asset: requirement.asset,
				amount: requirement.amount,
				payTo: requirement.payTo,
			},
		};
	},
};

export const paymentTools: ToolDef[] = [rinePay];
