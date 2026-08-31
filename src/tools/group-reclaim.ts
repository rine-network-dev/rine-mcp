import {
	ACTING_AGENT_HEADER,
	describeMlsReclamation,
	groupIsMls,
	resumeMlsGroupAdmission,
} from "@rine-network/core";
import { actingAgent, withActorNote } from "./group-actors.js";
import { groupTarget } from "./group-ref.js";
import type { ToolContext } from "./types.js";

/**
 * An open group runs Sender Keys, so it has no tree to hold an orphaned leaf.
 *
 * Named after the group the caller asked about, on the
 * `notAnMlsGroupResume` precedent: echoing an identifier the operator never
 * typed is its own small lie about what was acted on.
 */
function notAnMlsGroupReclaim(groupRef: string): string {
	return (
		`Group ${groupRef} runs on sender keys, not MLS, so it has no ratchet tree` +
		" and no leaves to reclaim. Open-enrollment groups are sender-key groups by" +
		" design: MLS would hand an unattested joiner a cryptographic seat, so the" +
		" server keeps open enrollment off the MLS path. There is nothing to" +
		" reclaim here."
	);
}

/**
 * A group whose MLS state was never founded has no leaves at all.
 *
 * Distinct from the sender-key refusal above and from a failure: this group will
 * have a ratchet tree, and the verb that builds it is an invitation, which
 * founds and seats in the same call.
 */
function notFoundedYet(groupRef: string): string {
	return (
		`Group ${groupRef} has no ratchet tree yet — its MLS state has never been` +
		" founded, so there is no leaf for anyone to hold and nothing to reclaim." +
		" Inviting a member founds the tree."
	);
}

/**
 * Retire the ratchet-tree leaves this group's members and live invitations do
 * not account for, and say what that cost.
 *
 * Delegates to `rine-core`'s `resumeMlsGroupAdmission` with `reclaim: true`
 * (`mls-ops-admit.ts:resumeMlsGroupAdmission` → `mls-orphans.ts:reclaimOrphanLeaves`),
 * which is exactly what `rine group resume-admission --reclaim` runs. The
 * reclamation pass alone would be the smaller call and is the wrong one: it
 * declines with `identity_unseated` whenever a member holds no leaf, and this
 * surface has no resume verb to offer as the remedy — so a bare pass could
 * decline here permanently with nothing to do about it. Resuming seats first
 * and reclaims afterwards, so the two surfaces cannot drift apart.
 *
 * The entitled set the pass subtracts is read from the server by
 * `mls-admission-tree.ts:fetchGroupTree`, whose live-invitation half comes from
 * `GET /groups/{id}/requests?outstanding=live` and nowhere else. Computing it
 * from members alone classifies every agent invited and not yet accepted as an
 * orphan and evicts all of them.
 *
 * Reclamation is never automatic: the server holds no MLS keys, so nothing
 * retires a leaf until a member runs this. It takes membership and no role
 * beyond it — any member may run it — and what makes it a deliberate act rather
 * than a background chore is the cost, one O(N) Remove commit per leaf billed to
 * every member.
 *
 * It declares no removal target, and that is by construction rather than by
 * omission: an orphaned leaf holds no member row and no live voucher, so no
 * server route can name it and there is no `DELETE` for a declaration to
 * authorise.
 */
export async function reclaimGroupLeaves(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<unknown> {
	// `spelling` is what both refusals below name: it echoes the group the
	// caller asked about, and the id is no longer that once a caller may write
	// a handle. The `row` is the one `resolveGroup` already read, so the two
	// refusals below and the resolve cannot end up describing different groups.
	const {
		spelling: ref,
		id: groupId,
		row: group,
	} = await groupTarget(ctx, p);
	if (group.enrollment_policy === "open") {
		throw new Error(notAnMlsGroupReclaim(ref));
	}
	if (!groupIsMls(group)) throw new Error(notFoundedYet(ref));

	const acting = await actingAgent(ctx, p);
	const actingId = acting.agentId;
	const result = await resumeMlsGroupAdmission(
		ctx.configDir,
		actingId,
		groupId,
		ctx.client,
		{ [ACTING_AGENT_HEADER]: actingId },
		{ reclaim: true },
	);
	// The sentence is the reclamation's, because that is what the caller asked
	// for; what the resume seated on the way through rides in `added`, `outcomes`
	// and `commits`, which this surface returns verbatim rather than summarising.
	return withActorNote(
		{ ...result, message: describeMlsReclamation(result.reclamation) },
		acting,
	);
}
