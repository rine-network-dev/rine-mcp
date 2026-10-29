import { type GroupAdmissionReport, resolveToUuid } from "@rine-network/core";
import { groupTarget } from "./group-ref.js";
import {
	explainAdmission,
	explainMlsAdmission,
} from "./group-admission-explain.js";
import { admitAndNotify, invitedIds } from "./group-admission.js";
import { withHandleCompletionNote } from "./handle-completion.js";
import {
	agentHeaders,
	asAgentList,
	namedActingAgent,
	resolveAgentIds,
	withActorNote,
} from "./tool-actors.js";
import type { ToolContext } from "./types.js";

/**
 * One invitation or a batch of them, resolved to agent UUIDs in request order.
 *
 * `spellings` is what the caller actually typed, carried out beside the ids
 * rather than re-derived at the call site: re-reading `p.invitees` to answer
 * item 18 would re-run `asAgentList`'s validation and, worse, could disagree
 * with the list that was really resolved. One read, one answer.
 */
interface InviteTargets {
	plural: boolean;
	ids: string[];
	spellings: string[];
}

/**
 * What a call that names no invitee at all is told.
 *
 * `agent` named the invitee on this tool until the rename and now names the
 * acting agent, so a caller carrying the old shape hands a real, resolvable
 * agent id to the parameter that chooses who acts. "A required parameter is
 * missing" would leave that caller to work out which one moved; this says it.
 *
 * It names `invitees` too because this refusal answers a call that named
 * NEITHER field, and a caller sent away to `invitee` alone would build a batch
 * one call at a time.
 */
const INVITEE_REQUIRED =
	"invitee is required, or invitees for a batch. Note agent now names the " +
	"acting agent on this tool; the agent being invited goes in invitee.";

/**
 * Read which agents an invite names, and refuse a request that names both ways
 * or neither — the same rule the route enforces, in the same words.
 *
 * The refusals come before any resolution, of the invitee or of the actor, so
 * a call carrying the retired spelling never reaches an acting agent.
 */
async function inviteTargets(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<InviteTargets> {
	const plural = p.invitees !== undefined && p.invitees !== null;
	const singular = p.invitee !== undefined && p.invitee !== null;
	if (!plural && !singular) throw new Error(INVITEE_REQUIRED);
	if (plural && singular) {
		throw new Error(
			"Name exactly one of invitee (one invitation) or invitees (a batch).",
		);
	}
	if (plural) {
		const named = asAgentList(p.invitees, "invitees");
		return {
			plural,
			ids: await resolveAgentIds(ctx, named),
			spellings: named.map(String),
		};
	}
	const invitee = String(p.invitee);
	return {
		plural,
		ids: [await resolveToUuid(ctx.apiUrl, invitee)],
		spellings: [invitee],
	};
}

/**
 * Invite one agent, or many in one call.
 *
 * The two are one route and one authorization ladder; which field the request
 * uses chooses the answer. `invitee` answers a bare row. `invitees` answers a
 * per-member report: a batch drops the entries it cannot admit and says why for
 * each one, and never fails whole on account of a single bad id.
 *
 * On `majority` and `unanimity` the row is a **nomination**: a
 * pending join request the group's electorate decides, carrying the nominating
 * member's own approval, with an entry status of `nominated`. Nobody is seated
 * by it, so {@link admitAndNotify} posts no MLS commit there.
 */
export async function inviteToGroup(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<unknown> {
	const message = p.message ? String(p.message) : null;
	// Invitees first, and the ordering is the requirement, not a style: `agent`
	// used to name the invitee here, so a caller carrying the old shape passes an
	// agent id the actor rung would happily resolve. Reading the invitee before
	// anything selects an acting agent is what turns that call into a refusal
	// instead of an invitation nobody asked for, sent as somebody nobody named.
	const { plural, ids, spellings } = await inviteTargets(ctx, p);
	// No headers: this handler resolves its actor LAZILY on purpose (the comment
	// above), and `GET /groups` is scoped to the key, so climbing that ladder early to
	// attach attribution would change which call gets refused and why.
	const { id: groupId, row: group } = await groupTarget(ctx, p);
	const acting = await namedActingAgent(ctx, p);
	const inviter = acting?.agentId ?? null;
	const headers = agentHeaders(inviter);

	const result = await ctx.client.post(
		`/groups/${groupId}/invite`,
		{
			...(plural ? { agent_ids: ids } : { agent_id: ids[0] }),
			...(message !== null ? { message } : {}),
		},
		headers,
	);

	// Only the agents the server actually reached are owed a notice — and a
	// Welcome where the row confers a seat; one it skipped as already a member,
	// revoked or unknown is owed neither. `invitedIds` counts nominees, so the
	// seat question is asked once, inside `admitAndNotify`.
	const admitted = plural ? invitedIds(result, ids) : ids;
	const mls = await admitAndNotify(
		ctx,
		group,
		admitted,
		plural,
		message,
		inviter,
	);
	const answer = plural
		? {
				...explainAdmission(result as GroupAdmissionReport),
				mls: mls ? explainMlsAdmission(mls) : undefined,
			}
		: result;
	return withHandleCompletionNote(withActorNote(answer, acting), spellings);
}
