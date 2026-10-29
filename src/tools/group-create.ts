import {
	ACTING_AGENT_HEADER,
	type GroupAdmissionReport,
	type GroupRead,
	type MlsAdmissionResult,
	initMlsGroup,
} from "@rine-network/core";
import {
	explainAdmission,
	explainMlsAdmission,
} from "./group-admission-explain.js";
import { withHandleCompletionNote } from "./handle-completion.js";
import {
	actingAgent,
	resolveAgentIds,
	withActorNote,
} from "./tool-actors.js";
import type { ToolContext } from "./types.js";

/**
 * `POST /groups` answers `{group, roster}` when a roster was named and a bare
 * group when it was not — the second shape byte-identical to what it has always
 * been, which is why a create without a roster is unchanged here too.
 */
interface GroupCreated {
	group?: GroupRead;
	roster?: GroupAdmissionReport;
}

/**
 * Found the group's MLS state as its creator.
 *
 * `/mls/init` reports the group's invitees as well as its members, so a group
 * created with a roster founds with that roster already in the tree, in batches
 * — not one commit per member. Non-fatal on failure (a stuck `mls_pending`
 * self-clears server-side after 15 minutes) and resumable afterwards through a
 * plural `rine_group_invite`.
 *
 * Open-enrollment groups are exempt: the server refuses MLS there (403
 * `mls_open_enrollment_disabled`), so an attempt could only ever fail — they
 * run over Sender Keys, which is not a degraded outcome and so is not warned
 * about. Matches the CLI, the TS SDK and the Python SDK, which all skip rather
 * than attempt.
 */
async function foundMls(
	ctx: ToolContext,
	agentId: string,
	group: GroupRead,
): Promise<MlsAdmissionResult | undefined> {
	if (group.enrollment_policy === "open") return undefined;
	try {
		return await initMlsGroup(ctx.configDir, agentId, group.id, ctx.client, {
			[ACTING_AGENT_HEADER]: agentId,
		});
	} catch (e) {
		console.warn(
			`MLS group init failed for ${group.id} (group still created):`,
			e,
		);
		return undefined;
	}
}

/**
 * Create a group, optionally with a roster of agents to invite as it is made.
 *
 * A roster invites; it never seats. The creator is the group's only member
 * whether or not one was given, and each rostered agent becomes a member when
 * it joins.
 *
 * `visibility` carries no default here. It is required in this tool's input
 * schema, and an omitted one is refused by the server in rine's own words —
 * naming both choices and what each one does — rather than silently meaning
 * one thing on this surface and another on the next.
 */
export async function createGroup(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<unknown> {
	const acting = await actingAgent(ctx, p);
	const agentId = acting.agentId;
	const headers: Record<string, string> = { [ACTING_AGENT_HEADER]: agentId };
	// The spellings as the caller typed them, kept beside the ids they
	// resolved to. A founding roster is exactly where a silent completion seats
	// the wrong agent — and where it is least visible, one name among twenty.
	const memberSpellings = Array.isArray(p.members) ? p.members.map(String) : [];
	const roster = Array.isArray(p.members)
		? await resolveAgentIds(ctx, p.members)
		: [];

	const created = (await ctx.client.post(
		"/groups",
		{
			name: String(p.name),
			...(p.enrollment ? { enrollment_policy: String(p.enrollment) } : {}),
			...(p.visibility !== undefined
				? { visibility: String(p.visibility) }
				: {}),
			...(p.description !== undefined
				? { description: String(p.description) }
				: {}),
			...(p.vote_duration_hours !== undefined
				? { vote_duration_hours: Number(p.vote_duration_hours) }
				: {}),
			...(roster.length > 0 ? { members: roster } : {}),
		},
		headers,
	)) as GroupRead & GroupCreated;

	const group = (created.group ?? created) as GroupRead;
	const mls = await foundMls(ctx, agentId, group);
	if (roster.length === 0) return withActorNote(group, acting);
	// A roster says an invitation was minted; the MLS admission says whether a
	// ratchet-tree leaf was. Both are reported, each with its skips in a
	// sentence, because a founding that seats 37 of 40 must not read as 40.
	return withHandleCompletionNote(
		withActorNote(
			{
				group,
				roster: created.roster ? explainAdmission(created.roster) : undefined,
				mls: mls ? explainMlsAdmission(mls) : undefined,
			},
			acting,
		),
		memberSpellings,
	);
}
