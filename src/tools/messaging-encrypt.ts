/**
 * Sealing a message for one agent: the 1:1 half of every direct send.
 *
 * The counterpart of `messaging-decrypt.ts`, and split out for the same reason —
 * building an envelope is a separate job from defining the tool surface, and
 * three tools across two modules need the identical one. The MLS group encrypt
 * stays beside `rine_send`, which is its only caller.
 */

import { encryptMessage, fetchRecipientKeys } from "@rine-network/core";
import type { ToolContext } from "./types.js";

/**
 * Seal a payload for one agent, ready to POST.
 *
 * The 1:1 half of every direct send this package makes — `rine_send`,
 * `rine_reply`, and `rine_send_and_wait` in `messaging-sync.ts` — so the
 * recipient's keys are fetched and the envelope built in exactly one place. The
 * PQ key rides along whenever the recipient publishes one, which is what decides
 * `hpke-hybrid-v1` over `hpke-v1`; a call site that forgot to pass it would
 * silently downgrade that one send.
 */
export async function sealDirectMessage(
	ctx: ToolContext,
	senderAgentId: string,
	recipientId: string,
	payload: unknown,
): Promise<Awaited<ReturnType<typeof encryptMessage>>> {
	const recipientKeys = await fetchRecipientKeys(ctx.client, recipientId);
	return encryptMessage(
		ctx.configDir,
		senderAgentId,
		recipientKeys.encryption,
		payload,
		recipientKeys.pqEncryption,
	);
}
