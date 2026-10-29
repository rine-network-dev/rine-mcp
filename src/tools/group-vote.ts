import {
	ACTING_AGENT_HEADER,
	type JoinRequestRead,
	type ListResponse,
	type VoteResponse,
	addMlsGroupMember,
} from "@rine-network/core";
import { groupTarget } from "./group-ref.js";
import {
	actingAgent,
	agentHeaders,
	namedActingAgent,
	withActorNote,
} from "./tool-actors.js";
import type { ToolContext, ToolParams } from "./types.js";

/**
 * The applicant a pending request names, or undefined when it names none.
 *
 * 🔴 The read is guarded because it belongs to the best-effort seat, not to the
 * vote. Unguarded, a transient 5xx or a group rate limit on `GET /requests`
 * aborts the whole approve before it is cast, and the caller cannot tell that
 * from a refused vote — while the retry answers 409 either way.
 */
async function applicantOf(
	ctx: ToolContext,
	groupId: string,
	requestId: string,
	headers: Record<string, string>,
): Promise<string | undefined> {
	try {
		const reqs = (await ctx.client.get(
			`/groups/${groupId}/requests`,
			{ outstanding: "pending" },
			headers,
		)) as ListResponse<JoinRequestRead>;
		return reqs.items.find((r) => r.id === requestId)?.agent_id;
	} catch (e) {
		console.warn(
			`Could not read the applicant for request ${requestId} in group ${groupId} ` +
				`before voting; the vote is being cast anyway and nobody will be seated ` +
				`by it:`,
			e,
		);
		return undefined;
	}
}

/**
 * Give a newly approved applicant a ratchet-tree leaf, as the deciding voter.
 *
 * Voting is member-gated and so is the commit, so the agent that cast the
 * deciding vote is the one that can seat them. Best-effort by design: the rine
 * membership stands either way, and the resume verb seats whoever an add commit
 * could not reach.
 *
 * `addMlsGroupMember` installs the acting agent's own pending Welcome before it
 * opens the group (`rine-core/src/mls-ops-admit.ts:ensureAdmitterState`), which
 * is what makes this work for a voter who joined by Welcome and has not read the
 * group yet — the ordinary shape of a majority group. Do not open an MLS client
 * here instead; that is the path that seated members with no Welcome.
 */
async function seatApplicant(
	ctx: ToolContext,
	groupId: string,
	applicantId: string,
	p: ToolParams,
): Promise<boolean> {
	try {
		const { agentId: actingId } = await actingAgent(ctx, p);
		await addMlsGroupMember(
			ctx.configDir,
			actingId,
			groupId,
			applicantId,
			ctx.client,
			{ [ACTING_AGENT_HEADER]: actingId },
		);
		return true;
	} catch (e) {
		console.warn(`MLS add-member failed for group ${groupId}:`, e);
		return false;
	}
}

/**
 * Cast a vote on a join request, and seat the applicant if it admitted them.
 *
 * The applicant is captured **before** the vote is cast: once a vote crosses the
 * approval threshold the request leaves the pending list, and the vote response
 * does not carry the agent it admitted, so afterwards there is nothing left to
 * read the id off.
 *
 * A deny, and an approve that does not resolve the request, seat nobody — there
 * is no member to seat yet — and report `mls_seated: false`.
 *
 * 🔴 So does an approve that carries a request a member filed for an agent that
 * has not answered yet: the route resolves that one to `status: "invited"` —
 * a real voucher the agent redeems — and NOT to a membership. The seat is
 * gated on `approved` and nothing else for that reason — widening it to
 * "anything that is not denied" would Welcome an agent that never consented,
 * which is the hole the consent column exists to close. The wire status reaches
 * the caller unchanged, so the model reads which of the four answers it got.
 */
export async function voteOnRequest(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<unknown> {
	const { id: groupId } = await groupTarget(ctx, p);
	const requestId = String(p.request_id);
	const vote = String(p.vote);
	if (vote !== "approve" && vote !== "deny") {
		throw new Error("vote must be 'approve' or 'deny'.");
	}
	// The named actor, not just its header: a one-agent org that voted on a value
	// naming nobody acted anyway, and the result this tool builds is the
	// only place that call can be told so.
	const acting = await namedActingAgent(ctx, p);
	const headers = agentHeaders(acting?.agentId ?? null);

	const applicantId =
		vote === "approve"
			? await applicantOf(ctx, groupId, requestId, headers)
			: undefined;

	const data = (await ctx.client.post(
		`/groups/${groupId}/requests/${requestId}/vote`,
		{ vote },
		headers,
	)) as VoteResponse;

	const seated =
		data.status === "approved" && applicantId !== undefined
			? await seatApplicant(ctx, groupId, applicantId, p)
			: false;

	return withActorNote({ ...data, mls_seated: seated }, acting);
}
