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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const mockEncryptMlsGroupMessage = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveActor: vi.fn(async () => ({ agentId: AGENT_ID })),
		normalizeHandle: (h: string) => h,
		processMlsWelcomes: vi.fn(async () => undefined),
		syncMlsGroup: vi.fn(async () => undefined),
		getOrCreateSenderKey: (...a: unknown[]) => mockGetOrCreateSenderKey(...a),
		encryptGroupMessage: (...a: unknown[]) => mockEncryptGroupMessage(...a),
		encryptMlsGroupMessage: (...a: unknown[]) =>
			mockEncryptMlsGroupMessage(...a),
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
	mockEncryptMlsGroupMessage.mockReset();
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
	mockEncryptMlsGroupMessage.mockResolvedValue({
		encrypted_payload: "enc-mls",
		encryption_version: "mls-v1",
	});
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

		expect(mockEncryptMlsGroupMessage).toHaveBeenCalledTimes(1);
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
/**
 * The send path's MLS recovery asks about the group it is sending to.
 *
 * The second `processMlsWelcomes` in `encryptMlsWithRecovery` is UNCAUGHT,
 * unlike the pre-sync above it, so whatever refusal that pass raises aborts the
 * send. Left unscoped a pass answers with the first refusal whose bytes arrived
 * in it — and the server picks that order by picking the order of its own
 * welcomes response — so a substituted Welcome for an unrelated group would
 * abort a send that has nothing to do with it. This is the widest surface of
 * the three: OpenClaw inherits it.
 *
 * The mock below is rine-core's own `pickRefusal` rule (`mls-ops-join.ts`):
 * scoped, the named group's refusal; unscoped, the first in the server's order.
 * That rule is measured faithful against the real native core.
 *
 * The Python twin already scopes this path through `install_mls_state`
 * (`_mls/join.py`), so this closes a gap between the two stacks.
 */
describe("rine_send — the MLS recovery scopes its Welcome pass", () => {
	const OTHER_GROUP_ID = "66666666-6666-6666-6666-666666666666";
	// `core` is a value binding from `await import(...)`, so its classes are not
	// usable in type position without this. (This file is outside tsconfig's
	// `include`, so tsc would not have caught it.)
	type Refusal = InstanceType<typeof core.MlsWelcomeRefusedError>;

	/** The refusal the group substitution guard mints, as a pass raises it. */
	function refusal(groupId: string): Refusal {
		return new core.MlsWelcomeRefusedError(
			groupId,
			"roster_uncorroborated",
			`Refusing the MLS welcome for group ${groupId}`,
		);
	}

	/** rine-core's `pickRefusal`, over a batch in the server's chosen order. */
	function serverOrders(...batch: Refusal[]) {
		return async (
			_configDir: string,
			_agentId: string,
			_client: unknown,
			opts?: { forGroup?: string },
		) => {
			const chosen = opts?.forGroup
				? batch.find((r) => r.groupId === opts.forGroup)
				: batch[0];
			if (chosen) throw chosen;
			return { processed: 0, groupIds: [] };
		};
	}

	beforeEach(() => {
		// Nothing in this file clears the factory mocks, so calls accumulate across
		// tests — and this describe asserts on a call INDEX.
		vi.mocked(core.processMlsWelcomes).mockClear();
		// The recovery arm runs only when the first encrypt reports no local state.
		mockEncryptMlsGroupMessage.mockRejectedValueOnce(
			core.noMlsStateError(GROUP_ID),
		);
	});

	afterEach(() => {
		// This mock comes from the module factory and nothing else resets it, so an
		// implementation set here would otherwise outlive its own test.
		vi.mocked(core.processMlsWelcomes).mockImplementation(
			async () => undefined as never,
		);
	});

	it("send_when_recovering_and_another_groups_welcome_is_refused_then_the_send_still_lands", async () => {
		vi.mocked(core.processMlsWelcomes).mockImplementation(
			serverOrders(refusal(OTHER_GROUP_ID)) as never,
		);
		const ctx = makeCtx(makeGroup({ mls_group_id: "opaque-latch" }));

		await send(ctx);

		expect(ctx.client.post).toHaveBeenCalledTimes(1);
		expect(mockEncryptMlsGroupMessage).toHaveBeenCalledTimes(2);
	});

	it("send_when_recovering_and_this_groups_welcome_is_refused_then_the_send_fails", async () => {
		// The decoy is FIRST in the server's order, so an unscoped pass answers
		// with it and this group's refusal never reaches the caller.
		vi.mocked(core.processMlsWelcomes).mockImplementation(
			serverOrders(refusal(OTHER_GROUP_ID), refusal(GROUP_ID)) as never,
		);
		const ctx = makeCtx(makeGroup({ mls_group_id: "opaque-latch" }));

		const err = await send(ctx).catch((e: unknown) => e);

		expect(core.isMlsWelcomeRefusedError(err)).toBe(true);
		expect((err as Refusal).groupId).toBe(GROUP_ID);
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("send_when_recovering_names_the_group_being_sent_to", async () => {
		const ctx = makeCtx(makeGroup({ mls_group_id: "opaque-latch" }));

		await send(ctx);

		// Two passes run: the pre-sync, deliberately unscoped because it is caught,
		// and the recovery, which is not caught and must name this group.
		expect(vi.mocked(core.processMlsWelcomes).mock.calls[1]?.[3]).toEqual({
			forGroup: GROUP_ID,
		});
	});
});
