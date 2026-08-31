/**
 * Which decrypt a message row takes, and what a caller is handed when it will
 * not open.
 *
 * Split out of `messaging.ts` because deciding an envelope's fate is a separate
 * job from defining the tool surface, and both `rine_inbox` and `rine_read`
 * need the same decision. The row's SHAPE is a third job and lives in
 * `messaging-row.ts`. They keep two different group decrypts on purpose: a
 * single-row read can afford the one-shot sync recovery, an inbox page cannot.
 *
 * On any refusal the row goes back still sealed — a model handed content whose
 * signature did not check out has no way to tell it should not act on it. One
 * cause is the exception: a group message sealed under a sender key this agent
 * does not hold has something for the reader to do about it, so it stays sealed
 * but now says why. Every other cause is unchanged — sealed, silent, no
 * verdict field.
 */

import type { MessageRead, SenderKeyExplainer } from "@rine-network/core";
import {
	SINGLE_MESSAGE_READ_REMEDY,
	agentKeysExist,
	asSenderKeyUnavailable,
	decryptGroupMessage,
	decryptGroupMessageWithRecovery,
	decryptMessage,
	ingestSenderKeyDistribution,
	senderKeyNotRecoveredMessage,
	unknownSenderKeyId,
} from "@rine-network/core";
import {
	type OpenedRow,
	decryptedRow,
	isDirectEnvelope,
	isGroupEnvelope,
} from "./messaging-row.js";
import type { ToolContext } from "./types.js";

/**
 * Open one inbox row, or hand it back sealed.
 *
 * `from_agent_id` is the sender the server authenticated; the envelope's own
 * claim of authorship is checked against it. A row listed without one is
 * returned still encrypted rather than opened on trust.
 *
 * `explain` is the ONE explainer for the whole `rine_inbox` page this row
 * belongs to — created once by the caller and threaded through every row, so
 * an unopenable page says the no-sender-key cause on its first such row and
 * marks the rest, instead of repeating a paragraph per row.
 */
export async function openInboxRow(
	ctx: ToolContext,
	agentId: string,
	msg: MessageRead,
	explain: SenderKeyExplainer,
): Promise<OpenedRow> {
	try {
		if (
			isDirectEnvelope(msg) &&
			agentKeysExist(ctx.configDir, agentId) &&
			msg.from_agent_id
		) {
			const result = await decryptMessage(
				ctx.configDir,
				agentId,
				msg.encrypted_payload,
				ctx.client,
				msg.from_agent_id,
			);
			ingestSenderKeyDistribution(ctx.configDir, agentId, msg.type, result);
			return decryptedRow(msg, result);
		}
		if (
			isGroupEnvelope(msg) &&
			agentKeysExist(ctx.configDir, agentId) &&
			msg.group_id &&
			msg.from_agent_id
		) {
			const result = await decryptGroupMessage(
				ctx.configDir,
				agentId,
				msg.group_id,
				msg.encrypted_payload,
				ctx.client,
				msg.from_agent_id,
			);
			return decryptedRow(msg, result);
		}
		return msg;
	} catch (err) {
		// `decryptGroupMessage` never affords the one-shot recovery `openMessage`
		// gets, so a missing key here has not had recovery's turn — the honest
		// sentence names the cause without claiming a fetch that did not happen,
		// and carries no `decrypt_error_code` (that field means the verdict
		// already ran and lost, and this one never ran). It is still the
		// no-sender-key cause, so it is still tiered: full sentence on this
		// page's first such row, bounded marker after. The remedy is the narrower
		// read this surface actually ships, not the `retrySenderKey` switch it
		// does not expose — and the caller's explainer marks the rows after with
		// that same sentence's marker, so the page does not answer one way on its
		// first row and the other way on the rest.
		const missingKeyId = unknownSenderKeyId(err);
		if (missingKeyId !== null) {
			return {
				...msg,
				decrypt_error: explain(
					senderKeyNotRecoveredMessage(missingKeyId, SINGLE_MESSAGE_READ_REMEDY),
				).line,
			};
		}
		return msg;
	}
}

/**
 * Open one message fetched by ID, or hand it back sealed.
 *
 * Unlike the inbox page this affords the one-shot sync recovery on the group
 * path: a single row is worth a round trip, a page of them is not. One row was
 * asked for, so a no-sender-key refusal renders in full — there is no second
 * row for it to repeat itself on (the SINGLE tier).
 */
export async function openMessage(
	ctx: ToolContext,
	agentId: string,
	msg: MessageRead,
): Promise<OpenedRow> {
	if (!agentKeysExist(ctx.configDir, agentId)) return msg;
	// Without the sender the server authenticated there is nothing to check the
	// envelope's claim of authorship against, so the message stays sealed.
	const fromAgentId = msg.from_agent_id;
	if (!fromAgentId) return msg;

	try {
		if (isDirectEnvelope(msg)) {
			const result = await decryptMessage(
				ctx.configDir,
				agentId,
				msg.encrypted_payload,
				ctx.client,
				fromAgentId,
			);
			return decryptedRow(msg, result);
		}
		if (isGroupEnvelope(msg) && msg.group_id) {
			const result = await decryptGroupMessageWithRecovery(
				ctx.client,
				ctx.configDir,
				agentId,
				msg.group_id,
				msg.encrypted_payload,
				fromAgentId,
			);
			return decryptedRow(msg, result);
		}
	} catch (err) {
		// The one-shot recovery above has already had its turn, so a recognised
		// cause here is a verdict, not a symptom: the sentence is earned and
		// carries the code that says so. Every other cause returns the row
		// sealed with no verdict field, exactly as before.
		const unavailable = asSenderKeyUnavailable(err, msg.group_id ?? undefined);
		if (unavailable) {
			return {
				...msg,
				decrypt_error: unavailable.message,
				decrypt_error_code: unavailable.code,
			};
		}
	}
	return msg;
}
