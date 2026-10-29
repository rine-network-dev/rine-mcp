/**
 * `rine_thread` — the both-sided transcript of whichever thing the caller named.
 *
 * Split out of `messaging.ts` (already well past the file budget) when the verb
 * grew its second reference. It is the one member of the group family that used
 * to refuse the group: every other group verb takes the group, and this one
 * demanded a *conversation* UUID — the id of a different entity, whose only
 * source was a column another tool printed. A model holding a group and reaching
 * for the transcript had nowhere to put it, so it put the group's name in the
 * conversation slot and got a framework 422 back with no sentence in it.
 *
 * Both references are decided by `rine-core`'s `resolveThreadRef`, offline,
 * before a request is spent, and the route is picked by `readThreadPage`. Both
 * live there rather than here because the CLI, the TypeScript SDK and this
 * server answer the same question, and a refusal restated per surface is a
 * refusal that drifts.
 */

import {
	ACTING_AGENT_HEADER,
	THREAD_REF_SURFACES,
	decryptThreadRows,
	readThreadPage,
	resolveThreadRef,
	threadRefRequiredRefusal,
} from "@rine-network/core";
import {
	ACTING_AGENT_PARAM,
	actingAgent,
	withActorNote,
} from "./tool-actors.js";
import type { ToolDef } from "./types.js";

/**
 * The exactly-one-of rule, in the words the refusal will use if it is broken.
 *
 * The same string teaches the schema and answers the mistake, so a caller can
 * never be told a rule the product does not enforce — the shipped precedent is
 * `rine_group_invite`'s *"Use invitee for one, or invitees for a batch — never
 * both."*, whose two properties this tool's two references mirror exactly.
 */
const THREAD_REF_RULE = threadRefRequiredRefusal(THREAD_REF_SURFACES.tool);

export const rineThread: ToolDef = {
	name: "rine_thread",
	description:
		"Fetch the both-sided, decrypted transcript of a conversation or a group. " +
		`${THREAD_REF_RULE} ` +
		"Returns every turn (yours and the peer's, or every member's) ordered " +
		"oldest→newest, each tagged `direction` (sent/received), with the decrypted " +
		"`text` and signature `verification_status`. " +
		"A turn the caller cannot decrypt, whose signature is invalid, or that is signed by " +
		'someone other than the sender the server authenticated renders `text: "[unavailable]"`. ' +
		"A group's transcript starts where the reading agent was seated: posts made " +
		"before it joined are not readable by it. " +
		"Use this to recover the full context of a conversation or a group on demand.",
	inputSchema: {
		type: "object",
		properties: {
			group: {
				type: "string",
				description:
					"The group whose transcript to read: its handle, its name, or its " +
					"UUID. Examples: `#logistics@acme.rine.network`, or just " +
					"`logistics`.",
			},
			conversation_id: {
				type: "string",
				description: "Conversation UUID to fetch the transcript of",
			},
			agent: ACTING_AGENT_PARAM,
			limit: {
				type: "number",
				description: "Max turns to return (most-recent window)",
			},
		},
		// Neither reference is required on its own — the rule is exactly one of
		// the two, which no JSON Schema `required` array can state and
		// `resolveThreadRef` states in one sentence.
		required: [],
	},
	async handler(ctx, p) {
		// Before the actor ladder, which can itself cost a round trip in a
		// multi-agent org: a call that named the wrong thing must spend nothing
		// finding out, and this decision needs neither the network nor an actor.
		const ref = resolveThreadRef(
			{
				...(p.group != null ? { group: String(p.group) } : {}),
				...(p.conversation_id != null
					? { conversationId: String(p.conversation_id) }
					: {}),
			},
			THREAD_REF_SURFACES.tool,
		);

		const acting = await actingAgent(ctx, p);
		const agentId = acting.agentId;

		const data = await readThreadPage(ctx.client, ref, {
			...(p.limit ? { limit: Number(p.limit) } : {}),
			extraHeaders: { [ACTING_AGENT_HEADER]: agentId },
		});

		// The plural helper IS the render boundary: it explains the no-sender-key
		// cause once for this whole transcript and marks the rest, instead of a
		// paragraph on every unopenable turn.
		const messages = await decryptThreadRows(
			ctx.configDir,
			agentId,
			data.messages ?? [],
			ctx.client,
		);

		return withActorNote(
			{ messages, truncated: data.truncated ?? false },
			acting,
		);
	},
};

/**
 * Registered from `index.ts` in its own slot rather than folded into
 * `messagingTools`: the module a tool is REGISTERED from is what
 * `scripts/lib/skill-tool-sources.mjs` reads to answer "does this host expose
 * `rine_thread`", and it follows `index.ts`'s imports only. A def re-exported
 * through a sibling is invisible to it — the tool would ship while every gated
 * surface that names it reads as naming a tool the host does not have.
 */
export const threadTools: ToolDef[] = [rineThread];
