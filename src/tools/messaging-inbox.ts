/**
 * `rine_inbox` and `rine_read` — the two verbs that open received mail.
 *
 * Both decrypt through `messaging-decrypt.ts`; the inbox listing additionally
 * decides which rows it marks delivered.
 */

import type { MessageRead, PaginatedResponse } from "@rine-network/core";
import {
	ACTING_AGENT_HEADER,
	SENDER_KEY_NOT_RECOVERED_PREVIEW,
	senderKeyExplainer,
} from "@rine-network/core";
import { openInboxRow, openMessage } from "./messaging-decrypt.js";
import {
	type OpenedRow,
	rowAuthenticityFailure,
	rowNeverCiphertext,
	rowOpened,
} from "./messaging-row.js";
import {
	ACTING_AGENT_PARAM,
	actingAgent,
	withActorNote,
} from "./tool-actors.js";
import type { ToolDef } from "./types.js";

const rineInbox: ToolDef = {
	name: "rine_inbox",
	description:
		"List inbox messages, automatically decrypted and signature-verified. " +
		"An opened message includes `decrypted` (plaintext payload) and `verified` (signature check). " +
		"A message that stays sealed carries neither; one sealed under a sender key this agent " +
		"does not hold carries `decrypt_error` saying so, and `rine_read` on it goes looking for the key. " +
		"Defaults to new (undelivered) messages only.",
	inputSchema: {
		type: "object",
		properties: {
			agent: ACTING_AGENT_PARAM,
			status: {
				type: "string",
				description:
					"Filter by status: new, delivered, read, or all (default: new). " +
					"On `new` the messages this call opens are marked delivered, so a later " +
					"check returns only newer mail. `delivered`, `read` and `all` re-read mail " +
					"and mark nothing.",
				default: "new",
			},
			limit: {
				type: "number",
				description: "Max messages to return (default 10)",
			},
			cursor: {
				type: "string",
				description: "Pagination cursor from previous response",
			},
		},
	},
	async handler(ctx, p) {
		const acting = await actingAgent(ctx, p);
		const agentId = acting.agentId;

		const statusParam = (p.status as string) || "new";
		const params: Record<string, string | number | boolean> = {};
		if (statusParam !== "all") params.status = statusParam;
		if (p.limit) params.limit = Number(p.limit);
		if (p.cursor) params.cursor = String(p.cursor);

		const data = await ctx.client.get(`/agents/${agentId}/messages`, params, {
			[ACTING_AGENT_HEADER]: agentId,
		});
		const response = data as PaginatedResponse<MessageRead>;

		// One explainer for the whole page: the first unopenable row that is
		// sealed under a sender key this agent lacks says why in full, every
		// later one on this same page just marks it. An inbox page never
		// affords the recovery, so what it says in full is the un-earned sentence
		// — and the marker it repeats has to be that sentence's, not the earned
		// verdict's, or the page's first row and its rest disagree.
		const explain = senderKeyExplainer(SENDER_KEY_NOT_RECOVERED_PREVIEW);
		const items: OpenedRow[] = [];
		for (const msg of response.items) {
			items.push(await openInboxRow(ctx, agentId, msg, explain));
		}

		// Auto-mark as delivered only the rows this page could actually account
		// for. The mark is what takes a row out of `?status=new`, `/poll` and SSE
		// catch-up, and there is no un-mark route — so acking a row that came back
		// sealed spends the only remaining chance to open it, and an unattended
		// poller is never offered it again. Acking the whole page, readable or
		// not, would let one ordinary browse destroy retry eligibility for a
		// message whose key material has not arrived yet. A row that did not open
		// therefore stays `new` and is listed again.
		//
		// 🔴 The two PERMANENT classes are deliberate exceptions, and both are
		// marked even though they did not open. Neither can ever
		// change verdict, so leaving one `new` pins it at the head of every future
		// listing forever — the log/IO backlog a drain policy exists to prevent —
		// and it grows by one per such message with no verb here that can clear
		// it. An authenticity refusal is bytes a signature will never come to
		// cover; a never-ciphertext row (`rowNeverCiphertext`, core's
		// `not-ciphertext` verdict) was not an envelope this build opens in the
		// first place, the live instance being the `encryption_version: "none"`
		// row A2A cleartext writes. Only the MAY-HEAL rows change behaviour: a key
		// that has not arrived yet, a config dir with no key material, an
		// unclassified throw.
		//
		// The predicate is positive (`rowOpened`) rather than `!decrypt_error`,
		// because `openInboxRow` returns a row with NEITHER field in three classes
		// that never opened — see `rowOpened`'s own note. Asking the two permanent
		// questions explicitly is what keeps the remaining class from being
		// decided by falling off the end of that list.
		//
		// 🔴 `new` ONLY, never `all`. On the `new` status this call IS the read — it
		// hands the model decrypted bodies and the mark is what stops them arriving
		// again. `all` is a browse over history, and marking there would consume
		// the unread mail sitting inside that history as a side effect: ask to see
		// everything, silently spend every row you had not read yet. `rine-mastra`
		// and `rine-eve` both return before marking on any non-`new` status and
		// both say so in their tool descriptions, and this surface matches them.
		if (statusParam === "new") {
			const ids = items
				.filter(
					(m) =>
						rowOpened(m) || rowAuthenticityFailure(m) || rowNeverCiphertext(m),
				)
				.map((m) => m.id);
			if (ids.length > 0) {
				try {
					await ctx.client.markDelivered(agentId, ids, {
						[ACTING_AGENT_HEADER]: agentId,
					});
				} catch (e) {
					console.warn("Failed to mark messages as delivered:", e);
				}
			}
		}

		return withActorNote({ ...response, items }, acting);
	},
};

const rineRead: ToolDef = {
	name: "rine_read",
	description:
		"Read and decrypt a single message by ID. " +
		"Returns full message with `decrypted` payload and `verified` signature status.",
	inputSchema: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description: "Message UUID to read",
			},
			agent: ACTING_AGENT_PARAM,
		},
		required: ["message_id"],
	},
	async handler(ctx, p) {
		const acting = await actingAgent(ctx, p);
		const agentId = acting.agentId;

		// Say which agent is reading: the server marks the acting agent's own
		// delivery row and no sibling's, so a bare GET reads the message and
		// leaves it unread for everyone.
		const msg = (await ctx.client.get(
			`/messages/${String(p.message_id)}`,
			{},
			{ [ACTING_AGENT_HEADER]: agentId },
		)) as MessageRead;

		return withActorNote(await openMessage(ctx, agentId, msg), acting);
	},
};

export const inboxTools: ToolDef[] = [rineInbox, rineRead];
