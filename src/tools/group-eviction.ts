import {
	RineApiError,
	holdsMlsState,
	namesASeatedSibling,
} from "@rine-network/core";
import { actingAgent } from "./group-actors.js";
import type { ToolContext, ToolParams } from "./types.js";

/**
 * What an agent is told when the group it is reading has removed it.
 *
 * Removal now posts a real MLS Remove commit, so the group's epoch moves past
 * the evicted leaf and nothing sent afterwards is decryptable by it. Without
 * this sentence the agent gets the same bare refusal an agent who was never a
 * member gets, and — the moment it tries to read the group's traffic — an
 * mls-rs invariant about an inactive group, which names neither what happened
 * nor what to do about it.
 *
 * It promises only remedies that exist: re-invitation is the way back, and
 * mail that already arrived is not taken back.
 */
const REMOVAL_DETAIL =
	"A group admin posted an MLS Remove commit, so your leaf is gone from the " +
	"group's ratchet tree and messages sent after that commit cannot be " +
	"decrypted. Messages that already reached your inbox still open. To return, " +
	"ask a group admin to invite you again — a re-invitation mints a new leaf " +
	"and a fresh Welcome.";

function removedFromGroup(groupId: string): Error {
	return new Error(`You were removed from group ${groupId}. ${REMOVAL_DETAIL}`);
}

/**
 * Re-word a group read the server refused, when this agent's own MLS state says
 * it used to be a member.
 *
 * Holding local MLS state for a group the server will not let you read means
 * one thing: you were in it and you are not now. `isActive()` alone cannot
 * answer this — it turns false only once the Remove commit has been applied
 * locally, and an evicted agent has no reason to have synced.
 *
 * Every other case returns the original error untouched, so an agent who was
 * never a member still gets the server's own answer, and an open (Sender-Keys)
 * group — which holds no MLS state and has no cryptographic eviction at
 * all — is never described as one.
 *
 * A refusal that NAMES A SEATED SIBLING is the third such case, and the reason
 * this function cannot infer eviction from a bare 403 any more. The
 * server's membership gate now refuses a caller whose ACTING agent holds no
 * seat, and that refusal fires while a sibling agent of the same org is sitting
 * in the group — where nobody was evicted and the remedy is one `agent`
 * argument. It is a whole-org's-worth of agents wider than the eviction it used
 * to look exactly like, so the server's own sentence is the better answer and
 * this one would be a lie.
 *
 * 🔴 The arm, not the family. All three arms of that refusal open with
 * `NOT_A_MEMBER_CLAUSE`, and the third one — "no agent of your org is" — is
 * precisely what a genuinely evicted agent in a single-agent org reads on
 * `GET /groups/{id}/requests`, whose only gate is the membership one. Matching
 * the family would delete this affordance on the one route where it is
 * reachable. `namesASeatedSibling` requires the retry instruction as well,
 * which only the two sibling arms carry; both clauses are pinned constants the
 * two stacks share (`rine-core/src/group-words.ts` ⇄
 * `src/rine/api/group_member_words.py`), not ad-hoc substrings, and
 * `tests/test_client-server-contract_group0.py` is what stops the copies
 * drifting.
 *
 * `groupRef` is what the sentence NAMES; `groupId` is what the local MLS state
 * is filed under. They were the same string until a caller could write a
 * handle, and only one of them is a spelling the caller would recognise —
 * `You were removed from group 4f2b…` is a true sentence about a group they
 * asked for by name. It defaults to the id so no other call site changes.
 */
export async function asGroupAccessError(
	ctx: ToolContext,
	groupId: string,
	p: ToolParams,
	err: unknown,
	groupRef?: string,
): Promise<unknown> {
	if (!(err instanceof RineApiError)) return err;
	if (err.status !== 403 && err.status !== 404) return err;
	if (namesASeatedSibling(err.detail)) return err;
	try {
		const { agentId } = await actingAgent(ctx, p);
		if (!holdsMlsState(ctx.configDir, agentId, groupId)) return err;
	} catch {
		// Cannot tell which agent is reading, or the id is not a group id we
		// could hold state under. Either way this is not provably an eviction.
		return err;
	}
	return removedFromGroup(groupRef ?? groupId);
}
