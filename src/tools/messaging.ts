import type { GroupRead, RecipientTarget } from "@rine-network/core";
import {
	ACTING_AGENT_HEADER,
	MlsInitInFlightError,
	assertNoMlsDowngrade,
	encryptGroupMessage,
	getOrCreateSenderKey,
	groupAcceptsMlsSendOnly,
	normalizeHandle,
	resolveRecipient,
	sealAndPostMlsGroupMessage,
	sealForAgent,
} from "@rine-network/core";
import { withGroupRecipientNote } from "./messaging-recipient-note.js";
import {
	ACTING_AGENT_PARAM,
	SEND_ACTOR_KEYS,
	actingAgent,
	withActorNote,
} from "./tool-actors.js";
import type { ToolDef } from "./types.js";

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

const rineSend: ToolDef = {
	name: "rine_send",
	description:
		"Send an E2E-encrypted message to an agent or group. " +
		"Payload is encrypted client-side before transmission (post-quantum hybrid HPKE for 1:1, MLS or Sender Keys for groups). " +
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

		// 🔴 The ladder decides which namespace the recipient names, not this
		// handler: it keeps no copy of the classification table
		// (`startsWith("#")`). The agent arm accepts a UUID or an `@` and refuses
		// everything else on syntax, so a bare `ops` would be a certain refusal
		// there; routing it to the group ladder can only replace that refusal
		// with a send or a better refusal (`resolveBareRecipientGroup` carries the
		// whole argument, the collision guard included). `rine-cli`'s send is the
		// deliberate exception, and is not this file's to change.
		//
		// `normalizeHandle` stays, and stays FIRST: it completes a short org half
		// (`#dev@acmecorp` → `#dev@acmecorp.rine.network`) before anything
		// classifies or looks the reference up, which is the order the Python
		// twin's `send` runs too.
		//
		// `agents` is the page the actor ladder just read, handed over rather than
		// bought again: `fetchAgents` is uncached by design and the bare-name
		// collision guard asks for the very same key-scoped list, so handing it
		// over keeps a bare `ops` at one `GET /agents` per send. Unset on the rung
		// that read no list — an actor spelled as a UUID — and the guard then
		// fetches for itself.
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

			const post = (fields: object) =>
				ctx.client.post(
					"/messages",
					{
						to_handle: groupHandle,
						type: p.type ?? "rine.v1.dm",
						...fields,
					},
					headers,
				);

			let posted: unknown;
			if (mlsOnly) {
				if (group.mls_group_id == null)
					throw new MlsInitInFlightError(groupHandle);
				posted = await sealAndPostMlsGroupMessage(
					{ configDir: ctx.configDir, agentId, client: ctx.client },
					group.id,
					p.payload,
					post,
				);
			} else {
				const { state, groupId } = await getOrCreateSenderKey(
					ctx.client,
					ctx.configDir,
					agentId,
					groupHandle,
					extraHeaders,
				);
				const { result } = await encryptGroupMessage(
					ctx.configDir,
					agentId,
					groupId,
					state,
					p.payload,
				);
				posted = await post(result);
			}

			// Two notices, one result: the actor's `warning` and — when the
			// recipient slot held a group ID the caller sent as if it were an
			// agent's — this branch's own. The ladder's answer is what says so, so
			// the record it returned is passed on rather than re-classified here.
			return withActorNote(withGroupRecipientNote(posted, target), acting);
		}

		const recipientId = target.id;
		const result = await sealForAgent(
			ctx.client,
			ctx.configDir,
			{ senderAgentId: agentId, recipientAgentId: recipientId },
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

/** `rine_send` alone: each messaging module's list registers from `index.ts` (see `threadTools`). */
export const messagingTools: ToolDef[] = [rineSend];
