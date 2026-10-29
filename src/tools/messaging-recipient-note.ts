/**
 * What `rine_send` tells a model when the ID it sent to named a GROUP.
 *
 * Its own module for `messaging-sync-recipient.ts`'s reason: `messaging.ts` is
 * already past the file-size ceiling, and this is a renderer rather than a step
 * of the send.
 */

import type { RecipientTarget } from "@rine-network/core";
import { REF_CLASS, classifyReference } from "@rine-network/core";

/** The key this notice rides under, beside `warning` and `handle_completion`. */
const GROUP_RECIPIENT_KEY = "group_recipient";

/**
 * The sentence, or nothing when the recipient slot held no surprise.
 *
 * 🔴 **The id class ALONE.** The id rung inside `resolveRecipient` reads the
 * GROUP namespace before the agent one, so a UUID copied out of the wrong column
 * no longer comes back `Agent not found` — it resolves, seals under the group's
 * key and is delivered to every member ORG of that group. That is the one
 * substitution the ladder makes which a caller cannot have intended: no agent
 * holds the id, so there was nothing else it could have meant. Every other
 * spelling a group answers to — `#logistics@acme.rine.network`, the short
 * `#logistics`, the bare `logistics` whose collision with an agent name
 * `refuseIfABareAgentName` already refuses — is this tool's own documented way
 * of naming a group, and a notice on those would ride every ordinary group send.
 *
 * 🔴 It quotes the caller's own spelling and the handle the wire carried, and
 * nothing else — no third handle, no `@org` slot to fill, which is
 * `handleCompletionNote`'s placeholder ban.
 *
 * The BYTES are this surface's, deliberately, and are not hoisted into
 * `@rine-network/core`: `groupIdRecipientNote`
 * (`rine-cli/src/commands/messages-send-target.ts`) records the ruling — a constant in the
 * shared package is one the Python stack is then expected to twin and a gate is
 * expected to hold, while `RecipientTarget` already carries `spelling` beside
 * `handle` so each surface can compare the two and speak in its own idiom. This
 * one addresses a MODEL reading a tool result, not an operator reading a
 * terminal, so it says what happened to the message rather than what was typed.
 */
function groupIdRecipientNote(target: RecipientTarget): string | undefined {
	if (target.kind !== "group") return undefined;
	if (classifyReference(target.spelling) !== REF_CLASS.id) return undefined;
	// `handle` is optional on the record because the JOIN ladder's directory rung
	// answers with an id and no row; every rung `resolveRecipient` climbs carries
	// one. Silence beats a sentence with `undefined` in the slot a model reads.
	const { handle, spelling } = target;
	if (handle === undefined) return undefined;
	return `'${spelling}' is the ID of a group, not of an agent, so this message went to the group ${handle} and every org seated in it.`;
}

/**
 * A tool's own result, carrying the group-recipient notice when there is one.
 *
 * 🔴 **STDERR is not available to this surface**, so the notice rides in the
 * RESULT — `withHandleCompletionNote`'s argument, and this module follows its
 * shape rules for the same reason: a result that carries two notices must not be
 * two different shapes. Most handlers return the server's response verbatim, so
 * the notice is spread onto it; a list or a scalar is wrapped rather than losing
 * it. A call with nothing to say returns byte-identically to before, which is
 * what keeps this off every green path.
 *
 * Its own key, so the three notices coexist: `warning` is the acting agent's,
 * `handle_completion` is item 18's, and this one is the recipient's namespace.
 */
export function withGroupRecipientNote(
	result: unknown,
	target: RecipientTarget,
): unknown {
	const note = groupIdRecipientNote(target);
	if (note === undefined) return result;
	const plainObject =
		typeof result === "object" && result !== null && !Array.isArray(result);
	return plainObject
		? { ...result, [GROUP_RECIPIENT_KEY]: note }
		: { result, [GROUP_RECIPIENT_KEY]: note };
}
