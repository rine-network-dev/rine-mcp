/**
 * What a bare-name send costs, counted in requests.
 *
 * 🔴 **Nothing else on this surface counts requests, and that is why the double
 * read shipped.** `ResolveOptions.agents` existed and had no caller
 * on either stack, so every bare-name send bought the same org-scoped
 * `GET /agents` twice — once for the acting agent, once inside
 * `refuseIfABareAgentName`'s collision guard, `fetchAgents` being uncached by
 * design. Both suites were green throughout: a duplicate read changes no
 * sentence, no record and no wire byte.
 *
 * So this file drives the REAL core — no `vi.mock` of the resolvers, which is
 * the whole point — with a client that records every path, and pins the
 * sequence. It asserts the refusals too: an economy that bought itself by
 * skipping the collision guard would be a silent misdelivery, not a saving.
 */

import { NEITHER_NAMESPACE_LEAD } from "@rine-network/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolDef } from "../../src/tools/types.js";

const { messagingTools } = await import("../../src/tools/messaging.js");
const { messagingSyncTools } = await import("../../src/tools/messaging-sync.js");

const rineSend = messagingTools.find((t) => t.name === "rine_send")!;
const rineSendAndWait = messagingSyncTools.find(
	(t) => t.name === "rine_send_and_wait",
)!;

const ALPHA_ID = "11111111-1111-4111-8111-111111111111";
const BETA_ID = "22222222-2222-4222-8222-222222222222";

const AGENTS = [
	{ id: ALPHA_ID, name: "alpha", handle: "alpha@acme.rine.network" },
	{ id: BETA_ID, name: "beta", handle: "beta@acme.rine.network" },
];

const OPS_GROUP = {
	id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	handle: "#ops@acme.rine.network",
	name: "ops",
};

/**
 * A client that answers the two org-scoped list routes and records the order.
 *
 * Anything else throws rather than answering `{}`: this file measures how many
 * requests a resolve makes, so a route nobody registered must announce itself
 * instead of being absorbed into a truthy answer.
 */
function recordingCtx(): { ctx: ToolContext; paths: string[] } {
	const paths: string[] = [];
	const get = vi.fn(async (path: string) => {
		paths.push(path);
		if (path.startsWith("/agents")) return { items: AGENTS };
		if (path.startsWith("/groups")) return { items: [OPS_GROUP] };
		throw new Error(`unregistered route ${path}`);
	});
	return {
		ctx: {
			client: { get, post: vi.fn() } as never,
			configDir: "/tmp/rine-mcp-agent-page",
			apiUrl: "https://api.test",
		},
		paths,
	};
}

/** The handler's refusal, so a test that resolves instead of refusing fails. */
async function refusalOf(
	tool: ToolDef,
	ctx: ToolContext,
	params: Record<string, unknown>,
): Promise<string> {
	try {
		await tool.handler(ctx, params);
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error("expected a refusal");
}

describe("the agent page a bare-name send pays for", () => {
	beforeEach(() => {
		delete process.env.RINE_AGENT;
	});

	it("reads /agents once, not twice, when a bare name names no group", async () => {
		const { ctx, paths } = recordingCtx();
		const refusal = await refusalOf(rineSend, ctx, {
			to: "kofi",
			payload: { text: "hi" },
			agent: "alpha",
		});
		expect(refusal).toContain(`'kofi' ${NEITHER_NAMESPACE_LEAD}`);
		expect(paths).toEqual(["/agents", "/groups"]);
	});

	it("reads /agents once when the bare name IS a group", async () => {
		// Measured on the waiting verb because it stops at the resolved group
		// rather than going on to seal — the resolution prefix is the same one
		// `rine_send` climbs, and it is the prefix this item is about.
		const { ctx, paths } = recordingCtx();
		const refusal = await refusalOf(rineSendAndWait, ctx, {
			to: "ops",
			payload: { text: "hi" },
			agent: "alpha",
		});
		expect(refusal).toContain("refuses the group #ops@acme.rine.network");
		expect(paths).toEqual(["/agents", "/groups"]);
	});

	it("keeps the fallback, and pays two requests for it rather than three", async () => {
		// The fallback has two halves: the sentence and its cost. The route runs
		// the group ladder FIRST, so a bare miss on the 1:1 verb answers in the
		// agent namespace only after the ladder has spoken. That is one `/groups`
		// this verb cannot avoid; the second `/agents` was never anything but
		// waste.
		const { ctx, paths } = recordingCtx();
		const refusal = await refusalOf(rineSendAndWait, ctx, {
			to: "kofi",
			payload: { text: "hi" },
			agent: "alpha",
		});
		expect(refusal).toContain("Invalid agent identifier 'kofi'");
		expect(paths).toEqual(["/agents", "/groups"]);
	});

	it("still buys the page when the actor was spelled as a UUID", async () => {
		// 🔴 The rung that reads no roster hands none on, so the collision guard
		// fetches for itself. Skipping the guard here would let `send('ops')`
		// meaning `ops@acme` post to a group called `ops` — the misdelivery the
		// guard exists for — and it would read as a saving in this very file.
		const { ctx, paths } = recordingCtx();
		const refusal = await refusalOf(rineSend, ctx, {
			to: "kofi",
			payload: { text: "hi" },
			agent: ALPHA_ID,
		});
		expect(refusal).toContain(`'kofi' ${NEITHER_NAMESPACE_LEAD}`);
		expect(paths).toEqual(["/agents", "/groups"]);
	});

	it("refuses a bare name that is one of the agents on the handed-over page", async () => {
		// The guard reading a handed-over list must refuse exactly what a guard
		// reading its own fetch would, and name the handle that DMs that agent.
		const { ctx, paths } = recordingCtx();
		const refusal = await refusalOf(rineSend, ctx, {
			to: "beta",
			payload: { text: "hi" },
			agent: "alpha",
		});
		expect(refusal).toContain("beta@acme.rine.network");
		// It refused off that page: no second `/agents`, and no `/groups` either,
		// because the guard stands in front of the ladder.
		expect(paths).toEqual(["/agents"]);
	});
});
