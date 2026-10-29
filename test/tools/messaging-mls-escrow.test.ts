// `rine_send` into an MLS-latched group hands the seal-and-post to rine-core.
//
// The escrow ordering (drain before encrypt), the single `escrow_missing`
// retry with the same fingerprint and the scoped Welcome recovery are core's
// contract and are tested in rine-core's `mls-group-send.test.ts`. What this
// file pins is the MCP side of that seam: which actor, group and payload the
// tool passes, and that the post it supplies carries the tool's own fields next
// to the sealed ones.

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_HANDLE = "#dev@acme.rine.network";
const ESCROW_FP = "ZmFrZS1mcA";

const mockSealAndPost = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveActor: vi.fn(async () => ({ agentId: AGENT_ID })),
		normalizeHandle: (h: string) => h,
		sealAndPostMlsGroupMessage: (...a: unknown[]) => mockSealAndPost(...a),
		// The real guard opens the native MLS store; the send predicate is what
		// this file exercises, so the guard is a pass-through here.
		assertNoMlsDowngrade: () => {},
	};
});

const core = await import("@rine-network/core");
const { messagingTools } = await import("../../src/tools/messaging.js");
const rineSend = messagingTools.find((t) => t.name === "rine_send")!;

function makeCtx(configDir: string): ToolContext {
	const group = {
		id: GROUP_ID,
		handle: GROUP_HANDLE,
		mls_group_id: "opaque-latch",
		mls_pending: false,
	};
	const client = {
		get: vi.fn(async () => ({ items: [group] })),
		post: vi.fn(async () => ({ id: "msg-1" })),
	};
	return { client, configDir, apiUrl: "https://api.test" } as never;
}

function send(ctx: ToolContext): Promise<unknown> {
	return rineSend.handler(ctx, { to: GROUP_HANDLE, payload: { text: "hi" } });
}

/** The body of the `n`th `/messages` post. */
function postBody(ctx: ToolContext, n: number): Record<string, unknown> {
	return ctx.client.post.mock.calls[n]?.[1] as Record<string, unknown>;
}

let configDir: string;

beforeEach(() => {
	configDir = fs.mkdtempSync(join(os.tmpdir(), "rine-mcp-mls-escrow-"));
	mockSealAndPost.mockReset();
	mockSealAndPost.mockImplementation(
		async (
			_actor: unknown,
			_groupId: string,
			_payload: unknown,
			post: (fields: object) => Promise<unknown>,
		) =>
			post({
				encrypted_payload: "enc-mls",
				encryption_version: "mls-v1",
				escrow_fp: ESCROW_FP,
			}),
	);
});

describe("rine_send — an MLS group send goes through the core seal-and-post", () => {
	it("send_when_group_is_mls_passes_actor_group_and_payload_to_core", async () => {
		const ctx = makeCtx(configDir);

		await send(ctx);

		expect(mockSealAndPost).toHaveBeenCalledTimes(1);
		const [actor, groupId, payload] = mockSealAndPost.mock.calls[0]!;
		expect(actor).toMatchObject({ configDir, agentId: AGENT_ID, client: ctx.client });
		expect(groupId).toBe(GROUP_ID);
		expect(payload).toEqual({ text: "hi" });
	});

	it("send_when_group_is_mls_posts_the_sealed_fields_with_the_tools_own", async () => {
		const ctx = makeCtx(configDir);

		await send(ctx);

		expect(postBody(ctx, 0)).toMatchObject({
			to_handle: GROUP_HANDLE,
			type: "rine.v1.dm",
			encryption_version: "mls-v1",
			escrow_fp: ESCROW_FP,
		});
	});

	it("send_when_core_refuses_then_nothing_is_posted_and_the_error_propagates", async () => {
		const ctx = makeCtx(configDir);
		mockSealAndPost.mockRejectedValue(
			new core.EscrowGapError(GROUP_ID, 3, "no_escrow" as never),
		);

		const err = await send(ctx).catch((e: unknown) => e);

		expect((err as Error).name).toBe("EscrowGapError");
		expect(ctx.client.post).not.toHaveBeenCalled();
	});
});
