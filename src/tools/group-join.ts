import {
	type MlsMembershipResult,
	ACTING_AGENT_HEADER,
	establishMlsMembership,
	reportFailedSetup,
	seatedMemberAfterConflict,
} from "@rine-network/core";
import { joinGroupTarget } from "./group-ref.js";
import { actingAgent, withActorNote } from "./tool-actors.js";
import type { ToolContext } from "./types.js";

/**
 * Join a group, then establish whatever local crypto state membership implies.
 *
 * The ladder (a Welcome waiting for the agent, retaking a leaf it holds with no
 * state, an external commit when it holds none) is rine-core's
 * `establishMlsMembership`, shared by every TypeScript surface. It runs when the
 * join answers 200, and when it answers 409 `already_a_member` for an agent
 * with no local state; a 202 (a request pending approval) runs no MLS step.
 *
 * 🔴 Every MLS step here is non-fatal except one: a refusal for **this** group
 * (a Welcome the group substitution guard refused, or a tree holding a member
 * the agent cannot verify). That is a verdict about the group, so the tool call
 * fails with it rather than returning a join result with a warning on stderr no
 * model will ever read. `rine.groups.join()` on the Python SDK raises the same
 * refusal, and a failure that is loud on one stack and a log line on the other
 * is a defect a user only meets on the quiet one. The rine membership stands
 * either way.
 *
 * Two kinds of verdict use `MlsWelcomeRefusedError`. Most reasons are the
 * substitution guard's verdict about who minted a Welcome; retrying the join
 * does not change them. Reason `peer_not_admitted` is different: the group's
 * tree holds a member the server no longer vouches for. The Welcome install, the
 * external join and the seat retake all raise it, and it clears once any member
 * reclaims that seat with `rine group resume-admission --reclaim`; then repeat
 * the join.
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
	let result: unknown;
	try {
		result = await ctx.client.post(`/groups/${groupId}/join`, body, headers);
	} catch (err) {
		// An agent already seated with no local state is brought back; any
		// other failure, or a seat the setup cannot finish, stands as raised.
		const seated = await seatedMemberAfterConflict(
			err,
			{
				configDir: ctx.configDir,
				groupId,
				client: ctx.client,
				actingAgent: async () => agentId,
			},
			warnFailedSetup(groupId),
		);
		if (seated) return withActorNote(seated, acting);
		throw err;
	}

	if (isMemberRow(result))
		await establishJoinedMls(ctx, groupId, agentId, headers);
	return withActorNote(result, acting);
}

/** A join answer that seated the agent, as opposed to a 202's pending request. */
function isMemberRow(result: unknown): boolean {
	return typeof result === "object" && result !== null && "role" in result;
}

/**
 * Run the shared establishment and warn when it fails; a refusal for this
 * group propagates.
 */
async function establishJoinedMls(
	ctx: ToolContext,
	groupId: string,
	agentId: string,
	headers: Record<string, string>,
): Promise<void> {
	const res = await establishMlsMembership(
		ctx.configDir,
		agentId,
		groupId,
		ctx.client,
		headers,
	);
	reportFailedSetup(res, warnFailedSetup(groupId));
}

/** Warn about an establishment that failed. */
function warnFailedSetup(groupId: string) {
	return (res: MlsMembershipResult): void => {
		console.warn(
			`MLS setup failed after joining group ${groupId}:`,
			res.failure?.error ?? res.reason,
		);
	};
}
