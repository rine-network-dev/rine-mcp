/**
 * `rine_thread` — which transcript the tool reads, and what it refuses.
 *
 * The decrypt/render half of this verb is covered by `messaging.test.ts`
 * against real key material; this file is about the reference the caller names:
 * which route it reaches, and which mistakes are answered before a request is
 * spent. The rows are therefore deliberately empty — a route assertion should
 * not depend on a ciphertext fixture.
 */

import { describe, expect, it, vi } from "vitest";
import { rineThread } from "../../src/tools/messaging-thread.js";
import type { ToolContext } from "../../src/tools/types.js";

/** A UUID acting agent, which `resolveActor` answers without a round trip. */
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "22222222-2222-2222-2222-222222222222";
const CONV_ID = "33333333-3333-3333-3333-333333333333";

const EMPTY_PAGE = { messages: [], truncated: false };

/** A context whose every GET is recorded, so "spent nothing" is assertable. */
function makeCtx(routes: Record<string, unknown> = {}) {
	const get = vi.fn(async (path: string) => {
		if (path in routes) return routes[path];
		return EMPTY_PAGE;
	});
	const ctx = {
		client: { get, post: vi.fn() } as never,
		configDir: "/tmp/rine-thread-test",
		apiUrl: "https://api.test",
	} as ToolContext;
	return { ctx, get };
}

/** The paths one call asked for, in order. */
function paths(get: ReturnType<typeof vi.fn>): string[] {
	return get.mock.calls.map((c) => c[0] as string);
}

describe("rine_thread — naming the transcript", () => {
	it("reads a group by its UUID, on the group's own route", async () => {
		const { ctx, get } = makeCtx({ [`/groups/${GROUP_ID}`]: { id: GROUP_ID } });

		await rineThread.handler(ctx, { group: GROUP_ID, agent: AGENT_ID });

		// 🔴 A UUID is the value the transcript route wants, but it is no
		// longer taken on trust: the group's own indexed row is read first, and an
		// id this caller cannot read is refused with their own groups rather than
		// with the server's bare 404 on the transcript. What it still costs no
		// more of is the unpaginated list and the agent list.
		expect(paths(get)).toEqual([
			`/groups/${GROUP_ID}`,
			`/groups/${GROUP_ID}/messages`,
		]);
	});

	it("reads a group by its handle, resolving it first", async () => {
		const { ctx, get } = makeCtx({
			"/groups": { items: [{ id: GROUP_ID, handle: "#ops@acme" }] },
		});

		await rineThread.handler(ctx, { group: "#ops@acme", agent: AGENT_ID });

		expect(paths(get)).toEqual(["/groups", `/groups/${GROUP_ID}/messages`]);
	});

	it("reads a conversation by its id, unchanged", async () => {
		const { ctx, get } = makeCtx();

		await rineThread.handler(ctx, {
			conversation_id: CONV_ID,
			agent: AGENT_ID,
		});

		expect(paths(get)).toEqual([`/conversations/${CONV_ID}/messages`]);
	});

	it("passes the caller's limit through to whichever route it took", async () => {
		const { ctx, get } = makeCtx({ [`/groups/${GROUP_ID}`]: { id: GROUP_ID } });

		await rineThread.handler(ctx, {
			group: GROUP_ID,
			limit: 5,
			agent: AGENT_ID,
		});

		// The TRANSCRIPT call, found by its route rather than by its position: the
		// limit belongs to the read, and a resolution read sits in front of it
		// that must not carry one.
		const transcript = get.mock.calls.find((c) =>
			String(c[0]).endsWith("/messages"),
		);
		expect(transcript?.[1]).toEqual({ limit: 5 });
	});
});

describe("rine_thread — the references it refuses", () => {
	it("refuses naming both references, without spending a request", async () => {
		const { ctx, get } = makeCtx();

		await expect(
			rineThread.handler(ctx, {
				group: GROUP_ID,
				conversation_id: CONV_ID,
				agent: AGENT_ID,
			}),
		).rejects.toThrow("Name exactly one of group");
		expect(get).not.toHaveBeenCalled();
	});

	it("refuses naming neither reference, without spending a request", async () => {
		const { ctx, get } = makeCtx();

		await expect(rineThread.handler(ctx, { agent: AGENT_ID })).rejects.toThrow(
			"Name exactly one of group",
		);
		expect(get).not.toHaveBeenCalled();
	});

	// The measured failure this verb was changed for: a model holding a group and
	// no conversation put the group's NAME in the conversation slot, and the
	// server — which types that path parameter `uuid.UUID` — answered a framework
	// 422 with no next step in it. The refusal has to name the slot that does
	// take a group, or the caller is left exactly where they were.
	//
	// 🔴 Rung 2. It named the slot as `group=#logistics@acme.rine.network`
	// until the worked example was retired — a model pastes a printed domain
	// verbatim — so it names the same slot and lists
	// the three spellings it takes, with no handle of its own to copy.
	it("refuses a conversation reference that is not a UUID, naming the group parameter", async () => {
		const { ctx, get } = makeCtx();

		const refusal = await rineThread
			.handler(ctx, { conversation_id: "quarterly planning group", agent: AGENT_ID })
			.then(
				() => "",
				(err: Error) => err.message,
			);

		expect(refusal).toMatch(
			/conversation_id must be a conversation UUID[\s\S]*name the group instead — group takes/,
		);
		// The ban itself, not just the wording above it: no invented handle for a
		// model to paste back. The caller's own reference carries no `@` either.
		expect(refusal).not.toContain("@");
		expect(get).not.toHaveBeenCalled();
	});

	it("refuses before resolving the acting agent", async () => {
		// No `agent`, so the actor ladder would have to fetch the org's agents —
		// the reference is decided first, so it never does.
		const { ctx, get } = makeCtx();

		await expect(rineThread.handler(ctx, {})).rejects.toThrow(
			"Name exactly one of group",
		);
		expect(get).not.toHaveBeenCalled();
	});
});

describe("rine_thread — the schema the model reads", () => {
	const schema = rineThread.inputSchema as {
		properties: Record<string, unknown>;
		required: string[];
	};

	it("declares both references and requires neither on its own", () => {
		expect(schema.properties).toHaveProperty("group");
		expect(schema.properties).toHaveProperty("conversation_id");
		// Exactly-one-of is not expressible in `required`; naming either one there
		// would refuse the other reference at the schema layer.
		expect(schema.required).toEqual([]);
	});

	it("states the exactly-one-of rule in the words the refusal uses", async () => {
		const { ctx } = makeCtx();
		const refusal = await rineThread
			.handler(ctx, {})
			.then(() => "", (err: Error) => err.message);

		expect(rineThread.description).toContain(refusal);
	});
});
