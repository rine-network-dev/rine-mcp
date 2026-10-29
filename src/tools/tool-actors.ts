import {
	ACTING_AGENT_HEADER,
	ACTOR_SURFACES,
	type ActorSurface,
	type ResolvedActor,
	actorFromEnv,
	actorNote,
	normalizeActor,
	resolveActor,
	resolveToUuid,
	singleActorValue,
} from "@rine-network/core";
import type { ToolContext, ToolParams } from "./types.js";

/**
 * The one description of the acting-agent parameter, for every tool that takes
 * one.
 *
 * It lives with the resolution helpers rather than in any tool module because
 * `agent` means the same thing on all of them: which of the org's agents this
 * call acts as. One name for one concept is only worth having if it reads the
 * same everywhere, so the group, message and hook tools all describe it in
 * these words.
 *
 * 🔴 `rine_inspect`'s `agent` is a **lookup target**, not an actor, and must
 * keep its own words (`discovery.ts`).
 */
export const ACTING_AGENT_PARAM = {
	type: "string",
	description:
		"Acting agent name, handle or UUID — for example `kofi`. Omit it on a " +
		"one-agent org: that agent acts.",
};

/**
 * The spellings a tool reads its acting agent from, canonical first.
 *
 * `agent` is the only one any schema declares. `as` is read but never
 * declared: a stale caller that still sends it once acted as whichever agent
 * the org's shortcut picked, because nothing here validates unknown keys and
 * the value was simply dropped. Declaring the retired word again would put it
 * back in front of the model, which is what the rename removed.
 */
const ACTOR_KEYS: readonly string[] = [
	ACTOR_SURFACES.mcp.canonical,
	ACTOR_SURFACES.mcp.alias,
];

/**
 * The send tools' spellings: `from` named the sender on `rine_send` and
 * `rine_send_and_wait` until the rename, and on no other tool. It is read
 * only here, because no other tool ever meant the actor by that word and one
 * that grows a `from` filter must not have it read as an identity.
 */
export const SEND_ACTOR_KEYS: readonly string[] = [...ACTOR_KEYS, "from"];

/** The two tools that read `from` as an identity. Every other tool does not. */
const SEND_ACTOR_TOOLS: ReadonlySet<string> = new Set([
	"rine_send",
	"rine_send_and_wait",
]);

/**
 * The spellings one named tool reads its acting agent from.
 *
 * The pairing is declared here, beside the key sets, because the two handlers
 * that pass `SEND_ACTOR_KEYS` and any wrapper that asks "did the caller name
 * one?" must agree about which tools `from` is an identity on — a wrapper
 * holding the widest set would read a `from` on `rine_inbox` as an actor and
 * silently drop the operator's own binding for that call.
 */
export function actorKeysFor(tool: string): readonly string[] {
	return SEND_ACTOR_TOOLS.has(tool) ? SEND_ACTOR_KEYS : ACTOR_KEYS;
}

/**
 * The actor a call named, under any spelling the tool reads.
 *
 * Two spellings are the SAME rung — two words for one value — so two that
 * disagree refuse naming both rather than one silently winning. The
 * trim, the comparison rule and the refusal text all come from `rine-core`;
 * this only walks the keys and remembers which one carried the value, so the
 * refusal names the words the caller actually typed.
 */
function actorArgument(
	p: ToolParams,
	keys: readonly string[] = ACTOR_KEYS,
): string | undefined {
	let value: string | undefined;
	let spelling: string = ACTOR_SURFACES.mcp.canonical;
	for (const key of keys) {
		const named = normalizeActor(p[key]);
		if (named === undefined) continue;
		if (value === undefined) {
			value = named;
			spelling = key;
			continue;
		}
		const surface: ActorSurface = {
			...ACTOR_SURFACES.mcp,
			canonical: spelling,
			alias: key,
		};
		value = singleActorValue(value, named, surface);
	}
	return value;
}

/**
 * Whether a call already names its acting agent, under the spellings the tool
 * being called actually reads ({@link actorKeysFor}).
 *
 * This answers a wrapper's question, not a handler's: openclaw defaults the
 * operator's `channels.rine.agentId` into the canonical slot, and a wrapper
 * that writes `agent` beside a caller's own `from` would turn one caller's
 * choice into that two-values refusal. Configuration is rung 2 and the
 * caller is rung 1; a lower rung stays quiet.
 *
 * `keys` is required rather than defaulted: nothing here validates unknown
 * arguments, so a `from` a model invented on a tool that has no such parameter
 * would, under the widest set, read as "the caller named an actor" and discard
 * the operator's binding — the call then acts as whoever the org's shortcut
 * picks. Neither default is safe for both callers, so there is none.
 */
export function namesActor(p: ToolParams, keys: readonly string[]): boolean {
	return keys.some((key) => {
		const value = p[key];
		if (typeof value === "string") return normalizeActor(value) !== undefined;
		return value !== undefined && value !== null;
	});
}

/**
 * Resolve which of the org's agents a call acts as: the ladder, in one place.
 *
 * The caller's own value first (under any spelling it may have used), then
 * `RINE_AGENT`, then the org's only agent, then a refusal naming them all —
 * `resolveActor` owns every rung, and the org's agent list is fetched only
 * where a fetch can change the answer.
 *
 * 🔴 Returns the resolved actor, not its id, because a one-agent org now
 * *acts* on a value it could not resolve rather than refusing it. The
 * value the caller typed is then the one thing the result can still tell them
 * about, and this surface's channel for it is a `warning` key on the tool's own
 * JSON — so every handler spreads {@link actorNote} into what it returns.
 */
export async function actingAgent(
	ctx: ToolContext,
	p: ToolParams = {},
	keys: readonly string[] = ACTOR_KEYS,
): Promise<ResolvedActor> {
	return resolveActor(
		ctx.client,
		actorArgument(p, keys),
		undefined,
		ACTOR_SURFACES.mcp,
	);
}

/**
 * The agent this call acts as, or null when nothing named one.
 *
 * Deliberately lazy at the bottom of the ladder: a call that names no agent and
 * has no `RINE_AGENT` must not start failing in a multi-agent org just to
 * attach a header the server does not need. It is not lazy above that — an
 * environment that names an agent is a caller saying which one acts.
 */
export async function namedActingAgent(
	ctx: ToolContext,
	p: ToolParams = {},
	keys: readonly string[] = ACTOR_KEYS,
): Promise<ResolvedActor | null> {
	const argued = actorArgument(p, keys);
	const named = argued ?? actorFromEnv();
	if (named === undefined) return null;
	// The rung goes down with the value: this function climbs rung 3 itself and
	// then passes the answer as `explicit`, so `resolveActor` cannot tell the two
	// apart — and a warning that told a model to omit an `agent` key the call
	// never carried would be an instruction it cannot follow.
	return resolveActor(
		ctx.client,
		named,
		undefined,
		ACTOR_SURFACES.mcp,
		argued === undefined ? "environment" : "argument",
	);
}

/**
 * A tool's own result, carrying the acting agent's note when there is one.
 *
 * The one place this surface renders that note, so no handler has to
 * remember the key's name or the shape rule. Most handlers return the server's
 * response verbatim — an object we did not build — so the note is spread onto
 * it; the few that answer with a list or a scalar get wrapped rather than
 * silently losing it, and that only ever happens on the call that already went
 * wrong. A call with nothing to say returns byte-identically to before, which
 * is what keeps this off every green path.
 *
 * `null` is accepted — the answer of {@link namedActingAgent} when the call
 * named nobody — so a handler on the lazy rung wraps its result the same way as
 * one on the full rung instead of writing the empty case out again.
 */
export function withActorNote(
	result: unknown,
	acting: ResolvedActor | null,
): unknown {
	if (acting === null) return result;
	const note = actorNote(acting);
	if (note.warning === undefined) return result;
	const plainObject =
		typeof result === "object" && result !== null && !Array.isArray(result);
	return plainObject ? { ...result, ...note } : { result, ...note };
}

/** The acting-agent header for a resolved agent, or no header at all. */
export function agentHeaders(agentId: string | null): Record<string, string> {
	return agentId === null ? {} : { [ACTING_AGENT_HEADER]: agentId };
}

/**
 * {@link agentHeaders} over {@link namedActingAgent}, for a read that needs
 * nothing but the header.
 *
 * The LAZY rung, and the reason it exists: a tool that learns which agent it
 * acts as from the message it is about to fetch cannot name the actor before the
 * read the way `rine_read` does. So a host that named an agent — a caller key or
 * `RINE_AGENT` — says so on that GET and gets its own delivery row marked, and a
 * host that named nobody stays header-less rather than refusing a multi-agent
 * org for a header the server does not require. Every call site relies on this;
 * none of them restates it.
 *
 * ⚠️ The header is all this rung carries: a one-agent fallback's warning is
 * dropped here. A tool that owes the caller that warning climbs
 * {@link namedActingAgent} itself and wraps its answer in
 * {@link withActorNote} — `rine_group_vote`, `rine_group_remove` and
 * `rine_group_invite` all do. What is left on this rung is three classes where
 * dropping it is the right answer rather than an omission:
 *
 *   * Reads that hand back the server's page (`rine_group_requests`, `rine_group_invites`), or the
 *     roster rebuilt from it (`rine_group_roster`) — there is no object of ours
 *     to attach a key to.
 *   * Key-scoped reads (`rine_groups`,
 *     `rine_group_inspect`) — the answer does not depend on the acting-agent header,
 *     so there is nothing about the actor to report. hermes leaves its own
 *     key-scoped reads out of the note deliberately, for that reason
 *     (`rine-hermes/src/hermes_rine/_client.py`).
 *   * The three tools that learn their actor FROM what they fetch
 *     (`rine_reply`, `rine_pay`, `rine_fulfill`) — the value the caller named
 *     never chose the actor there, so a sentence about it would name the wrong
 *     cause.
 */
export async function actingHeaders(
	ctx: ToolContext,
	p: ToolParams = {},
	keys: readonly string[] = ACTOR_KEYS,
): Promise<Record<string, string>> {
	return agentHeaders((await namedActingAgent(ctx, p, keys))?.agentId ?? null);
}

/**
 * Resolve every handle or UUID a plural request names, in request order.
 *
 * Order is load-bearing: the server's per-member report answers one entry per
 * requested id in the order they were sent. Sequential rather than concurrent
 * because a UUID resolves with no round trip at all, so the only cost is one
 * WebFinger lookup per handle actually given.
 */
export async function resolveAgentIds(
	ctx: ToolContext,
	values: readonly unknown[],
): Promise<string[]> {
	const ids: string[] = [];
	for (const value of values) {
		ids.push(await resolveToUuid(ctx.apiUrl, String(value)));
	}
	return ids;
}

/** The list a plural parameter named, or a refusal naming what it should be. */
export function asAgentList(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(
			`${field} must be a non-empty list of agent handles (bot@acme) or UUIDs.`,
		);
	}
	return value;
}
