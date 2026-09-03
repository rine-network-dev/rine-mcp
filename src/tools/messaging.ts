import type {
	GroupRead,
	MessageRead,
	PaginatedResponse,
	RecipientTarget,
} from "@rine-network/core";
import {
	ACTING_AGENT_HEADER,
	GROUP_HANDLE_PARTS,
	MlsInitInFlightError,
	SENDER_KEY_NOT_RECOVERED_PREVIEW,
	assertNoMlsDowngrade,
	encryptGroupMessage,
	encryptMlsGroupMessage,
	getOrCreateSenderKey,
	groupAcceptsMlsSendOnly,
	isNoMlsStateError,
	normalizeHandle,
	processMlsWelcomes,
	resolveRecipient,
	senderKeyExplainer,
	syncMlsGroup,
} from "@rine-network/core";
import {
	ACTING_AGENT_PARAM,
	SEND_ACTOR_KEYS,
	actingAgent,
	actingHeaders,
	withActorNote,
} from "./group-actors.js";
import { openInboxRow, openMessage } from "./messaging-decrypt.js";
import { sealDirectMessage } from "./messaging-encrypt.js";
import { withGroupRecipientNote } from "./messaging-recipient-note.js";
import type { OpenedRow } from "./messaging-row.js";
import type { ToolContext, ToolDef } from "./types.js";

/**
 * The group row a group recipient resolved to.
 *
 * `RecipientTarget.row` is optional because ONE record describes both
 * namespaces — an agent answer has no row — and the record's fields are pinned
 * field-for-field against the Python twin (`RECIPIENT_RECORDS`,
 * `tests/test_client-server-contract_group0.py`), so the guarantee
 * `resolveRecipient` actually holds — a group answer always carries the row the
 * ladder read — cannot be written as a discriminated union without moving that
 * record on both stacks. Read through this rather than asserted with `!`: a
 * rung that ever stopped supplying the row would otherwise reach the crypto
 * layer as `undefined` and seal a message for nothing.
 */
function groupRowOf(target: RecipientTarget): GroupRead {
	if (target.row) return target.row;
	throw new Error(
		`Group recipient '${target.spelling}' resolved without its group row — the recipient ladder must answer a group with the row it read.`,
	);
}

/**
 * MLS group send with one-shot recovery: if local MLS state is missing, install
 * pending welcomes + sync, then retry the encrypt once before surfacing.
 */
async function encryptMlsWithRecovery(
	ctx: ToolContext,
	senderAgentId: string,
	groupId: string,
	payload: unknown,
): Promise<ReturnType<typeof encryptMlsGroupMessage>> {
	const hdrs = { [ACTING_AGENT_HEADER]: senderAgentId };
	// Pre-sync: advance local epoch so we encrypt at the group's current state.
	await processMlsWelcomes(ctx.configDir, senderAgentId, ctx.client).catch(
		() => {},
	);
	await syncMlsGroup(
		ctx.configDir,
		senderAgentId,
		groupId,
		ctx.client,
		hdrs,
	).catch(() => {});

	try {
		return await encryptMlsGroupMessage(
			ctx.configDir,
			senderAgentId,
			groupId,
			payload,
		);
	} catch (err) {
		// The predicate rine-core owns, not a copy of its message text.
		if (isNoMlsStateError(err)) {
			// Scoped, because unlike the pre-sync above this call is UNCAUGHT: left
			// unscoped it raises whichever refusal arrived first in the pass, so a
			// substituted Welcome for some other group would abort this send with
			// that group's text. `forGroup` narrows only which refusal is the answer
			// to THIS caller's question — every Welcome in the batch still installs.
			// The Python twin reaches the same scoping via `install_mls_state`.
			await processMlsWelcomes(ctx.configDir, senderAgentId, ctx.client, {
				forGroup: groupId,
			});
			await syncMlsGroup(
				ctx.configDir,
				senderAgentId,
				groupId,
				ctx.client,
				hdrs,
			);
			return await encryptMlsGroupMessage(
				ctx.configDir,
				senderAgentId,
				groupId,
				payload,
			);
		}
		throw err;
	}
}

const rineSend: ToolDef = {
	name: "rine_send",
	description:
		"Send an E2E-encrypted message to an agent or group. " +
		"Payload is encrypted client-side before transmission (HPKE for 1:1, Sender Keys for groups). " +
		"The server never sees plaintext.",
	inputSchema: {
		type: "object",
		properties: {
			to: {
				type: "string",
				description:
					"Recipient: an agent handle, an agent UUID, or a group. " +
					"Examples: `kofi@acme.rine.network` for one agent, " +
					"`#logistics@acme.rine.network` for a group. " +
					"A group also answers to `#logistics` without the org half, and to its plain name `logistics`; both are resolved against the groups you are in. An agent is reached only by its full handle or its UUID, so a plain name that is also one of your org's agent names is refused rather than guessed.",
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
			idempotency_key: {
				type: "string",
				description: "Unique key to prevent duplicate sends on retry",
			},
		},
		required: ["to", "payload"],
	},
	async handler(ctx, p) {
		const acting = await actingAgent(ctx, p, SEND_ACTOR_KEYS);
		const agentId = acting.agentId;
		const extraHeaders: Record<string, string> = {
			[ACTING_AGENT_HEADER]: agentId,
		};

		// 🔴 The ladder decides which namespace the recipient names — this handler
		// no longer does. What stood here was this surface's own copy of the
		// classification table (`startsWith("#")`), and the arm it fell through
		// to accepts a UUID or an `@` and refuses everything else on syntax: a
		// bare `ops` was a certain refusal one line later, so routing it to the
		// group ladder can only replace that refusal with a send or a better
		// refusal (`resolveBareRecipientGroup` carries the whole argument, the
		// collision guard included). `rine-cli`'s send is the deliberate
		// exception, and is not this file's to change.
		//
		// `normalizeHandle` stays, and stays FIRST: it completes a short org half
		// (`#dev@acmecorp` → `#dev@acmecorp.rine.network`) before anything
		// classifies or looks the reference up, which is the order the Python
		// twin's `send` runs too.
		//
		// `agents` is the page the actor ladder just read, handed over rather than
		// bought again: `fetchAgents` is uncached by design and the bare-name
		// collision guard asks for the very same org-scoped list, so a bare `ops`
		// used to cost `GET /agents` twice per send. Unset on the rung that read
		// no list — an actor spelled as a UUID — and the guard then fetches for
		// itself, which is the shape it had before.
		const target = await resolveRecipient(
			ctx.client,
			ctx.apiUrl,
			normalizeHandle(String(p.to)),
			{ extraHeaders, agents: acting.agents },
		);

		// One header object for the post, built once for both branches: the
		// acting agent is the same either way, and the idempotency key is the
		// caller's regardless of which namespace answered.
		const headers: Record<string, string> = { ...extraHeaders };
		if (p.idempotency_key) {
			headers["Idempotency-Key"] = String(p.idempotency_key);
		}

		if (target.kind === "group") {
			// The row the ladder already read: the server's account of the group's
			// encryption is the only one a client gets, and both the guard and the
			// branch below read it. A non-null mls_group_id is an opaque
			// "MLS-active" latch — never use its value as a state key; the rine
			// group UUID (group.id) is the only one.
			const group = groupRowOf(target);
			// Everything downstream addresses the group the SERVER holds, never
			// the spelling the caller composed — the resolver's fallback exists
			// precisely because those two can differ, and the caller's spelling
			// would 404 the sender-key resolve and misroute the post.
			const groupHandle = group.handle;
			// The SEND question, not the render question; `groupAcceptsMlsSendOnly`
			// documents why `mls_group_id` alone walks into a server 409 during the
			// init window.
			const mlsOnly = groupAcceptsMlsSendOnly(group);

			// The guard goes HERE, between the resolve and the branch, because
			// reaching the sender-key branch has already leaked the key
			// (`assertNoMlsDowngrade`). No fallback, no sender-key retry.
			assertNoMlsDowngrade(ctx.configDir, agentId, group.id, mlsOnly);

			let result: Awaited<ReturnType<typeof encryptGroupMessage>>["result"];
			if (mlsOnly) {
				if (group.mls_group_id == null)
					throw new MlsInitInFlightError(groupHandle);
				result = await encryptMlsWithRecovery(
					ctx,
					agentId,
					group.id,
					p.payload,
				);
			} else {
				const { state, groupId } = await getOrCreateSenderKey(
					ctx.client,
					ctx.configDir,
					agentId,
					groupHandle,
					extraHeaders,
				);
				({ result } = await encryptGroupMessage(
					ctx.configDir,
					agentId,
					groupId,
					state,
					p.payload,
				));
			}

			// Two notices, one result: the actor's `warning` and — when the
			// recipient slot held a group ID the caller sent as if it were an
			// agent's — this branch's own. The ladder's answer is what says so, so
			// the record it returned is passed on rather than re-classified here.
			return withActorNote(
				withGroupRecipientNote(
					await ctx.client.post(
						"/messages",
						{
							to_handle: groupHandle,
							type: p.type ?? "rine.v1.dm",
							...result,
						},
						headers,
					),
					target,
				),
				acting,
			);
		}

		const recipientId = target.id;
		const result = await sealDirectMessage(
			ctx,
			agentId,
			recipientId,
			p.payload,
		);

		return withActorNote(
			await ctx.client.post(
				"/messages",
				{
					to_agent_id: recipientId,
					type: p.type ?? "rine.v1.dm",
					...result,
				},
				headers,
			),
			acting,
		);
	},
};

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
					"Filter by status: new, delivered, read, or all (default: new)",
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

		// Auto-mark new messages as delivered
		if ((statusParam === "new" || statusParam === "all") && items.length > 0) {
			const ids = items.map((m) => m.id);
			try {
				await ctx.client.markDelivered(agentId, ids, {
					[ACTING_AGENT_HEADER]: agentId,
				});
			} catch (e) {
				console.warn("Failed to mark messages as delivered:", e);
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

/**
 * Machine control envelopes. Their payload is parsed as JSON by the recipient's own
 * ingest path, and a reply mirrors the original's type, so a prose reply to one goes on
 * the wire wearing a control frame's label and is discarded at the far end. Threading
 * into one has no meaning on any surface — a sender key is taken by the crypto layer, an
 * invitation is accepted with the group tools — so the refusal belongs here, beside the
 * self-reply guard, rather than being restated in each host's wake filter. Measured
 * live: an agent woken by a key distribution answered it in prose, and the answer was
 * stored as a `rine.v1.sender_key_distribution`.
 */
const CONTROL_FRAME_TYPES = new Set([
	"rine.v1.sender_key_distribution",
	"rine.v1.group_invite",
]);

/**
 * What `rine_reply` says to a group post, and where the handle comes from.
 *
 * 🔴 **Rung 1 of the refusal ladder, and this is the one site that can reach
 * it.** The sentence used to print `#logistics@acme.rine.network` labelled
 * *"for example"* — the shape a model pastes verbatim, domain and all. Here the
 * refusal is composed with the message in hand, so it names the group the
 * caller actually tried to reply to.
 *
 * The handle is read off `MessageRead.group_handle`, which
 * `GET /messages/{id}` populates from the group row in the same response
 * (`src/rine/api/messages.py`, the `group_handle` block of `get_message`) —
 * the same field, and the same argument: the server is authoritative,
 * so this is an echo rather than a second resolution, and it costs no request.
 * Paying `GET /groups/{id}` for it instead would add a round trip, a failure
 * mode and a second answer that can disagree with this one, all to print a
 * string the response already carried.
 *
 * The fallback arm is rung 2 — a structural description, nothing pasteable and
 * no `@org` slot (`check-model-facing-examples.mjs`'s `template-org` rule) —
 * for the row whose group has no handle to echo. The description itself is
 * {@link GROUP_HANDLE_PARTS}, `rine-core`'s shared clause, composed rather than
 * retyped: three surfaces had written the same ratified words out by hand and
 * nothing bound them. Both arms keep the advice, which is what separates this
 * from a removal.
 */
function replyToGroupRefusal(groupHandle: string | undefined): string {
	const lead =
		"Cannot reply to a group post — it has no single recipient. Answer the group by sending to ";
	return groupHandle
		? `${lead}${groupHandle}.`
		: `${lead}its own handle: ${GROUP_HANDLE_PARTS}.`;
}

const rineReply: ToolDef = {
	name: "rine_reply",
	description:
		"Reply to a message within its conversation. " +
		"Auto-routes to the original sender with E2E encryption. " +
		"Preserves conversation_id for threading. " +
		"1:1 only — a group post has no single recipient, so answer a group by " +
		"sending to its own handle instead, for example " +
		"`#logistics@acme.rine.network`.",
	inputSchema: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description: "UUID of the message to reply to",
			},
			payload: {
				type: "object",
				description: "Reply content (any JSON). Will be E2E encrypted",
			},
			type: {
				type: "string",
				description:
					"Override message type (defaults to original message's type)",
			},
		},
		required: ["message_id", "payload"],
	},
	async handler(ctx, p) {
		const messageId = String(p.message_id);
		// This tool learns which agent it acts as FROM the message it is about to
		// fetch (`original.to_agent_id`), so the read cannot name the actor the
		// way `rine_read` does — hence the lazy rung (`actingHeaders`, see its
		// JSDoc in `group-actors.ts`).
		const original = (await ctx.client.get(
			`/messages/${messageId}`,
			{},
			await actingHeaders(ctx, p),
		)) as MessageRead;

		if (CONTROL_FRAME_TYPES.has(original.type)) {
			throw new Error(
				`Cannot reply to a ${original.type} control frame — it is machine-parsed, not part of a conversation.`,
			);
		}

		const agentId = original.to_agent_id;
		if (!agentId) {
			// A group post carries no `to_agent_id`, so there is no other party to route
			// to and no reply is possible. Say which case this is: the bare recipient
			// error sent operators looking for a broken message instead of a group.
			if (original.group_id) {
				throw new Error(replyToGroupRefusal(original.group_handle));
			}
			throw new Error("Cannot determine recipient from message");
		}

		if (original.from_agent_id === agentId) {
			throw new Error(
				"Cannot reply to your own message. Send a new message to follow up in this conversation.",
			);
		}

		const recipientId = original.from_agent_id;
		if (!recipientId) {
			throw new Error(
				"Original message has no sender — cannot determine reply recipient.",
			);
		}

		const result = await sealDirectMessage(
			ctx,
			agentId,
			recipientId,
			p.payload,
		);

		return ctx.client.post(
			`/messages/${messageId}/reply`,
			{
				type: p.type ?? original.type,
				...result,
			},
			{ [ACTING_AGENT_HEADER]: agentId },
		);
	},
};

export const messagingTools: ToolDef[] = [
	rineSend,
	rineInbox,
	rineRead,
	rineReply,
];
