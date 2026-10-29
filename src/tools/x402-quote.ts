// The quote half of rine_pay: terminal statuses, reading the payee's quote and
// mapping a sender-gate refusal onto the agent-facing status.

import {
	type MessageRead,
	type PaymentRequired,
	X402Error,
	X402_ERROR,
	agentKeysExist,
	decryptMessage,
	parseX402Payload,
	requireVerifiedPlaintext,
} from "@rine-network/core";
import type { ToolContext } from "./types.js";

/** Terminal outcome statuses of rine_pay (typed — never a bare string). */
export const PAY_STATUS = {
	SUBMITTED: "payment-submitted",
	NO_WALLET: "no-wallet",
	NOT_PAYMENT_REQUIRED: "not-payment-required",
	POLICY_REFUSED: "policy-refused",
	ABOVE_AUTO_PAY_THRESHOLD: "above-auto-pay-threshold",
	ALREADY_PAID: "already-paid",
	WALLET_BUSY: "wallet-busy",
	INAUTHENTIC_QUOTE: "inauthentic-quote",
	SENDER_UNVERIFIABLE: "sender-unverifiable",
} as const;

/**
 * Decrypt the quote message body into its verbatim `PaymentRequired` object.
 *
 * `payeeAgentId` is the quote's server-authenticated sender, which the
 * envelope's signing key is checked against.
 */
export async function readQuote(
	ctx: ToolContext,
	agentId: string,
	original: MessageRead,
	payeeAgentId: string,
): Promise<PaymentRequired> {
	if (!agentKeysExist(ctx.configDir, agentId)) {
		throw new Error(
			`No local keys for agent ${agentId} — cannot decrypt the quote.`,
		);
	}
	const decrypted = await decryptMessage(
		ctx.configDir,
		agentId,
		original.encrypted_payload,
		ctx.client,
		payeeAgentId,
		undefined,
		original.created_at,
	);
	// A quote is only the payee's word when the payee signed it: an envelope
	// re-sealed by a third party is refused here, before the wallet is asked to
	// sign an authorization against its terms.
	return parseX402Payload(
		original.type,
		requireVerifiedPlaintext(decrypted, payeeAgentId, original.id),
	) as PaymentRequired;
}

/**
 * The status and reason for a quote whose sender the gate refused, or `undefined`
 * for any other failure. Not a parse failure: the quote is attributed to an agent
 * that did not sign it (`inauthentic-quote`), or its signer could not be checked
 * (`sender-unverifiable`, retryable) — nothing here this wallet may pay.
 */
export function quoteRefusal(err: unknown):
	| {
			status:
				| typeof PAY_STATUS.INAUTHENTIC_QUOTE
				| typeof PAY_STATUS.SENDER_UNVERIFIABLE;
			reason: string;
			detail: string;
	  }
	| undefined {
	if (!(err instanceof X402Error)) return undefined;
	const detail = err.message;
	if (err.code === X402_ERROR.INAUTHENTIC_SENDER)
		return { status: PAY_STATUS.INAUTHENTIC_QUOTE, reason: err.code, detail };
	if (err.code === X402_ERROR.SENDER_UNVERIFIABLE)
		return { status: PAY_STATUS.SENDER_UNVERIFIABLE, reason: err.code, detail };
	return undefined;
}
