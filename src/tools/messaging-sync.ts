/**
 * The send that waits for its own answer: `rine_send_and_wait`.
 *
 * Its own module rather than another entry in `messaging.ts`, which is already
 * past the file-size ceiling. The wait itself is not this file's work — it
 * happens SERVER-side, inside the one `POST /messages/sync` request, which
 * creates the message, delivers it and long-polls for the reply before
 * answering. There is no client-side poll loop here to share with anything, and
 * the encrypt half is `sealDirectMessage`, the same seal `rine_send` uses.
 *
 * What the verb does with the recipient REFERENCE — the shared ladder, and the
 * one arm where a 1:1 verb answers differently from `rine_send` — is
 * `messaging-sync-recipient.ts`, split out for the same size reason.
 */

import type { MessageRead } from "@rine-network/core";
import {
	ACTING_AGENT_HEADER,
	REF_CLASS,
	classifyReference,
	normalizeHandle,
} from "@rine-network/core";
import {
	ACTING_AGENT_PARAM,
	SEND_ACTOR_KEYS,
	actingAgent,
	withActorNote,
} from "./group-actors.js";
import { openMessage } from "./messaging-decrypt.js";
import { sealDirectMessage } from "./messaging-encrypt.js";
import type { OpenedRow } from "./messaging-row.js";
import {
	groupIsNotASyncRecipient,
	oneToOneRecipient,
} from "./messaging-sync-recipient.js";
import type { ToolDef } from "./types.js";

/** Seconds the server will hold the request open, and the bounds it accepts. */
const DEFAULT_WAIT_SECONDS = 30;
const MIN_WAIT_SECONDS = 1;
const MAX_WAIT_SECONDS = 300;

/** What `POST /messages/sync` answers: `reply` is null when the wait elapsed. */
interface SyncMessageResponse {
	message: MessageRead;
	reply: MessageRead | null;
	conversation_id: string;
	status: string;
}

/** The wait the caller asked for, in seconds, or a refusal naming the bounds. */
function waitSeconds(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_WAIT_SECONDS;
	const seconds = Number(value);
	if (
		!Number.isFinite(seconds) ||
		seconds < MIN_WAIT_SECONDS ||
		seconds > MAX_WAIT_SECONDS
	) {
		throw new Error(
			`wait_seconds must be a number between ${MIN_WAIT_SECONDS} and ${MAX_WAIT_SECONDS} (default ${DEFAULT_WAIT_SECONDS}).`,
		);
	}
	return seconds;
}

const rineSendAndWait: ToolDef = {
	name: "rine_send_and_wait",
	description:
		"Send a message and block until the recipient replies or the wait elapses. " +
		"1:1 only — a group is refused; use rine_send for groups. " +
		"Returns the reply, or a timeout result when none arrived.",
	inputSchema: {
		type: "object",
		properties: {
			to: {
				type: "string",
				description:
					"Recipient: an agent handle or an agent UUID — for example " +
					"`kofi@acme.rine.network`. A group is refused here however it is " +
					"written — `#logistics@acme.rine.network`, `#logistics`, or the " +
					"plain name of a group you are in — use rine_send for groups",
			},
			payload: {
				type: "object",
				description:
					"Message content (any JSON). Will be E2E encrypted before sending",
			},
			type: {
				type: "string",
				description:
					"Message type namespace (default: rine.v1.dm). " +
					"Common: rine.v1.task_request, rine.v1.task_response",
			},
			agent: ACTING_AGENT_PARAM,
			wait_seconds: {
				type: "number",
				description:
					"How long to wait for the reply, in seconds (1-300, default 30)",
			},
			idempotency_key: {
				type: "string",
				description: "Unique key to prevent duplicate sends on retry",
			},
		},
		required: ["to", "payload"],
	},
	async handler(ctx, p) {
		const to = normalizeHandle(String(p.to));
		// Before any round trip, including the agent lookup: the server refuses a
		// group handle here with a 422, and an agent that spent three calls to be
		// told so learns nothing the tool could not have said itself. The question
		// is asked of the contract's own table rather than of a `#` this file used
		// to test for itself — the surface classified, and now the table does.
		if (classifyReference(to) === REF_CLASS.group) {
			throw new Error(groupIsNotASyncRecipient(undefined));
		}
		const seconds = waitSeconds(p.wait_seconds);

		const acting = await actingAgent(ctx, p, SEND_ACTOR_KEYS);
		const agentId = acting.agentId;

		// The same ladder `rine_send` resolves through, so the two verbs cannot
		// disagree about what a spelling names — a bare `ops` is a group on both
		// or on neither. This one is 1:1, so a group is where it stops rather
		// than where it sends, and the one arm where a 1:1 verb needs its own
		// answer is argued at `oneToOneRecipient`.
		const target = await oneToOneRecipient(ctx, to, {
			extraHeaders: { [ACTING_AGENT_HEADER]: agentId },
			agents: acting.agents,
		});
		if (target.kind === "group") {
			throw new Error(groupIsNotASyncRecipient(target.handle));
		}

		const recipientId = target.id;
		const result = await sealDirectMessage(
			ctx,
			agentId,
			recipientId,
			p.payload,
		);

		const headers: Record<string, string> = {
			[ACTING_AGENT_HEADER]: agentId,
		};
		if (p.idempotency_key) {
			headers["Idempotency-Key"] = String(p.idempotency_key);
		}

		// `HttpClient.post` carries no query parameters, so the one this route
		// needs rides in the path — the client appends the path to the base URL
		// untouched, and this call passes no params of its own to collide with it.
		const response = (await ctx.client.post(
			`/messages/sync?timeout_ms=${seconds * 1000}`,
			{
				to_agent_id: recipientId,
				type: p.type ?? "rine.v1.dm",
				...result,
			},
			headers,
		)) as SyncMessageResponse;

		// The reply arrives sealed like any other row, so it is opened the same way
		// rine_read opens one — verdict included, and still sealed if it will not
		// open. A wait that elapsed carries no reply at all.
		const reply: OpenedRow | null = response.reply
			? await openMessage(ctx, agentId, response.reply)
			: null;
		return withActorNote({ ...response, reply }, acting);
	},
};

export const messagingSyncTools: ToolDef[] = [rineSendAndWait];
