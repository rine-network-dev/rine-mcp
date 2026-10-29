import {
	ACTING_AGENT_HEADER,
	type GroupAdmissionReport,
	type GroupRead,
	type MlsAdmissionResult,
	addMlsGroupMember,
	admittedAgentIds,
	inviteNominates,
	resumeMlsGroupAdmission,
	sendGroupInviteNotification,
} from "@rine-network/core";
import { actingAgent } from "./tool-actors.js";
import type { ToolContext } from "./types.js";

/**
 * The ids a batch actually reached — the ones owed a notice.
 *
 * The arithmetic is `rine-core`'s `admittedAgentIds`, which counts
 * `not_applicable` as reached; leaving it out is why a plural invite into an
 * **open** group notified nobody. What this adds is wire tolerance: the report
 * arrives as `unknown` from the POST, and a response that carries no entries at
 * all — the singular row shape — means every id this call named.
 *
 * 🔴 It answers "who was reached and is owed a notice", NOT "who gets a leaf".
 * It also counts `nominated` entries — a nomination reserves a
 * seat under the group's ceiling exactly as an invitation does, and is decided
 * by a vote. {@link admitAndNotify} asks the group's policy before it hands
 * this set to any MLS verb.
 */
export function invitedIds(report: unknown, requested: string[]): string[] {
	const candidate = report as GroupAdmissionReport | undefined;
	if (!Array.isArray(candidate?.entries)) return requested;
	return admittedAgentIds(candidate);
}

/**
 * Give the group's invitees a leaf and a Welcome, as the inviting admin.
 *
 * The plural path runs the **resume** verb rather than an add over only the ids
 * this call named, because those are the same operation: resume is the add path
 * over a group's still-unseated invitees, and the agents just invited
 * are in that set. It reads the invited set from the server
 * (`?outstanding=live`), so it is also what finishes a founding that stopped
 * partway — which is how this surface finishes one without a tool of its own.
 * The consequence, stated in the tool's description because it is visible: a
 * batch invite can report more leaves than agents it named.
 *
 * The singular path keeps the single-add verb it has always used, so one
 * invitation costs one commit and nothing else changes for it.
 *
 * Reached only where the invite conferred a seat — see {@link admitAndNotify}.
 * A `majority` or `unanimity` group never gets here, so a founding on one of
 * those that stopped partway is finished by `rine_group_reclaim`, which seats
 * whoever is entitled to a leaf and has none, rather than as a side-effect of
 * the next batch invite.
 *
 * Best-effort, as every MLS side-effect on this surface is: the voucher is the
 * invitation, and a Welcome that was not minted is minted by inviting again.
 */
async function admitToMls(
	ctx: ToolContext,
	groupId: string,
	inviteeIds: string[],
	plural: boolean,
	inviterId: string,
): Promise<MlsAdmissionResult | undefined> {
	const headers: Record<string, string> = { [ACTING_AGENT_HEADER]: inviterId };
	try {
		if (plural) {
			return await resumeMlsGroupAdmission(
				ctx.configDir,
				inviterId,
				groupId,
				ctx.client,
				headers,
			);
		}
		const first = inviteeIds[0];
		if (first === undefined) return undefined;
		await addMlsGroupMember(
			ctx.configDir,
			inviterId,
			groupId,
			first,
			ctx.client,
			headers,
		);
		return undefined;
	} catch (e) {
		console.warn(`MLS add-member failed for group ${groupId}:`, e);
		return undefined;
	}
}

/**
 * Seal a `rine.v1.group_invite` notification to each reached agent so the row
 * lands in their normal inbox/poll/SSE path.
 *
 * The authoritative discovery path is `GET /groups/invites`, which answers live
 * nominations as well as invitations and tells them apart by `status` — this is
 * only a convenience nudge, so a failure (groups_only 403, missing keys) warns
 * for that agent and never costs another theirs, nor fails the call. The DM
 * carries `{group_id, group_handle, invited_by, message}` and no rendered
 * sentence, so nothing here claims a seat a nomination does not confer.
 */
async function notifyInvitees(
	ctx: ToolContext,
	group: GroupRead,
	inviterId: string,
	inviteeIds: string[],
	message: string | null,
): Promise<void> {
	for (const inviteeId of inviteeIds) {
		try {
			await sendGroupInviteNotification(
				ctx.client,
				ctx.configDir,
				inviterId,
				inviteeId,
				{ group_id: group.id, group_handle: group.handle, message },
			);
		} catch (e) {
			console.warn(`Invite notification failed for group ${group.id}:`, e);
		}
	}
}

/**
 * Everything the invite call triggers on the client: the MLS admission where
 * the row it wrote confers a seat, and the inbox nudge for every group.
 *
 * The group arrives as the ROW the caller's own resolve already read, never as
 * an id to be read back: `resolveGroup` paid `GET /groups/{id}` for it before
 * the invite was posted, and a second read here would be the same group
 * twice with two answers that can disagree about which one was invited into.
 * It is not stale across the invite either — `POST /groups/{id}/invite` writes
 * membership and voucher rows and touches neither `enrollment_policy` nor
 * `mls_group_id`, which are the only two fields read below.
 *
 * The inviting agent is the one the invite call itself acted as — resolved once
 * for the whole call — or this org's only agent when it named none. The whole
 * tail is best-effort: the row the server wrote stands either way, and neither
 * a Welcome nor a nudge is worth failing it over. Both halves keep their own
 * narrower handling, so this only catches what they cannot — the acting agent.
 *
 * 🔴 **A nomination gets the notice and no leaf.** On `majority` and
 * `unanimity` the invite filed a request the electorate has not decided, so
 * claiming the nominee's KeyPackage and Welcoming them here would put an agent
 * the vote may refuse inside the ratchet tree, holding an epoch secret, with
 * only the manual reclamation pass able to retire the leaf — and that pass
 * cannot reach it while the row is live. The vote seats the member, and seating
 * is what grants the key: `rine_group_vote` posts the add on the approve that
 * carries, which is what the self-application path has always done. The notice
 * still goes out, because a nominee that never learns of the nomination can
 * never consent to it.
 *
 * The GROUP's policy decides this and not the response, because it is the same
 * question the server asked when it chose what to write, and it answers the
 * singular and the plural call in one place.
 */
export async function admitAndNotify(
	ctx: ToolContext,
	group: GroupRead,
	inviteeIds: string[],
	plural: boolean,
	message: string | null,
	inviter: string | null,
): Promise<MlsAdmissionResult | undefined> {
	if (inviteeIds.length === 0) return undefined;
	try {
		const inviterId = inviter ?? (await actingAgent(ctx)).agentId;
		const seats = !inviteNominates(group.enrollment_policy);
		const mls =
			seats && group.mls_group_id
				? await admitToMls(ctx, group.id, inviteeIds, plural, inviterId)
				: undefined;
		await notifyInvitees(ctx, group, inviterId, inviteeIds, message);
		return mls;
	} catch (e) {
		console.warn(
			`MLS admission and invite notifications skipped for group ${group.id}:`,
			e,
		);
		return undefined;
	}
}
