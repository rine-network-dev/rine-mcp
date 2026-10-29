/**
 * `rine_reply` — answer a 1:1 message within its conversation.
 *
 * The refusals a reply can meet (a control frame, a group post, the caller's
 * own message) live here with the verb that raises them.
 */

import type { MessageRead } from "@rine-network/core";
import {
	ACTING_AGENT_HEADER,
	GROUP_HANDLE_PARTS,
	controlFrameReplyRefusal,
	isControlFrameType,
	sealForAgent,
} from "@rine-network/core";
import { actingHeaders } from "./tool-actors.js";
import type { ToolDef } from "./types.js";

/**
 * What `rine_reply` says to a group post, and where the handle comes from.
 *
 * 🔴 **Rung 1 of the refusal ladder, and this is the one site that can reach
 * it.** A sentence printing `#logistics@acme.rine.network` labelled
 * *"for example"* is the shape a model pastes verbatim, domain and all. Here
 * the refusal is composed with the message in hand, so it names the group the
 * caller actually tried to reply to.
 *
 * The handle is read off `MessageRead.group_handle`, which
 * `GET /messages/{id}` populates from the group row in the same response
 * (`src/rine/api/messages_read.py`, the `group_handle` block of `get_message`) —
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
		// JSDoc in `tool-actors.ts`).
		const original = (await ctx.client.get(
			`/messages/${messageId}`,
			{},
			await actingHeaders(ctx, p),
		)) as MessageRead;

		// A control frame is machine-parsed, and threading into one has no meaning on
		// any surface: a sender key is taken by the crypto layer, an invitation is
		// accepted with the group tools. The refusal sits here, beside the self-reply
		// guard, rather than in each host's wake filter. Measured live: an agent woken by
		// a key distribution answered it in prose, and the answer was stored as a
		// `rine.v1.sender_key_distribution`.
		if (isControlFrameType(original.type)) {
			throw new Error(controlFrameReplyRefusal(original.type));
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

		const result = await sealForAgent(
			ctx.client,
			ctx.configDir,
			{ senderAgentId: agentId, recipientAgentId: recipientId },
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

export const replyTools: ToolDef[] = [rineReply];
