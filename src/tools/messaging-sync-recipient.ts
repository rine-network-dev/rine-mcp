/**
 * What `rine_send_and_wait` does with the recipient reference it was handed.
 *
 * Its own module for the reason `messaging-sync.ts` is its own module: the verb
 * beside it is the wait and the seal, and this is the ONE place on the surface
 * where a 1:1 verb has to answer a group-shaped question. Two of the three
 * functions here exist only because this verb refuses what the shared ladder
 * resolves, which is a fact about `POST /messages/sync` and not about sending.
 */

import type { RecipientTarget, ResolveOptions } from "@rine-network/core";
import {
	GROUP_NOT_FOUND_LEAD,
	NEITHER_NAMESPACE_LEAD,
	REF_CLASS,
	classifyReference,
	invalidAgentIdentifierRefusal,
	resolveRecipient,
} from "@rine-network/core";
import type { ToolContext } from "./types.js";

/**
 * The one thing this verb says to a group, whichever spelling reached it.
 *
 * Two arms, one sentence, because the two refusals differ only in how much is
 * known when they fire. A `#`-spelled reference is refused on syntax before any
 * request, so there is no group to name — the refusal ladder's rung 2, and it
 * deliberately describes rather than prints a handle. A bare name that the
 * recipient ladder
 * resolved is rung 1: the group's own handle, read off the row that resolve
 * already fetched, never a placeholder and never the caller's spelling.
 */
export function groupIsNotASyncRecipient(resolved: string | undefined): string {
	const what = resolved === undefined ? "a group handle" : `the group ${resolved}`;
	return `rine_send_and_wait is 1:1 only — the /messages/sync endpoint refuses ${what}. Use rine_send to post to a group.`;
}

/**
 * Whether a ladder refusal is *"no group of this org answers to it"* — the one
 * arm this verb answers for itself.
 *
 * Read off the LEAD, and off `rine-core`'s exported constants rather than
 * strings typed here: `rine-eve` and `rine-mastra` discriminate the same two
 * ways (`errors.ts`) and the backend gates `GROUP_NOT_FOUND_LEAD_COPIES` and
 * `NEITHER_NAMESPACE_LEAD_COPIES` pin every package's copy of each, so both are
 * bound values rather than a guess at somebody's prose.
 *
 * 🔴 **Two leads, two tests, and the second is deliberately not `startsWith`.**
 * A BARE name — the only class that reaches this call site's fallback — is
 * refused with {@link NEITHER_NAMESPACE_LEAD}, whose sentence OPENS with the
 * caller's own spelling, so a prefix test would never fire and the
 * agent-namespace fallback would silently stop happening: `rine_send_and_wait`
 * would answer a bare miss with a roster of groups it refuses anyway, which is
 * the measured regression this pair of tests exists to prevent.
 * {@link GROUP_NOT_FOUND_LEAD} keeps its prefix test because the arms that
 * still raise it still lead with it.
 *
 * 🔴 It matches exactly one of the three things the bare rung raises. The
 * ambiguity refusal opens *"Group name 'ops' is ambiguous"* and the agent-name
 * collision opens *"'mybot' is the name of an agent of your org"*; neither
 * carries the lead, and neither may be swallowed — they are the two bounds that
 * make reading a bare word as a group safe at all (the other being
 * `refuseIfABareAgentName`). A server fault is a weaker guarantee than it was:
 * the first test is a prefix and `RineApiError`'s message is
 * `${status}: ${detail}`, so a status prefix keeps a fault out of it — but the
 * second test is containment, which a prefix does not protect. Nothing on the
 * wire quotes the phrase back today; a server whose `detail` echoed it would be
 * swallowed here, and that is the cost of the widening.
 */
function isNoSuchGroupRefusal(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return (
		err.message.startsWith(GROUP_NOT_FOUND_LEAD) ||
		err.message.includes(NEITHER_NAMESPACE_LEAD)
	);
}

/**
 * The recipient, resolved through the same ladder `rine_send` climbs — and the
 * one place the two verbs deliberately answer differently.
 *
 * 🔴 **Ladder first, then fall back to the agent sentence.** A bare name runs
 * the group ladder, so a bare name that IS a group is told plainly that it is a
 * group and that this verb is 1:1 — the better sentence, and the reason the two
 * verbs share a ladder. When the ladder MISSES, the measured answer was worse
 * than the one it replaced: this verb is 1:1 by construction, so the only thing
 * a bare name can have meant is an agent handle with the org half dropped, and
 * the miss leads with *"Group not found"* and closes with a roster of groups
 * the verb refuses anyway. So the miss, and only the miss, is answered in the
 * agent namespace — which is what this call site raised before the migration.
 *
 * The sentence is {@link invalidAgentIdentifierRefusal}, the function the agent
 * resolver itself raises, never a copy: it already carries no worked example,
 * and a re-pin of it reaches this verb for free.
 *
 * 🔴 Only `REF_CLASS.bare` falls back. A `#`-spelled reference never gets here
 * (the pre-flight refuses it before any request), and an `@` or a UUID is the
 * agent resolver's own answer already.
 *
 * `opts` is the contract's own {@link ResolveOptions} rather than the headers
 * alone, so this verb hands over the same two things `rine_send` does — the
 * attribution header, and the agent page the actor ladder already bought for
 * the collision guard, which was otherwise read twice per bare-name call.
 */
export async function oneToOneRecipient(
	ctx: ToolContext,
	to: string,
	opts: ResolveOptions,
): Promise<RecipientTarget> {
	try {
		return await resolveRecipient(ctx.client, ctx.apiUrl, to, opts);
	} catch (err) {
		if (classifyReference(to) === REF_CLASS.bare && isNoSuchGroupRefusal(err)) {
			throw new Error(invalidAgentIdentifierRefusal(to));
		}
		throw err;
	}
}
