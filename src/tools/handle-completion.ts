import { handleCompletionNotes } from "@rine-network/core";

/** The key a completion notice rides under, on every tool that can report one. */
const HANDLE_COMPLETION_KEY = "handle_completion";

/**
 * A tool's own result, carrying the handle-completion notice when there is one.
 *
 * 🔴 **Why this surface owes the notice.** `resolveToUuid` completes a short
 * handle before it reaches WebFinger — `kofi@acme` is looked up as
 * `kofi@acme.rine.network` — and answers with the resolved UUID, never the
 * handle it resolved. On a surface whose caller is a model, that silence is
 * worse than on a terminal: the model named one agent, the call invited,
 * removed or inspected another, and the result it reads back says nothing about
 * the substitution.
 *
 * 🔴 **STDERR is not available to this surface.** The CLI announces on stderr;
 * an MCP server's stderr goes to the host's log file, which the model never
 * reads. The notice therefore has to ride in the RESULT, which is what makes
 * this a different renderer rather than a second copy of the CLI's.
 *
 * The SENTENCE is {@link handleCompletionNotes}' and is not retyped here — the
 * same bytes the CLI writes to stderr and `rine-mastra`/`rine-eve` put on a
 * line. This module decides only the key and the shape.
 *
 * Shape rules are {@link withActorNote}'s, deliberately, because a result that
 * carries both notices must not be two different shapes: most handlers return
 * the server's response verbatim — an object this package did not build — so
 * the notice is spread onto it; the few that answer with a list or a scalar get
 * wrapped rather than silently losing it. A call with nothing to say returns
 * byte-identically to before, which is what keeps this off every green path.
 *
 * The two notices coexist: `warning` is the acting agent's and
 * `handle_completion` is this one, so a call that both auto-selected an actor
 * and completed a handle reports both instead of one overwriting the other.
 */
export function withHandleCompletionNote(
	result: unknown,
	spellings: readonly string[],
): unknown {
	const note = handleCompletionNotes(spellings);
	if (note === undefined) return result;
	const plainObject =
		typeof result === "object" && result !== null && !Array.isArray(result);
	return plainObject
		? { ...result, [HANDLE_COMPLETION_KEY]: note }
		: { result, [HANDLE_COMPLETION_KEY]: note };
}
