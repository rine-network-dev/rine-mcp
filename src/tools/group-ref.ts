/**
 * How this surface reads the group a call names, and what it resolves it to.
 *
 * 🔴 **Every group verb takes a group REFERENCE, never a UUID.** The
 * ten group tools here advertised *"Group UUID (from rine_discover_groups or
 * rine_groups)"* and passed `String(p.group_id)` straight into the route, while
 * the Python SDK resolved a handle, a name or an id on every one of its group
 * verbs. Same model, same group, a different answer decided by which stack
 * happened to be behind the tool. The measurement that closed the argument:
 * across three live-model runs on two surfaces, every failure was a model
 * composing a group identifier instead of resolving one, and the goals that
 * succeeded were the ones that listed or resolved first.
 *
 * The ladders are `rine-core`'s and are not restated here — `resolveGroup`
 * for the nine verbs aimed at a group this org is already in, and
 * `resolveGroupUuidForJoin` for the one aimed at a group it is by definition
 * not in. This module is only the seam: which argument carries the reference,
 * and what a handler gets back.
 */

import {
	GROUP_HANDLE_PARTS,
	JOIN_REFERENCE_RULE,
	type GroupTarget,
	type SeatedGroupTarget,
	resolveGroup,
	resolveGroupForJoin,
} from "@rine-network/core";
import type { ToolContext, ToolParams } from "./types.js";

/**
 * The one description of the group parameter, for every verb that acts on a
 * group this org is already in.
 *
 * Shared for the reason `ACTING_AGENT_PARAM` is (`tool-actors.ts`): `group`
 * means the same thing on all nine, and nine copies of a sentence about which
 * spellings resolve is nine chances for one of them to advertise a spelling
 * this surface refuses. It names all three spellings and the bound on the
 * loosest of them, because a ladder that can refuse for ambiguity has to say so
 * where the caller is choosing what to write.
 *
 * 🔴 `rine_group_join` does NOT take this one. Its ladder is a different ladder
 * — see {@link JOIN_GROUP_PARAM}.
 */
export const GROUP_REF_PARAM = {
	type: "string",
	description:
		"The group: its handle (`#logistics@acme.rine.network`), its name " +
		"(`logistics`), or its UUID. A name or a partial handle is resolved " +
		"against the groups your key can see (an org key's are the groups the org's agents are seated in), so you do not need to look an id up " +
		"first; a reference that answers to more than one of them is refused, " +
		"naming the candidates, rather than guessed at.",
};

/**
 * The same parameter on `rine_group_join`, whose ladder is aimed outward.
 *
 * The rule sentence is `rine-core`'s `JOIN_REFERENCE_RULE`, which the Python
 * SDK restates byte for byte and mastra and crewai already print — never
 * retyped here, because a surface whose copy goes stale advertises a spelling
 * the ladder refuses and the model reads the refusal as the product being
 * broken. What is appended is the one per-surface fact: which verb of THIS
 * surface prints an id beside a handle.
 */
export const JOIN_GROUP_PARAM = {
	type: "string",
	description:
		`The group to join. ${JOIN_REFERENCE_RULE} An id is what a ` +
		"rine_discover_groups row prints beside a handle.",
};

/**
 * The group a call named, exactly as it wrote it.
 *
 * `group` is the only spelling any schema here declares. `group_id` is read and
 * never advertised: it is what all ten tools once took, so a caller
 * holding the old shape — a cached tool list, a script written against the
 * published surface — keeps working, while the name in front of the model no
 * longer says "id" at the moment it is deciding whether it needs to go and find
 * one. Reading the retired word costs one `??`; declaring it again would put
 * back the priming the rename removed.
 *
 * 🔴 **Rung 2 of the refusal ladder.** This is a REFUSAL, and it is the seam's
 * own: every group verb on this surface passes through here, so it is the
 * most-hit refusal the package ships. It used to print
 * `#logistics@acme.rine.network` in a parenthesis, which is the shape a model
 * pastes verbatim — the local part moves with the world's subject matter and
 * the domain does not move at all. Rung 1, the caller's own org, is unreachable
 * by construction: this function holds a params bag and nothing else — no
 * client, no roster, no agent list — so there is no handle to derive an org
 * from. It describes the handle part by part instead, in
 * {@link GROUP_HANDLE_PARTS} — the shared clause, composed and never retyped,
 * so a founder re-pin of the ratified wording reaches this sentence too — and
 * names
 * the three spellings in `notAConversationUuidRefusal`'s words. Not a slot
 * either (`check-model-facing-examples.mjs`'s `template-org` rule).
 *
 * ⚠️ {@link GROUP_REF_PARAM} keeps its worked example and must: the ban on
 * worked examples covers refusals, not tool DESCRIPTIONS, and this one is read
 * where a caller is being taught rather than corrected.
 *
 * @throws {Error} Neither spelling carried a value.
 */
export function groupRefArgument(p: ToolParams): string {
	const named = p.group ?? p.group_id;
	if (named === undefined || named === null || String(named).trim() === "") {
		throw new Error(
			`group is required: a group's whole handle — ${GROUP_HANDLE_PARTS} — a ` +
				"bare group name, or its UUID.",
		);
	}
	return String(named).trim();
}

/**
 * Resolve the group a call named, for any verb but join.
 *
 * The record is `rine-core`'s {@link SeatedGroupTarget} rather than a shape of
 * this package's own, and that is the widened seam: `resolveGroup` has already
 * read the group's row, so a seam that narrowed it to an id would make every
 * caller that needs the row read it back — the same group twice, one request
 * apart, with two answers that can disagree about which group the reference
 * named. `spelling` is what the caller wrote and the only string a refusal or a
 * summary may quote back; echoing the resolved UUID would be naming an
 * identifier the caller never typed, the small lie `notAnMlsGroupResume` was
 * reworded to stop telling.
 *
 * `extraHeaders` carries `X-Rine-Agent` where the handler already has one in
 * hand. It is attribution and never selection — `GET /groups` follows the key —
 * so the handlers that resolve their acting agent late deliberately (invite,
 * remove) pass none rather than climbing that ladder early and changing what
 * their own refusals are about.
 */
export async function groupTarget(
	ctx: ToolContext,
	p: ToolParams,
	extraHeaders?: Record<string, string>,
): Promise<SeatedGroupTarget> {
	return resolveGroup(ctx.client, groupRefArgument(p), { extraHeaders });
}

/**
 * The same, through the join-scoped ladder.
 *
 * 🔴 Deliberately not {@link groupTarget}. Join's target is a group this org
 * does not hold a seat in, so the groups your key can see, which
 * `resolveGroup` searches, are the one set that cannot contain it; `resolveGroupUuidForJoin` walks the seats,
 * then this agent's invitations, then the open and voted groups its org holds a seat in,
 * then the public directory. The reasons and the
 * bounds are `rine-core/src/resolve-group-join.ts`'s.
 *
 * The record is `rine-core`'s loose {@link GroupTarget} and NOT
 * {@link SeatedGroupTarget}, which is the same distinction the two types were
 * split for: the directory rung resolves an id out of a public listing with no
 * group row behind it, so there is neither a handle nor a row to promise, and
 * an absent `row` is what marks an answer as the join ladder's. The record is
 * `rine-core`'s own `resolveGroupForJoin`'s and is not restated here: this
 * module is the seam that reads the argument, and the shape of a join answer
 * belongs to the ladder that answers it — a copy of the literal reads green on
 * the day core's record grows a field, which is the one way the two join seams
 * on this stack could stop being one shape.
 */
export async function joinGroupTarget(
	ctx: ToolContext,
	p: ToolParams,
	extraHeaders?: Record<string, string>,
): Promise<GroupTarget> {
	const ref = groupRefArgument(p);
	return resolveGroupForJoin(ctx.client, ref, { extraHeaders });
}
