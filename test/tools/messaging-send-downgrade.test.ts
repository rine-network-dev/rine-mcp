// `rine_send` into a group refuses a downgrade.
//
// This is the widest surface the guard has to hold on: OpenClaw inherits these
// tools, so a guard absent here is a guard absent from every OpenClaw agent
// too.
//
// The guard sits between the group resolve and the encryption branch, and the
// placement is the whole requirement: `getOrCreateSenderKey` fans this agent's
// sender key out to whatever membership the server returns, so by the time the
// sender-key branch has run the key is already gone. Every refusal test
// therefore asserts the typed error AND that `getOrCreateSenderKey` was never
// reached — the second assertion is the one that means something.
//
// `assertNoMlsDowngrade` is substituted with the same decision over an
// in-memory set of "groups this agent holds state for", because the real one
// opens the native MLS store. It throws the real `MlsDowngradeError`, and the
// arguments it was handed are asserted, so the call site's contract is pinned
// rather than assumed. The guard's own truth table is proven in
// `rine-core/test/crypto/mls-downgrade.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_HANDLE = "#dev@acme.rine.network";
const CONFIG_DIR = "/tmp/test-rine-mcp-downgrade";

/** Groups this agent is pretending to hold local MLS state for. */
const localMlsState = new Set<string>();

interface GuardCall {
	configDir: string;
	agentId: string;
	groupId: string;
	serverSaysMls: boolean;
}
const guardCalls: GuardCall[] = [];

const mockGetOrCreateSenderKey = vi.fn();
const mockEncryptGroupMessage = vi.fn();
const mockSealAndPost = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveActor: vi.fn(async () => ({ agentId: AGENT_ID })),
		normalizeHandle: (h: string) => h,
		getOrCreateSenderKey: (...a: unknown[]) => mockGetOrCreateSenderKey(...a),
		encryptGroupMessage: (...a: unknown[]) => mockEncryptGroupMessage(...a),
		sealAndPostMlsGroupMessage: (...a: unknown[]) => mockSealAndPost(...a),
		assertNoMlsDowngrade: (
			configDir: string,
			agentId: string,
			groupId: string,
			serverSaysMls: boolean,
		) => {
			guardCalls.push({ configDir, agentId, groupId, serverSaysMls });
			if (serverSaysMls) return;
			if (!localMlsState.has(groupId)) return;
			throw new orig.MlsDowngradeError(groupId);
		},
	};
});

const core = await import("@rine-network/core");
const { messagingTools } = await import("../../src/tools/messaging.js");
const rineSend = messagingTools.find((t) => t.name === "rine_send")!;

function makeCtx(group: Record<string, unknown>): ToolContext {
	return {
		client: {
			get: vi.fn(async () => ({ items: [group] })),
			post: vi.fn(async () => ({ id: "msg-1" })),
		},
		configDir: CONFIG_DIR,
		apiUrl: "https://api.test",
	} as never;
}

function makeGroup(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return { id: GROUP_ID, mls_group_id: null, mls_pending: false, ...over };
}

function send(ctx: ToolContext): Promise<unknown> {
	return rineSend.handler(ctx, { to: GROUP_HANDLE, payload: { text: "hi" } });
}

beforeEach(() => {
	localMlsState.clear();
	guardCalls.length = 0;
	mockGetOrCreateSenderKey.mockReset();
	mockEncryptGroupMessage.mockReset();
	mockSealAndPost.mockReset();
	mockGetOrCreateSenderKey.mockResolvedValue({
		state: {},
		groupId: GROUP_ID,
	});
	mockEncryptGroupMessage.mockResolvedValue({
		result: {
			encrypted_payload: "enc-group",
			encryption_version: "sender-key-v1",
		},
	});
	mockSealAndPost.mockResolvedValue({ id: "msg-mls" });
});

describe("rine_send — a group send refuses a downgrade", () => {
	it("send_when_server_contradicts_local_mls_state_refuses", async () => {
		localMlsState.add(GROUP_ID);
		const ctx = makeCtx(makeGroup());

		const err = await send(ctx).catch((e: unknown) => e);

		expect(core.isMlsDowngradeError(err)).toBe(true);
		expect((err as { code: string }).code).toBe(core.DOWNGRADE_REFUSED_CODE);
	});

	it("send_when_server_contradicts_local_mls_state_never_makes_a_sender_key", async () => {
		localMlsState.add(GROUP_ID);
		const ctx = makeCtx(makeGroup());

		await expect(send(ctx)).rejects.toThrow();

		expect(mockGetOrCreateSenderKey).not.toHaveBeenCalled();
		expect(mockEncryptGroupMessage).not.toHaveBeenCalled();
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("send_when_refused_does_not_retry_as_sender_key", async () => {
		localMlsState.add(GROUP_ID);
		const ctx = makeCtx(makeGroup());

		await expect(send(ctx)).rejects.toThrow();
		await expect(send(ctx)).rejects.toThrow();

		expect(mockGetOrCreateSenderKey).not.toHaveBeenCalled();
	});

	it("send_when_guarding_passes_the_config_dir_agent_and_group_uuid", async () => {
		const ctx = makeCtx(makeGroup());

		await send(ctx);

		expect(guardCalls).toEqual([
			{
				configDir: CONFIG_DIR,
				agentId: AGENT_ID,
				groupId: GROUP_ID,
				serverSaysMls: false,
			},
		]);
	});

	it("send_when_billboard_group_has_no_mls_state_still_uses_sender_keys", async () => {
		const ctx = makeCtx(makeGroup());

		await send(ctx);

		expect(mockGetOrCreateSenderKey).toHaveBeenCalledTimes(1);
		expect(ctx.client.post).toHaveBeenCalledTimes(1);
	});
});

describe("rine_send — the branch is the send predicate", () => {
	it("send_when_group_is_mls_latched_takes_the_mls_branch", async () => {
		const ctx = makeCtx(makeGroup({ mls_group_id: "opaque-latch" }));

		await send(ctx);

		expect(mockSealAndPost).toHaveBeenCalledTimes(1);
		expect(mockGetOrCreateSenderKey).not.toHaveBeenCalled();
		expect(guardCalls[0]?.serverSaysMls).toBe(true);
	});

	it("send_when_init_is_pending_never_makes_a_sender_key", async () => {
		const ctx = makeCtx(makeGroup({ mls_pending: true }));

		await expect(send(ctx)).rejects.toThrow();

		expect(mockGetOrCreateSenderKey).not.toHaveBeenCalled();
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("send_when_init_is_pending_refuses_with_the_stable_code", async () => {
		// The code is the caller's handle on this refusal; the message is for the
		// operator (and the model) reading it, and naming the self-clear window
		// is its job.
		const ctx = makeCtx(makeGroup({ mls_pending: true }));

		const err = await send(ctx).catch((e: unknown) => e);

		expect(core.isMlsInitInFlightError(err)).toBe(true);
		expect((err as { code: string }).code).toBe(core.MLS_INIT_IN_FLIGHT_CODE);
		const minutes = Math.round(core.MLS_PENDING_SELF_CLEAR_SECONDS / 60);
		expect((err as Error).message).toContain(`${minutes} minutes`);
	});

	it("send_when_init_is_pending_tells_the_guard_the_group_is_mls", async () => {
		// The guard's input is the SEND predicate. Reading `mls_group_id` alone
		// here would ask the guard the render question and refuse a member who
		// legitimately holds state for a group mid-init.
		const ctx = makeCtx(makeGroup({ mls_pending: true }));

		await expect(send(ctx)).rejects.toThrow();

		expect(guardCalls[0]?.serverSaysMls).toBe(true);
	});
});
