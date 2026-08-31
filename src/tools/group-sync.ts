import {
	ACTING_AGENT_HEADER,
	describeMlsRecovery,
	isMlsResyncUnavailable,
	recoverGroup,
} from "@rine-network/core";
import { actingAgent, withActorNote } from "./group-actors.js";
import { groupTarget } from "./group-ref.js";
import type { ToolContext } from "./types.js";

/**
 * Catch this agent's encryption state up with the group, and say what it cost.
 *
 * Two recoveries, because a rine group runs one of two encryptions. An MLS
 * group walks the epoch ladder: replaying stored commits posts nothing, and the
 * resync rung posts one external commit that is O(N) and billed to every member
 * of the group. A sender-key group has no epoch chain at all — what a member
 * can be missing there is other members' keys, waiting as distribution DMs in
 * its own inbox, so recovery installs them and posts nothing. Which one ran is
 * `regime`, and `describeMlsRecovery` says it in words.
 *
 * The group's ROW, never the bare id, is what reaches `recoverGroup`: the
 * server's answer is what says the group exists, that this agent is seated in
 * it, and which encryption it runs. It arrives from the resolve rather than
 * from a read of this handler's own, because `resolveGroup` has already paid
 * `GET /groups/{id}` for it — reading it again would be the same group
 * twice, one request apart, with two answers that can disagree about which
 * group the caller named.
 *
 * 🔴 A refusal this agent cannot recover from on its own is rethrown carrying
 * its own message. The CLI separates that case with an exit code; a tool call
 * has none, so the classification rides in the message or it is lost — and the
 * remedy is a member's re-invitation, not a retry.
 */
export async function syncGroupState(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<unknown> {
	const { spelling: ref, row: group } = await groupTarget(ctx, p);

	const acting = await actingAgent(ctx, p);
	const actingId = acting.agentId;
	try {
		const result = await recoverGroup(
			ctx.configDir,
			actingId,
			group,
			ctx.client,
			{ [ACTING_AGENT_HEADER]: actingId },
		);
		return withActorNote(
			// The caller's own spelling: `describeMlsRecovery` takes a `groupRef`
			// precisely so the sentence names the group the way it was asked for.
			{ ...result, message: describeMlsRecovery(ref, result) },
			acting,
		);
	} catch (err) {
		if (isMlsResyncUnavailable(err)) {
			throw new Error(err instanceof Error ? err.message : String(err));
		}
		throw err;
	}
}
