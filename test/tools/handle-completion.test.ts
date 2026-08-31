// The handle-completion notice on the MCP surface — the shape it takes.
//
// `resolveToUuid` completes a short handle before WebFinger sees it and answers
// with a UUID, never the spelling it resolved. On a surface whose caller is a
// model that silence is worse than on a terminal: the model named one agent,
// the call touched another, and the result it reads back says nothing.
//
// 🔴 STDERR is not available here. The CLI announces on stderr; an MCP server's
// stderr goes to the host's log file, which the model never reads — so the
// notice has to ride in the RESULT. This file pins that shape; the four
// handlers that can report one are pinned in their own suites (`groups.test.ts`,
// `groups-admin.test.ts`, `discovery.test.ts`).
//
// 🔴 Nothing here retypes the sentence. Every expectation derives it from
// `@rine-network/core`, whose own suite pins the bytes — four surfaces agreeing
// with each other and none of them agreeing with `normalizeHandle` is the drift
// a hand-typed copy would hide.

import { handleCompletionNotes } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { withHandleCompletionNote } from "../../src/tools/handle-completion.js";

const TYPED = "kofi@acme";
const WHOLE = "kofi@acme.rine.network";

describe("withHandleCompletionNote — what the model reads back", () => {
	it("hangs the notice on the server's own object without disturbing it", () => {
		const server = { id: "req-1", status: "invited" };
		expect(withHandleCompletionNote(server, [TYPED])).toEqual({
			id: "req-1",
			status: "invited",
			handle_completion: handleCompletionNotes([TYPED]),
		});
	});

	// The rule that keeps this off every green path: a call with nothing to say
	// answers byte-identically to what it answered before item 18 existed, so no
	// existing consumer of any of the four tools sees a new key.
	it("returns the result itself when no spelling was rewritten", () => {
		const server = { id: "req-1" };
		expect(withHandleCompletionNote(server, [WHOLE])).toBe(server);
		expect(withHandleCompletionNote(server, [])).toBe(server);
		expect(
			withHandleCompletionNote(server, ["11111111-1111-1111-1111-111111111111"]),
		).toBe(server);
	});

	// `withActorNote`'s rule, deliberately the same one: a result that carries
	// both notices must not be two different shapes. A list would silently lose
	// the key to a spread, so it gets wrapped instead.
	it("wraps a list rather than spreading the notice into nothing", () => {
		expect(withHandleCompletionNote([{ id: "a" }], [TYPED])).toEqual({
			result: [{ id: "a" }],
			handle_completion: handleCompletionNotes([TYPED]),
		});
	});

	it("wraps a scalar the same way", () => {
		expect(withHandleCompletionNote("ok", [TYPED])).toEqual({
			result: "ok",
			handle_completion: handleCompletionNotes([TYPED]),
		});
		expect(withHandleCompletionNote(null, [TYPED])).toEqual({
			result: null,
			handle_completion: handleCompletionNotes([TYPED]),
		});
	});

	// 🔴 The two notices are about different things — `warning` is which agent
	// ACTED, `handle_completion` is which agent was ACTED ON — so a call that did
	// both must report both. Nesting them the other way round, or letting either
	// spread over the other's key, loses one silently.
	it("coexists with the acting-agent warning instead of overwriting it", () => {
		const withWarning = { id: "req-1", warning: "picked the only agent" };
		expect(withHandleCompletionNote(withWarning, [TYPED])).toEqual({
			id: "req-1",
			warning: "picked the only agent",
			handle_completion: handleCompletionNotes([TYPED]),
		});
	});

	// A batch verb is where a silent completion does the most damage: one wrong
	// agent among twenty seats itself unnoticed. Every rewritten spelling is
	// named, and only the rewritten ones.
	it("names each rewritten spelling in a batch, and no others", () => {
		const result = withHandleCompletionNote({ invited: 3 }, [
			"ana@acme",
			WHOLE,
			"ben@ops",
		]) as Record<string, string>;
		expect(result.handle_completion).toBe(
			handleCompletionNotes(["ana@acme", "ben@ops"]),
		);
		expect(result.handle_completion).toContain("ana@acme");
		expect(result.handle_completion).toContain("ben@ops");
		expect(result.handle_completion).not.toContain("kofi");
	});
});
