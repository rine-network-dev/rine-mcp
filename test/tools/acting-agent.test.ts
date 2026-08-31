// The acting-agent ladder, as an MCP caller reaches it.
//
// 🔴 This file mocks NOTHING of `@rine-network/core`'s resolution: every other
// tool suite here stubs `resolveActor` to a fixed id, which is exactly what a
// ladder test must not do. The only stub is the HTTP client, so `GET /agents`
// answers and everything above it — trimming, the same-rung disagreement, the
// `RINE_AGENT` rung, the org's-only-agent shortcut and the refusal text — runs
// for real, through a tool handler, from the arguments the MCP server would
// hand over.
//
// The tools are chosen for what they exercise, not for variety:
//  - `rine_groups` takes the header-only path (`actingHeaders`), which stays
//    lazy at the bottom of the ladder.
//  - `rine_hook_list` takes the full path (`actingAgent`), which climbs to the
//    org's only agent and refuses.
//  - `rine_inbox` and `rine_send` are the two non-group shapes that once
//    disagreed about coercion — one used `as string | undefined`, the group
//    verbs used `String(agent)`, and neither refused a non-string.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { actorKeysFor, namesActor } from "../../src/tools/group-actors.js";
import { groupTools } from "../../src/tools/groups.js";
import { hookTools } from "../../src/tools/hooks.js";
import { messagingTools } from "../../src/tools/messaging.js";
import type { ToolContext } from "../../src/tools/types.js";

const rineGroups = groupTools.find((t) => t.name === "rine_groups")!;
const rineHookList = hookTools.find((t) => t.name === "rine_hook_list")!;
const rineInbox = messagingTools.find((t) => t.name === "rine_inbox")!;
const rineReply = messagingTools.find((t) => t.name === "rine_reply")!;
const rineSend = messagingTools.find((t) => t.name === "rine_send")!;

const BOT = {
	id: "11111111-1111-1111-1111-111111111111",
	name: "bot",
	handle: "bot@acme.rine.network",
};
const OPS = {
	id: "22222222-2222-2222-2222-222222222222",
	name: "ops",
	handle: "ops@acme.rine.network",
};

/** A context whose org holds exactly the agents given. */
function makeCtx(agents: object[] = [BOT]): {
	ctx: ToolContext;
	get: ReturnType<typeof vi.fn>;
} {
	const get = vi.fn(async (path: string) => {
		if (path === "/agents") return { items: agents };
		return { items: [] };
	});
	const ctx = {
		client: { get, post: vi.fn(), delete: vi.fn() },
		configDir: "/tmp/rine-actor-test",
		apiUrl: "https://api.test",
	} as unknown as ToolContext;
	return { ctx, get };
}

/** The header a header-only group verb sent, or undefined if it sent none. */
function sentHeaders(
	get: ReturnType<typeof vi.fn>,
): Record<string, string> | undefined {
	const call = get.mock.calls.find((c) => c[0] === "/groups");
	return call?.[2] as Record<string, string> | undefined;
}

beforeEach(() => {
	// The env is a rung: every case says explicitly whether it is occupied.
	vi.stubEnv("RINE_AGENT", "");
});

describe("rung 1 — the actor a call names", () => {
	it("reads the retired `as` a stale caller still sends", async () => {
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineGroups.handler(ctx, { as: "ops" });

		expect(sentHeaders(get)).toEqual({ "X-Rine-Agent": OPS.id });
	});

	it("trims what the caller typed", async () => {
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineGroups.handler(ctx, { agent: "  ops  " });

		expect(sentHeaders(get)).toEqual({ "X-Rine-Agent": OPS.id });
	});

	it("reads `from` on rine_send, where it named the sender until the rename", async () => {
		const { ctx } = makeCtx([BOT, OPS]);

		await expect(
			rineSend.handler(ctx, {
				to: "someone@acme.rine.network",
				payload: { text: "hi" },
				from: "ghost",
			}),
		).rejects.toThrow(
			"No agent named 'ghost'. This org has more than one agent, so a call has to name one. Available agents:\n" +
				"  - bot (bot@acme.rine.network)\n" +
				"  - ops (ops@acme.rine.network)\n" +
				"Name one of them with the agent parameter, or set RINE_AGENT.",
		);
	});
});

describe("every spelling of the actor is looked up in this org's own agents", () => {
	// The actor slot takes three spellings and they now answer one question:
	// which of THIS org's agents is acting. A handle used to be sent to
	// WebFinger — "who owns this handle, anywhere" — so a miss blamed the
	// caller's infrastructure and a hit acted as a stranger's agent. There is
	// no WebFinger stub in this file, so a lookup that tried one would fail
	// loudly rather than pass quietly.
	it("acts as the agent a full handle names", async () => {
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineGroups.handler(ctx, { agent: "ops@acme.rine.network" });

		expect(sentHeaders(get)).toEqual({ "X-Rine-Agent": OPS.id });
	});

	it("acts as the agent a short-form handle names", async () => {
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineGroups.handler(ctx, { agent: "ops@acme" });

		expect(sentHeaders(get)).toEqual({ "X-Rine-Agent": OPS.id });
	});

	it("refuses an unknown handle by name, listing this org's agents", async () => {
		const { ctx } = makeCtx([BOT, OPS]);

		await expect(
			rineHookList.handler(ctx, { agent: "ghost@acme.rine.network" }),
		).rejects.toThrow(
			"No agent with handle 'ghost@acme.rine.network'. This org has more than one agent, so a call has to name one. Available agents:\n" +
				"  - bot (bot@acme.rine.network)\n" +
				"  - ops (ops@acme.rine.network)\n" +
				"Name one of them with the agent parameter, or set RINE_AGENT.",
		);
	});

	it("refuses a handle this org does not own rather than acting as it", async () => {
		const { ctx } = makeCtx([BOT, OPS]);

		await expect(
			rineHookList.handler(ctx, { agent: "someone@other-org.rine.network" }),
		).rejects.toThrow(
			"No agent with handle 'someone@other-org.rine.network'. This org has more than one agent, so a call has to name one. Available agents:",
		);
	});

	it("refuses an ambiguous bare name rather than picking one of them", async () => {
		const twin = {
			id: "33333333-3333-3333-3333-333333333333",
			name: "OPS",
			handle: "ops-2@acme.rine.network",
		};
		const { ctx } = makeCtx([BOT, OPS, twin]);

		await expect(rineHookList.handler(ctx, { agent: "ops" })).rejects.toThrow(
			"More than one agent is named 'ops'. Say which one is acting:\n" +
				"  - ops (ops@acme.rine.network)\n" +
				"  - OPS (ops-2@acme.rine.network)\n" +
				"A name is not unique in an org — name it by handle or UUID.",
		);
	});
});

describe("rung 3 — RINE_AGENT", () => {
	it("acts as the agent the environment names when the call names none", async () => {
		vi.stubEnv("RINE_AGENT", "ops");
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineHookList.handler(ctx, {});

		expect(get).toHaveBeenCalledWith(`/agents/${OPS.id}/funnel/hooks`);
	});

	it("loses silently to the actor the call names — a lower rung never refuses", async () => {
		vi.stubEnv("RINE_AGENT", "ops");
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineHookList.handler(ctx, { agent: "bot" });

		expect(get).toHaveBeenCalledWith(`/agents/${BOT.id}/funnel/hooks`);
	});

	it("gives a header-only verb the actor it would otherwise not resolve", async () => {
		vi.stubEnv("RINE_AGENT", "ops");
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineGroups.handler(ctx, {});

		expect(sentHeaders(get)).toEqual({ "X-Rine-Agent": OPS.id });
	});

	it("is absent, not empty, when it holds only whitespace", async () => {
		vi.stubEnv("RINE_AGENT", "   ");
		const { ctx } = makeCtx([BOT, OPS]);

		await expect(rineHookList.handler(ctx, {})).rejects.toThrow(
			"This org has more than one agent.",
		);
	});
});

describe("rungs 4 and 5 — the org's only agent, then a refusal", () => {
	it("acts as the org's only agent when nothing named one", async () => {
		const { ctx, get } = makeCtx([BOT]);

		await rineHookList.handler(ctx, {});

		expect(get).toHaveBeenCalledWith(`/agents/${BOT.id}/funnel/hooks`);
	});

	it("names every agent and how this surface chooses one", async () => {
		const { ctx } = makeCtx([BOT, OPS]);

		await expect(rineHookList.handler(ctx, {})).rejects.toThrow(
			"This org has more than one agent. Say which one is acting:\n" +
				"  - bot (bot@acme.rine.network)\n" +
				"  - ops (ops@acme.rine.network)\n" +
				"Name one of them with the agent parameter, or set RINE_AGENT.",
		);
	});

	it("stays lazy where only a header is at stake", async () => {
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineGroups.handler(ctx, {});

		expect(sentHeaders(get)).toEqual({});
		expect(get).not.toHaveBeenCalledWith("/agents");
	});
});

describe("a one-agent org acts on a value that named nobody", () => {
	// The measured defect: a model filled the optional actor slot with the
	// schema's own placeholder text and the call died locally, before the verb
	// it was asked for ever ran. On a one-agent org there is nothing to choose
	// between, so the call proceeds and the note says what was ignored.
	it("acts as the only agent and says so on the tool's own result", async () => {
		const { ctx, get } = makeCtx([BOT]);

		const result = await rineHookList.handler(ctx, { agent: "null" });

		expect(get).toHaveBeenCalledWith(`/agents/${BOT.id}/funnel/hooks`);
		expect(result).toMatchObject({
			warning:
				"Ignored agent 'null': this org has one agent, so " +
				"bot (bot@acme.rine.network) acted. Omit agent for a one-agent org.",
		});
	});

	it("stays silent when the value named that agent after all", async () => {
		const { ctx } = makeCtx([BOT]);

		const result = await rineHookList.handler(ctx, { agent: "bot" });

		expect(result).not.toHaveProperty("warning");
	});

	it("still refuses on a multi-agent org, where there is a choice to make", async () => {
		const { ctx } = makeCtx([BOT, OPS]);

		await expect(
			rineHookList.handler(ctx, { agent: "null" }),
		).rejects.toThrow("No agent named 'null'.");
	});

	it("never substitutes an agent for a UUID the caller supplied", async () => {
		// Rung 1 costs no lookup and a fallback here would be a silent identity
		// substitution — a bogus UUID still fails, at the server.
		const bogus = "99999999-9999-9999-9999-999999999999";
		const { ctx, get } = makeCtx([BOT]);

		await rineHookList.handler(ctx, { agent: bogus });

		expect(get).toHaveBeenCalledWith(`/agents/${bogus}/funnel/hooks`);
		expect(get).not.toHaveBeenCalledWith("/agents", undefined, undefined);
	});

	it("carries no note on the header-only rung, which has no result of ours", async () => {
		// The documented limit of this surface's channel: `actingHeaders` callers
		// return the server's response verbatim, so there is nothing of ours to
		// attach a key to. The fallback still happens — the header proves it.
		const { ctx, get } = makeCtx([BOT]);

		const result = await rineGroups.handler(ctx, { agent: "null" });

		expect(sentHeaders(get)).toEqual({ "X-Rine-Agent": BOT.id });
		expect(result).not.toHaveProperty("warning");
	});
});

describe("two spellings of one value must agree", () => {
	it("refuses two disagreeing spellings before a header exists", async () => {
		const { ctx, get } = makeCtx([BOT, OPS]);

		await expect(
			rineGroups.handler(ctx, { agent: "bot", as: "ops" }),
		).rejects.toThrow(
			"You named the acting agent twice: agent bot and as ops.\nName it once.",
		);
		expect(sentHeaders(get)).toBeUndefined();
	});

	it("refuses `agent` disagreeing with `from` on a send", async () => {
		const { ctx } = makeCtx([BOT, OPS]);

		await expect(
			rineSend.handler(ctx, {
				to: "someone@acme.rine.network",
				payload: { text: "hi" },
				agent: "bot",
				from: "ops",
			}),
		).rejects.toThrow(
			"You named the acting agent twice: agent bot and from ops",
		);
	});

	it("takes the same agent named twice, in either case", async () => {
		const { ctx, get } = makeCtx([BOT, OPS]);

		await rineGroups.handler(ctx, { agent: "ops", as: "OPS" });

		expect(sentHeaders(get)).toEqual({ "X-Rine-Agent": OPS.id });
	});
});

describe("a non-string actor is refused, not stringified", () => {
	it("refuses one on a group verb", async () => {
		const { ctx, get } = makeCtx([BOT, OPS]);

		await expect(rineGroups.handler(ctx, { agent: 42 })).rejects.toThrow(
			"The acting agent must be a name, handle or UUID (got number).",
		);
		expect(sentHeaders(get)).toBeUndefined();
	});

	it("refuses one on a messaging verb", async () => {
		const { ctx } = makeCtx([BOT]);

		await expect(rineInbox.handler(ctx, { agent: 42 })).rejects.toThrow(
			"The acting agent must be a name, handle or UUID (got number).",
		);
	});

	it("refuses one on a hook verb, naming the type it got", async () => {
		const { ctx } = makeCtx([BOT]);

		await expect(rineHookList.handler(ctx, { agent: {} })).rejects.toThrow(
			"The acting agent must be a name, handle or UUID (got object).",
		);
	});
});

describe("which spellings a tool reads its actor from", () => {
	// `from` named the sender on the two sends and on nothing else. The pairing
	// is what a wrapper asks before defaulting an actor in (rine-openclaw's
	// `channels.rine.agentId`), so it has to be derivable from the tool name and
	// not from the widest set any tool reads.
	it("reads `from` as an identity on the sends", () => {
		expect(actorKeysFor("rine_send")).toContain("from");
		expect(actorKeysFor("rine_send_and_wait")).toContain("from");
	});

	it("does not read `from` on a tool that never meant an identity by it", () => {
		for (const tool of ["rine_inbox", "rine_groups", "rine_thread"]) {
			expect(actorKeysFor(tool)).not.toContain("from");
			expect(namesActor({ from: "ops" }, actorKeysFor(tool))).toBe(false);
		}
		expect(namesActor({ from: "ops" }, actorKeysFor("rine_send"))).toBe(true);
	});

	it("reads the canonical and the retired spelling on every tool", () => {
		for (const tool of ["rine_send", "rine_inbox", "rine_groups"]) {
			expect(namesActor({ agent: "ops" }, actorKeysFor(tool))).toBe(true);
			expect(namesActor({ as: "ops" }, actorKeysFor(tool))).toBe(true);
			expect(namesActor({ agent: "  " }, actorKeysFor(tool))).toBe(false);
			expect(namesActor({}, actorKeysFor(tool))).toBe(false);
		}
	});
});

describe("the read a lazy-rung tool makes on its way to acting", () => {
	// `rine_reply` learns which agent it acts as from the message it
	// fetches, so its GET is made before anything is resolved from arguments —
	// but the delivery mark is per AGENT, and the server marks the row of the
	// agent the header names. A host that named an agent has to have that
	// reach the read, or answering a message never marks it read.
	const MESSAGE_ID = "33333333-3333-3333-3333-333333333333";

	it("carries the environment's agent on the GET of the original", async () => {
		vi.stubEnv("RINE_AGENT", "ops");
		const { ctx, get } = makeCtx([BOT, OPS]);

		// The stub answers with no message at all, so the handler stops one step
		// AFTER the read this test is about.
		await expect(
			rineReply.handler(ctx, { message_id: MESSAGE_ID, payload: {} }),
		).rejects.toThrow("Cannot determine recipient");

		const read = get.mock.calls.find((c) => c[0] === `/messages/${MESSAGE_ID}`);
		expect(read?.[2]).toEqual({ "X-Rine-Agent": OPS.id });
	});

	it("stays header-less when nobody named an agent, rather than refusing", async () => {
		// The lazy half of the same rung: a multi-agent org that named nobody is
		// not asked to choose, because the server does not require the header
		// here. The cost is a read that marks nothing, which is the ratified
		// fail-closed direction.
		const { ctx, get } = makeCtx([BOT, OPS]);

		await expect(
			rineReply.handler(ctx, { message_id: MESSAGE_ID, payload: {} }),
		).rejects.toThrow("Cannot determine recipient");

		const read = get.mock.calls.find((c) => c[0] === `/messages/${MESSAGE_ID}`);
		expect(read?.[2]).toEqual({});
	});
});
