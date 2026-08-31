import {
	ACTING_AGENT_HEADER,
	type GroupRead,
	externalJoinMlsGroup,
	isMlsWelcomeRefusedError,
	loadMlsState,
	processMlsWelcomes,
} from "@rine-network/core";
import { actingAgent, withActorNote } from "./group-actors.js";
import { joinGroupTarget } from "./group-ref.js";
import type { ToolContext } from "./types.js";

/**
 * For an MLS-active group the joiner just joined, if the Welcome path installed
 * no local MLS state — the open-enrollment case, where the server added them
 * with no member in the loop, so no Welcome was ever minted — self-join via an
 * RFC 9420 external commit so the joiner becomes a real MLS member and can
 * send and receive.
 *
 * No-op for sender-key groups and when a Welcome already established state.
 * Non-fatal, like every other MLS side-effect on this surface.
 */
async function externalJoinFallback(
	ctx: ToolContext,
	agentId: string,
	groupId: string,
): Promise<void> {
	try {
		const group = (await ctx.client.get(`/groups/${groupId}`)) as GroupRead;
		if (!group.mls_group_id) return;
		if (loadMlsState(ctx.configDir, agentId, groupId)) return;
		await externalJoinMlsGroup(ctx.configDir, agentId, groupId, ctx.client, {
			[ACTING_AGENT_HEADER]: agentId,
		});
	} catch (e) {
		console.warn(`MLS external self-join failed for group ${groupId}:`, e);
	}
}

/**
 * Join a group, then establish whatever local crypto state membership implies.
 *
 * An invitation that an admin has already admitted to MLS is waiting as a
 * Welcome, so processing welcomes is the normal path; the external commit is
 * the fallback for the group nobody could mint one for.
 *
 * 🔴 Every MLS step here is non-fatal except one: a Welcome the group
 * substitution guard REFUSED for **this** group. That is a security verdict
 * about who minted the Welcome, so the tool call fails with it rather than
 * returning a join result with a warning on stderr no model will ever read.
 * `rine.groups.join()` on the Python SDK raises the same refusal, and a
 * failure that is loud on one stack and a log line on the other is a defect a
 * user only meets on the quiet one. The rine membership stands either way —
 * the join POST has already returned 200.
 */
export async function joinGroup(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<unknown> {
	const acting = await actingAgent(ctx, p);
	const agentId = acting.agentId;
	const headers: Record<string, string> = { [ACTING_AGENT_HEADER]: agentId };
	// After the actor and with its header, because the join ladder's middle rung
	// reads THIS agent's invitations: `X-Rine-Agent` selects whose, which on that
	// ladder is more than attribution — it is the whole of what a bare name
	// resolves against (`rine-core/src/resolve-group-join.ts`).
	const { id: groupId } = await joinGroupTarget(ctx, p, headers);

	const body: Record<string, string> = {};
	if (p.message) body.message = String(p.message);
	const result = await ctx.client.post(
		`/groups/${groupId}/join`,
		body,
		headers,
	);

	// Best-effort: install any pending MLS Welcome an admin has already
	// delivered for this joiner. A no-op when the group is not MLS or no
	// Welcome is pending yet.
	//
	// 🔴 `forGroup` names the group this call is establishing, and it is what
	// keeps the choice of refusal off the server. Without it the pass raises
	// "the first refusal whose bytes arrived", in the order the server's own
	// welcomes response listed them — so one throwaway decoy for another group
	// made `welcomeRefusedForGroup` answer false and this join carried on into
	// the external-commit fallback for the group it had just refused to trust
	// (MEASURED).
	try {
		await processMlsWelcomes(ctx.configDir, agentId, ctx.client, {
			forGroup: groupId,
		});
	} catch (e) {
		// A refusal naming a DIFFERENT group still warns: the batch installs every
		// Welcome it can before raising, and that group's verdict is not this
		// join's to report.
		if (welcomeRefusedForGroup(e, groupId)) throw e;
		console.warn("MLS welcome processing failed after join:", e);
	}

	await externalJoinFallback(ctx, agentId, groupId);
	return withActorNote(result, acting);
}

/**
 * Whether a failure is the Welcome guard refusing a Welcome for this group.
 *
 * Classified by rine-core's exported code check, never by matching the message
 * — that export exists for this. The `groupId` a refusal carries is the rine
 * group UUID the delivery was filed under, compared case-insensitively because
 * the two ids arrive from different reads, as the Python twin compares them.
 */
function welcomeRefusedForGroup(err: unknown, groupId: string): boolean {
	if (!isMlsWelcomeRefusedError(err)) return false;
	const named = (err as { groupId?: unknown }).groupId;
	return (
		typeof named === "string" && named.toLowerCase() === groupId.toLowerCase()
	);
}
