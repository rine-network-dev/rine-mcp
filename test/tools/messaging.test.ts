import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageRead, RecipientTarget } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import { keysGet, publishedKeys, seedAgentKeys } from "@rine-network/core/testing";

const mockResolveRecipient = vi.fn();
const mockResolveActor = vi.fn();
const mockSealForAgent = vi.fn();
const mockEncryptGroupMessage = vi.fn();
const mockGetOrCreateSenderKey = vi.fn();
const mockAgentKeysExist = vi.fn();
const mockSealAndPost = vi.fn();
// The downgrade guard reads real local MLS state off disk. These tests pin the
// tool surface, not the guard (`messaging-send-downgrade.test.ts` does that),
// and run against a throwaway config dir with no MLS store.
const mockAssertNoMlsDowngrade = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveRecipient: (...args: unknown[]) => mockResolveRecipient(...args),
		resolveActor: (...args: unknown[]) => mockResolveActor(...args),
		sealForAgent: (...args: unknown[]) => mockSealForAgent(...args),
		encryptGroupMessage: (...args: unknown[]) =>
			mockEncryptGroupMessage(...args),
		getOrCreateSenderKey: (...args: unknown[]) =>
			mockGetOrCreateSenderKey(...args),
		agentKeysExist: (...args: unknown[]) => mockAgentKeysExist(...args),
		assertNoMlsDowngrade: (...args: unknown[]) =>
			mockAssertNoMlsDowngrade(...args),
		sealAndPostMlsGroupMessage: (...args: unknown[]) =>
			mockSealAndPost(...args),
	};
});

// The real (un-mocked) core, used by the hybrid-path tests below to drive the
// genuine encrypt/decrypt code rather than the vi.fn() stubs.
const realCore =
	await vi.importActual<typeof import("@rine-network/core")>(
		"@rine-network/core",
	);
const {
	agentKeysExist: realAgentKeysExist,
	encryptGroupMessage: realEncryptGroupMessage,
	encryptMessage: realEncryptMessage,
	fetchRecipientKeys: realFetchRecipientKeys,
	generateSenderKey,
	saveSenderKeyState,
	sealForAgent: realSealForAgent,
} = realCore;
const {
	SENDER_KEY_NOT_RECOVERED_PREVIEW,
	SENDER_KEY_UNAVAILABLE_CODE,
	SENDER_KEY_UNAVAILABLE_PREVIEW,
} = realCore;

const { messagingTools } = await import("../../src/tools/messaging.js");
// `rine_inbox`/`rine_read`, `rine_reply` and `rine_thread` each register from
// their own module, which is what makes them visible to the shipped-surface
// gate — `messagingTools` carries only `rine_send`, so each is imported from
// where it lives.
const { inboxTools } = await import("../../src/tools/messaging-inbox.js");
const { replyTools } = await import("../../src/tools/messaging-reply.js");
const { rineThread } = await import("../../src/tools/messaging-thread.js");

const rineSend = messagingTools.find((t) => t.name === "rine_send")!;
const rineInbox = inboxTools.find((t) => t.name === "rine_inbox")!;
const rineRead = inboxTools.find((t) => t.name === "rine_read")!;
const rineReply = replyTools.find((t) => t.name === "rine_reply")!;

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: "/tmp/test",
		ownerDir: "/tmp/test-owner",
		apiUrl: "https://api.test",
		refreshIdentity: vi.fn(),
	};
}

/**
 * The recipient ladder, answering for real unless a test says otherwise.
 *
 * The ladder itself is `rine-core`'s and is gated there; what these tests pin is
 * what `rine_send` HANDS it and what it does with the answer. So the default
 * delegates to the genuine `resolveRecipient`, which keeps every group case
 * below driving the real rungs through `ctx.client.get` — the fabricated-org
 * fallback included. Only the 1:1 cases override it: their arm ends in a
 * WebFinger request that no `ctx.client` mock can reach, because the ladder
 * calls the
 * agent resolver inside `rine-core`'s own bundle rather than through this
 * module's imports.
 */
function ladderAnswersForReal(): void {
	mockResolveRecipient
		.mockReset()
		.mockImplementation(
			(...args: Parameters<typeof realCore.resolveRecipient>) =>
				realCore.resolveRecipient(...args),
		);
}

/** The record the ladder answers a 1:1 recipient with. */
function agentTarget(id: string, spelling: string): RecipientTarget {
	return {
		kind: "agent",
		id,
		handle: spelling.includes("@") ? spelling : undefined,
		spelling,
		row: undefined,
	};
}

/** A group's own id, as a caller who believed it named an agent would type it. */
const GROUP_UUID = "44444444-4444-4444-4444-444444444444";

/** The spelling `rine_send` handed the ladder on its first call. */
function ladderWasAsked(): string {
	return mockResolveRecipient.mock.calls[0]![2] as string;
}

describe("rine_send — short-handle normalization", () => {
	beforeEach(() => {
		ladderAnswersForReal();
		mockResolveActor.mockReset();
		mockSealForAgent.mockReset();
		mockEncryptGroupMessage.mockReset();
		mockGetOrCreateSenderKey.mockReset();
		mockAgentKeysExist.mockReset();
		mockSealAndPost.mockReset();
	});

	it("group with non-null mls_group_id routes through MLS encrypt, not sender keys", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		// mls_group_id is a non-null opaque latch → MLS path. group.id is the state key.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			items: [
				{
					id: "group-uuid",
					handle: "#dev@acmecorp.rine.network",
					mls_group_id: "opaque-mls-latch",
				},
			],
		});
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
					escrow_fp: "ZmFrZS1mcA",
				}),
		);
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-mls",
		});

		await rineSend.handler(ctx, {
			to: "#dev@acmecorp",
			payload: { text: "hi" },
		});

		// The seal is keyed by the rine group UUID (group.id), never the latch.
		expect(mockSealAndPost).toHaveBeenCalledWith(
			{ configDir: ctx.configDir, agentId: "sender-uuid", client: ctx.client },
			"group-uuid",
			{ text: "hi" },
			expect.any(Function),
		);
		expect(mockGetOrCreateSenderKey).not.toHaveBeenCalled();

		const postBody = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(postBody.encryption_version).toBe("mls-v1");
		expect(postBody.escrow_fp).toBe("ZmFrZS1mcA");
		expect(postBody.to_handle).toBe("#dev@acmecorp.rine.network");
	});

	it("short agent handle is normalized before the recipient ladder sees it", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		mockResolveRecipient.mockResolvedValue(
			agentTarget("recipient-uuid", "alice@acmecorp.rine.network"),
		);
		mockSealForAgent.mockResolvedValue({
			encrypted_payload: "enc",
			encryption_version: "hpke-hybrid-v2",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-1",
		});

		await rineSend.handler(ctx, {
			to: "alice@acmecorp",
			payload: { text: "hello" },
		});

		expect(ladderWasAsked()).toBe("alice@acmecorp.rine.network");
	});

	it("full agent handle passes through unchanged", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		mockResolveRecipient.mockResolvedValue(
			agentTarget("recipient-uuid", "alice@acmecorp.rine.network"),
		);
		mockSealForAgent.mockResolvedValue({
			encrypted_payload: "enc",
			encryption_version: "hpke-hybrid-v2",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-1",
		});

		await rineSend.handler(ctx, {
			to: "alice@acmecorp.rine.network",
			payload: { text: "hello" },
		});

		expect(ladderWasAsked()).toBe("alice@acmecorp.rine.network");
	});

	it("short group handle is normalized before getOrCreateSenderKey", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		// Group lookup resolves to a non-MLS group → sender-key path.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			items: [{ id: "group-uuid", handle: "#dev@acmecorp.rine.network", mls_group_id: null }],
		});
		mockGetOrCreateSenderKey.mockResolvedValue({
			state: {},
			groupId: "group-uuid",
		});
		mockEncryptGroupMessage.mockResolvedValue({
			result: {
				encrypted_payload: "enc-group",
				encryption_version: "sender-key-v1",
			},
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-2",
		});

		await rineSend.handler(ctx, {
			to: "#dev@acmecorp",
			payload: { text: "hello group" },
		});

		expect(
			(ctx.client.get as ReturnType<typeof vi.fn>).mock.calls[0]![1],
		).toEqual({ handle: "#dev@acmecorp.rine.network" });

		const gocskCall = mockGetOrCreateSenderKey.mock.calls[0];
		// getOrCreateSenderKey(client, configDir, agentId, handle, extraHeaders)
		// — the row's handle, never the caller's spelling.
		const handleArg = gocskCall![3];
		expect(handleArg).toBe("#dev@acmecorp.rine.network");

		const postCall = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const postBody = postCall![1] as Record<string, unknown>;
		expect(postBody.to_handle).toBe("#dev@acmecorp.rine.network");
	});

	it("full group handle passes through unchanged", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		// Group lookup resolves to a non-MLS group → sender-key path.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			items: [{ id: "group-uuid", handle: "#dev@acmecorp.rine.network", mls_group_id: null }],
		});
		mockGetOrCreateSenderKey.mockResolvedValue({
			state: {},
			groupId: "group-uuid",
		});
		mockEncryptGroupMessage.mockResolvedValue({
			result: {
				encrypted_payload: "enc-group",
				encryption_version: "sender-key-v1",
			},
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-3",
		});

		await rineSend.handler(ctx, {
			to: "#dev@acmecorp.rine.network",
			payload: { text: "hello" },
		});

		const gocskCall = mockGetOrCreateSenderKey.mock.calls[0];
		const handleArg = gocskCall![3];
		expect(handleArg).toBe("#dev@acmecorp.rine.network");
	});

	// 🔴 No silent acceptance, on the surface whose caller is a model. The id
	// rung reads the GROUP namespace first, so a UUID copied out of the wrong
	// column no longer answers `Agent not found` — it seals under the group's key
	// and every org seated in that group reads the message. STDERR is the host's
	// log file here, so the only channel the model can see is the tool result.
	it("tells the caller a group ID went to a group, on the tool result", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		// The id rung's own route, and it answers for the row it was asked about:
		// `readableGroupById` refuses a server naming a different id.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: GROUP_UUID,
			handle: "#dev@acmecorp.rine.network",
			mls_group_id: null,
		});
		mockGetOrCreateSenderKey.mockResolvedValue({
			state: {},
			groupId: GROUP_UUID,
		});
		mockEncryptGroupMessage.mockResolvedValue({
			result: {
				encrypted_payload: "enc-group",
				encryption_version: "sender-key-v1",
			},
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-id-recipient",
		});

		const result = (await rineSend.handler(ctx, {
			to: GROUP_UUID,
			payload: { text: "meant for one agent" },
		})) as Record<string, unknown>;

		// The server's own answer is still there in full — the notice is spread
		// onto it, never a wrapper that hides the row a model came for.
		expect(result.id).toBe("msg-id-recipient");
		const note = String(result.group_recipient);
		// The caller's spelling and the handle the wire carried, and nothing else:
		// a third handle or an `@org` slot would be a placeholder in a sentence
		// about a real send.
		expect(note).toContain(`'${GROUP_UUID}'`);
		expect(note).toContain("#dev@acmecorp.rine.network");
	});

	// The other half, and why the notice asks the reference CLASS instead of
	// comparing the spelling with the handle. Both spellings below are this
	// tool's own documented ways of naming a group, and the BARE one is what
	// makes the difference measurable here: `#dev@acmecorp` is completed by
	// `normalizeHandle` before the ladder ever classifies it, so by the time a
	// record exists its spelling already equals the handle — a string comparison
	// would look correct on it. `dev` is never completed, so a notice keyed on
	// `handle !== spelling` would ride every bare group send.
	it.each(["#dev@acmecorp", "dev"])(
		"says nothing when the group was named as a group (%s)",
		async (spelling) => {
			const ctx = makeCtx();
			mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
			// The bare rung asks two routes, and they must answer differently: the
			// collision guard reads `GET /agents` and refuses a bare name that is
			// an AGENT's, so answering it with the group list would refuse `dev`
			// before any group ladder ran.
			(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
				async (path: string) =>
					path.startsWith("/agents")
						? { items: [] }
						: {
								items: [
									{
										id: "group-uuid",
										name: "dev",
										handle: "#dev@acmecorp.rine.network",
										mls_group_id: null,
									},
								],
							},
			);
			mockGetOrCreateSenderKey.mockResolvedValue({
				state: {},
				groupId: "group-uuid",
			});
			mockEncryptGroupMessage.mockResolvedValue({
				result: {
					encrypted_payload: "enc-group",
					encryption_version: "sender-key-v1",
				},
			});
			(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: "msg-plain-group",
			});

			const result = (await rineSend.handler(ctx, {
				to: spelling,
				payload: { text: "hello group" },
			})) as Record<string, unknown>;

			expect(result).toEqual({ id: "msg-plain-group" });
		},
	);

	it("recovers a group handle whose org half names nothing, and posts to the one that exists", async () => {
		// 🔴 On the verb the measurement was taken from. `rine_send` is where
		// every hallucinated-handle QoL failure died: the model composed the org
		// half out of the shipped doc examples while the group it had just been
		// given carried a different one. `?handle=` is an equality test, so the
		// `@` is what routed the reference past the ladder a bare name gets.
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		const row = {
			id: "group-uuid",
			name: "dev",
			handle: "#dev@acmecorp.rine.network",
			mls_group_id: null,
		};
		// The mock filters the way the server filters — equality on the stored
		// handle — because that is the whole of what this decision turns on.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			async (_path: string, params?: { handle?: string }) => ({
				items:
					params?.handle === undefined
						? [row]
						: [row].filter((g) => g.handle === params.handle),
			}),
		);
		mockGetOrCreateSenderKey.mockResolvedValue({
			state: {},
			groupId: "group-uuid",
		});
		mockEncryptGroupMessage.mockResolvedValue({
			result: {
				encrypted_payload: "enc-group",
				encryption_version: "sender-key-v1",
			},
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-d97",
		});

		await rineSend.handler(ctx, {
			to: "#dev@example.rine.network",
			payload: { text: "hello" },
		});

		// Both halves matter. The exact lookup ran first and found nothing, and
		// what travels on is the handle the SERVER holds — a post addressed to
		// the caller's spelling would be routed nowhere.
		const filters = (
			ctx.client.get as ReturnType<typeof vi.fn>
		).mock.calls.map((call) => (call[1] as { handle?: string })?.handle);
		expect(filters).toEqual(["#dev@example.rine.network", undefined]);
		expect(mockGetOrCreateSenderKey.mock.calls[0]![3]).toBe(
			"#dev@acmecorp.rine.network",
		);
		const postBody = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(postBody.to_handle).toBe("#dev@acmecorp.rine.network");
	});

	// A bare word used to die on the agent resolver's syntactic refusal
	// before any request. It now reaches the recipient ladder, which reads it as
	// a group of this org — the same answer `rine_group_post` gives it, which is
	// the whole point of one ladder. What is posted is the ROW's handle, never
	// the caller's word.
	it("sends a bare name to the group it names, by the row's own handle", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			async (path: string) =>
				path === "/agents"
					? { items: [{ id: "a-1", name: "mybot", handle: "mybot@acmecorp.rine.network" }] }
					: {
							items: [
								{
									id: "group-uuid",
									name: "dev",
									handle: "#dev@acmecorp.rine.network",
									mls_group_id: null,
								},
							],
						},
		);
		mockGetOrCreateSenderKey.mockResolvedValue({
			state: {},
			groupId: "group-uuid",
		});
		mockEncryptGroupMessage.mockResolvedValue({
			result: {
				encrypted_payload: "enc-group",
				encryption_version: "sender-key-v1",
			},
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-bare",
		});

		await rineSend.handler(ctx, { to: "dev", payload: { text: "hello" } });

		expect(mockGetOrCreateSenderKey.mock.calls[0]![3]).toBe(
			"#dev@acmecorp.rine.network",
		);
		const postBody = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(postBody.to_handle).toBe("#dev@acmecorp.rine.network");
		expect(postBody.to_agent_id).toBeUndefined();
	});

	// The bound that makes the arm above safe, and it is `rine-core`'s: a bare
	// word that is one of the caller's OWN agents is refused rather than read as
	// a group, so widening the send path cannot silently redirect a DM.
	it("refuses a bare name that is one of the org's own agents", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			async (path: string) =>
				path === "/agents"
					? { items: [{ id: "a-1", name: "kofi", handle: "kofi@acmecorp.rine.network" }] }
					: { items: [] },
		);

		await expect(
			rineSend.handler(ctx, { to: "kofi", payload: { text: "hello" } }),
		).rejects.toThrow(/kofi@acmecorp\.rine\.network/);
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("UUID recipient bypasses normalization", async () => {
		const ctx = makeCtx();
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		mockResolveRecipient.mockResolvedValue(agentTarget(uuid, uuid));
		mockSealForAgent.mockResolvedValue({
			encrypted_payload: "enc",
			encryption_version: "hpke-hybrid-v2",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-4",
		});

		await rineSend.handler(ctx, { to: uuid, payload: { text: "hello" } });

		expect(ladderWasAsked()).toBe(uuid);
		const postBody = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(postBody.to_agent_id).toBe(uuid);
	});

	it("from short handle resolves sender correctly", async () => {
		const ctx = makeCtx();
		mockResolveActor.mockResolvedValue({ agentId: "sender-uuid" });
		mockResolveRecipient.mockResolvedValue(
			agentTarget("recipient-uuid", "alice@acmecorp.rine.network"),
		);
		mockSealForAgent.mockResolvedValue({
			encrypted_payload: "enc",
			encryption_version: "hpke-hybrid-v2",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-5",
		});

		await rineSend.handler(ctx, {
			to: "alice@acmecorp.rine.network",
			from: "mybot",
			payload: { text: "hello" },
		});

		expect(mockResolveActor).toHaveBeenCalled();
		expect(ladderWasAsked()).toBe("alice@acmecorp.rine.network");
	});
});

// ── Phase A: PQ hybrid path regression (encryption_version "hpke-hybrid-v2") ──
// These drive a real PQ-capable recipient through the genuine encrypt/decrypt
// code so the hybrid dispatch is actually exercised. If the send/reply path
// dropped the recipient's PQ key, or inbox/read lost the "hpke-hybrid-v2"
// branch, every assertion below would fail.
describe("messaging — hpke-hybrid-v2 path", () => {
	// Real UUIDs: signing kid is `rine:${agentId}` and must parse as a UUID.
	const SENDER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
	const RECIPIENT_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
	// A peer of the SAME fixture org that re-seals another agent's signed
	// envelope and posts it as its own: the point is that the signer is not the
	// server-authenticated sender, not that the resealer is a stranger.
	const RESEALER_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012";
	// The server types this path parameter `uuid.UUID`, so a `conv-1` was never a
	// value the transcript route could have answered — the fixture, not the
	// refusal that now catches it locally, was the thing that did not fit.
	const CONV_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

	let dir: string;

	function makeRealCtx(): ToolContext {
		return {
			client: { get: vi.fn(), post: vi.fn(), markDelivered: vi.fn() } as never,
			configDir: dir,
			ownerDir: join(dir, "owner"),
			apiUrl: "https://api.test",
			refreshIdentity: vi.fn(),
		};
	}

	/** The recipient keys `fetchRecipientKeys` returns for a fixture-org agent. */
	async function recipientKeysFor(agentId: string) {
		const client = { get: async (path: string) => keysGet(path) } as never;
		return realFetchRecipientKeys(client, agentId);
	}

	beforeEach(() => {
		ladderAnswersForReal();
		mockResolveActor.mockReset();
		mockSealForAgent.mockReset();
		mockEncryptGroupMessage.mockReset();
		mockGetOrCreateSenderKey.mockReset();
		mockAgentKeysExist.mockReset();

		// Delegate the mocked crypto entry points to their REAL implementations so
		// the hybrid negotiation/dispatch genuinely runs end-to-end.
		mockSealForAgent.mockImplementation((...args: unknown[]) =>
			(realSealForAgent as (...a: unknown[]) => unknown)(...args),
		);
		mockAgentKeysExist.mockImplementation((...args: unknown[]) =>
			(realAgentKeysExist as (...a: unknown[]) => unknown)(...args),
		);

		dir = fs.mkdtempSync(join(tmpdir(), "rine-mcp-hybrid-"));
		seedAgentKeys(dir, SENDER_ID);
		seedAgentKeys(dir, RECIPIENT_ID);
		seedAgentKeys(dir, RESEALER_ID);
		// Every fixture agent publishes a post-quantum key, so every seal is hybrid.
		expect(publishedKeys(RECIPIENT_ID).pq_encryption_public_key).toBeDefined();
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	// rine_send to a PQ-capable recipient must negotiate hybrid.
	it("rine_send emits encryption_version hpke-hybrid-v2 when the recipient has a PQ key", async () => {
		const ctx = makeRealCtx();
		mockResolveActor.mockResolvedValue({ agentId: SENDER_ID });
		// Real fetchRecipientKeys reads the recipient's published PQ key from
		// here — and the real ladder asks the GROUP namespace for a
		// UUID before the agent one. `RECIPIENT_ID` names an agent, so the group
		// route is the 404 miss that hands the spelling on; answering it with
		// this agent body instead would be a server naming a different row,
		// which `readableGroupById` refuses outright.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) =>
				path.startsWith("/groups/")
					? Promise.reject(new realCore.RineApiError(404, "Group not found"))
					: Promise.resolve(publishedKeys(RECIPIENT_ID)),
		);
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-1",
		});

		await rineSend.handler(ctx, {
			to: RECIPIENT_ID,
			payload: { text: "quantum-safe hi" },
		});

		const postBody = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(postBody.encryption_version).toBe("hpke-hybrid-v2");
		expect(postBody.encryption_version).not.toBe("hpke-hybrid-v1");
		expect(typeof postBody.encrypted_payload).toBe("string");
		expect(mockSealForAgent.mock.calls[0]![2]).toEqual({
			senderAgentId: SENDER_ID,
			recipientAgentId: RECIPIENT_ID,
		});
	});

	// rine_reply must carry the recipient's PQ key into encryptMessage too.
	it("rine_reply emits encryption_version hpke-hybrid-v2 when the original sender has a PQ key", async () => {
		const ctx = makeRealCtx();
		// Replying as RECIPIENT_ID back to the original sender (SENDER_ID), who is PQ-capable.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				if (path === "/messages/orig-1") {
					return Promise.resolve({
						id: "orig-1",
						to_agent_id: RECIPIENT_ID,
						from_agent_id: SENDER_ID,
						type: "rine.v1.dm",
					});
				}
				// fetchRecipientKeys for the reply target (the original sender).
				return Promise.resolve(publishedKeys(SENDER_ID));
			},
		);
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "reply-1",
		});

		await rineReply.handler(ctx, {
			message_id: "orig-1",
			payload: { text: "reply pq" },
		});

		const postBody = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(postBody.encryption_version).toBe("hpke-hybrid-v2");
		expect(postBody.encryption_version).not.toBe("hpke-hybrid-v1");
		// Sealed by the agent the original was addressed to, back to its sender.
		expect(mockSealForAgent.mock.calls[0]![2]).toEqual({
			senderAgentId: RECIPIENT_ID,
			recipientAgentId: SENDER_ID,
		});
	});

	// rine_inbox must decrypt a real hpke-hybrid-v2 message, not return it raw.
	it("rine_inbox decrypts an hpke-hybrid-v2 message to its real plaintext", async () => {
		const ctx = makeRealCtx();
		const payload = { task: "translate", text: "post-quantum" };
		// Real encrypt: SENDER → RECIPIENT, hybrid because recipient has a PQ key.
		const enc = await realEncryptMessage(
			dir,
			SENDER_ID,
			RECIPIENT_ID,
			await recipientKeysFor(RECIPIENT_ID),
			payload,
		);
		expect(enc.encryption_version).toBe("hpke-hybrid-v2");

		const msg = {
			id: "inbox-msg-1",
			type: "rine.v1.dm",
			from_agent_id: SENDER_ID,
			encryption_version: enc.encryption_version,
			encrypted_payload: enc.encrypted_payload,
			created_at: new Date().toISOString(),
		};

		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				// Listing endpoint returns the inbox; sender-key lookup (signature
				// verification inside decryptMessage) returns the sender's pubkeys.
				if (path === `/agents/${RECIPIENT_ID}/messages`) {
					return Promise.resolve({ items: [msg], next_cursor: null });
				}
				return Promise.resolve(publishedKeys(SENDER_ID));
			},
		);

		const result = (await rineInbox.handler(ctx, {
			agent: RECIPIENT_ID,
			status: "new",
		})) as {
			items: Array<Record<string, unknown>>;
		};

		const out = result.items[0]!;
		expect(out.decrypted).toEqual(payload);
		expect(out.verified).toBe(true);
	});

	// rine_read must decrypt a single hpke-hybrid-v2 message, not return it raw.
	it("rine_read decrypts a single hpke-hybrid-v2 message to its real plaintext", async () => {
		const ctx = makeRealCtx();
		const payload = { msg: "lattice forever" };
		const enc = await realEncryptMessage(
			dir,
			SENDER_ID,
			RECIPIENT_ID,
			await recipientKeysFor(RECIPIENT_ID),
			payload,
		);
		expect(enc.encryption_version).toBe("hpke-hybrid-v2");

		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				if (path === "/messages/read-msg-1") {
					return Promise.resolve({
						id: "read-msg-1",
						type: "rine.v1.dm",
						from_agent_id: SENDER_ID,
						encryption_version: enc.encryption_version,
						encrypted_payload: enc.encrypted_payload,
						created_at: new Date().toISOString(),
					});
				}
				return Promise.resolve(publishedKeys(SENDER_ID));
			},
		);

		const out = (await rineRead.handler(ctx, {
			message_id: "read-msg-1",
			agent: RECIPIENT_ID,
		})) as Record<string, unknown>;

		expect(out.decrypted).toEqual(payload);
		expect(out.verified).toBe(true);
	});

	it("rine_read leaves a message with no server-authenticated sender sealed", async () => {
		const ctx = makeRealCtx();
		const enc = await realEncryptMessage(
			dir,
			SENDER_ID,
			RECIPIENT_ID,
			await recipientKeysFor(RECIPIENT_ID),
			{ msg: "unattributable" },
		);

		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				if (path === "/messages/read-msg-2") {
					return Promise.resolve({
						id: "read-msg-2",
						type: "rine.v1.dm",
						encryption_version: enc.encryption_version,
						encrypted_payload: enc.encrypted_payload,
						created_at: new Date().toISOString(),
					});
				}
				return Promise.resolve(publishedKeys(SENDER_ID));
			},
		);

		const out = (await rineRead.handler(ctx, {
			message_id: "read-msg-2",
			agent: RECIPIENT_ID,
		})) as Record<string, unknown>;

		// No sender to check the envelope against, so no plaintext is produced.
		expect(out.decrypted).toBeUndefined();
		expect(out.verified).toBeUndefined();
		expect(out.encrypted_payload).toBe(enc.encrypted_payload);
	});

	it("rine_read reports a re-sealed message as unverified", async () => {
		const ctx = makeRealCtx();
		const payload = { msg: "authentic content of another agent" };
		const enc = await realEncryptMessage(
			dir,
			SENDER_ID,
			RECIPIENT_ID,
			await recipientKeysFor(RECIPIENT_ID),
			payload,
		);

		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				if (path === "/messages/read-msg-3") {
					return Promise.resolve({
						id: "read-msg-3",
						type: "rine.v1.dm",
						// The server authenticated the resealer as this row's sender…
						from_agent_id: RESEALER_ID,
						// …while the header the sender supplies still names the signer.
						sender_signing_kid: `rine:${SENDER_ID}`,
						encryption_version: enc.encryption_version,
						encrypted_payload: enc.encrypted_payload,
						created_at: new Date().toISOString(),
					});
				}
				return Promise.resolve(publishedKeys(SENDER_ID));
			},
		);

		const out = (await rineRead.handler(ctx, {
			message_id: "read-msg-3",
			agent: RECIPIENT_ID,
		})) as Record<string, unknown>;

		// The content is not presented as authentic content of the resealer…
		expect(out.verified).toBe(false);
		// …and it is not presented at all: an authenticity failure withholds the
		// text, and the verdict tells the model which failure closed the row.
		expect(out.decrypted).toBeUndefined();
		expect(out.verification_status).toBe("sender-mismatch");
	});

	// rine_thread returns both-sided ThreadEntry rows, resolving the
	// acting agent, and surfaces [unavailable] for an undecryptable row.
	it("rine_thread returns both-sided decrypted rows and [unavailable] for an undecryptable one", async () => {
		const ctx = makeRealCtx();
		// Turn 1: RECIPIENT (us) SENT to the peer → we read our self-blob.
		const sent = await realEncryptMessage(
			dir,
			RECIPIENT_ID,
			SENDER_ID,
			await recipientKeysFor(SENDER_ID),
			{ text: "my question" },
		);
		// Turn 2: the peer (SENDER) RECEIVED-side reply to us, sealed to our key.
		const received = await realEncryptMessage(
			dir,
			SENDER_ID,
			RECIPIENT_ID,
			await recipientKeysFor(RECIPIENT_ID),
			{ text: "their answer" },
		);

		const page = {
			messages: [
				{
					id: "t1",
					type: "rine.v1.task_request",
					direction: "sent",
					from_agent_id: RECIPIENT_ID,
					// The self-sealed copy is bound to the recipient the sender addressed.
					to_agent_id: SENDER_ID,
					sender_handle: "me@org",
					encryption_version: sent.encryption_version,
					encrypted_payload: sent.encrypted_payload,
					self_encrypted_payload: sent.self_encrypted_payload,
					created_at: new Date().toISOString(),
				},
				{
					id: "t2",
					type: "rine.v1.task_response",
					direction: "received",
					from_agent_id: SENDER_ID,
					sender_handle: "alice@org",
					encryption_version: received.encryption_version,
					encrypted_payload: received.encrypted_payload,
					created_at: new Date().toISOString(),
				},
				{
					id: "t3",
					type: "rine.v1.dm",
					direction: "received",
					from_agent_id: SENDER_ID,
					sender_handle: "alice@org",
					encryption_version: "hpke-hybrid-v2",
					encrypted_payload: "AAAA",
					created_at: new Date().toISOString(),
				},
				{
					// The peer's own signed reply, re-sealed verbatim by a third agent
					// and posted as its own turn: the server authenticates the resealer
					// as the sender, the envelope names the peer.
					id: "t4",
					type: "rine.v1.task_response",
					direction: "received",
					from_agent_id: RESEALER_ID,
					sender_handle: "resealer@org",
					encryption_version: received.encryption_version,
					encrypted_payload: received.encrypted_payload,
					created_at: "2026-06-20T00:00:03Z",
				},
			],
			truncated: false,
		};

		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				if (path === `/conversations/${CONV_ID}/messages`) {
					return Promise.resolve(page);
				}
				// Signature verification fetches the signer's pubkeys: the sent turn was
				// signed by us (RECIPIENT_ID), the received turn by the peer (SENDER_ID).
				if (path.includes(RECIPIENT_ID)) {
					return Promise.resolve(publishedKeys(RECIPIENT_ID));
				}
				return Promise.resolve(publishedKeys(SENDER_ID));
			},
		);

		const out = (await rineThread.handler(ctx, {
			conversation_id: CONV_ID,
		})) as {
			messages: Array<Record<string, unknown>>;
			truncated: boolean;
		};

		expect(mockResolveActor).toHaveBeenCalled();
		expect(out.messages).toHaveLength(4);
		expect(out.messages[0]!.direction).toBe("sent");
		expect(out.messages[0]!.text).toBe("my question");
		expect(out.messages[1]!.direction).toBe("received");
		expect(out.messages[1]!.text).toBe("their answer");
		// Undecryptable row fails closed.
		expect(out.messages[2]!.text).toBe("[unavailable]");
		// So does a turn signed by someone other than the sender the server
		// authenticated — the peer's content never renders as the resealer's.
		expect(out.messages[3]!.text).toBe("[unavailable]");
		expect(out.messages[3]!.verification_status).toBe("sender-mismatch");
		// No raw ciphertext field on the returned rows.
		expect(out.messages[0]!.encrypted_payload).toBeUndefined();
		expect(out.messages[0]!.self_encrypted_payload).toBeUndefined();
	});
});

// A group message sealed under a sender key this agent does not hold is
// the one refusal cause with a move for the reader, so it says why instead of
// staying a bare [unavailable]/sealed row. The volume is tiered by how many
// rows the caller asked for: `rine_read` affords the one-shot recovery and asks
// for one row, so it earns and prints the full sentence with the stable code;
// `rine_inbox` and `rine_thread` render N rows and cannot afford that recovery
// per row, so the render explains once (the un-earned, no-code sentence) and
// marks every later row on the same cause — a NEW render (a fresh page, a fresh
// thread fetch) explains again, because the state lives in a per-call closure,
// never at module scope.
describe("messaging — sender-key-unavailable (group)", () => {
	const SENDER_ID = "d1e2f3a4-b5c6-7890-abcd-ef1234567891";
	const RECIPIENT_ID = "e2f3a4b5-c6d7-8901-bcde-f12345678902";
	const GROUP_ID = "f3a4b5c6-d7e8-9012-cdef-123456789013";
	// A real UUID for the same reason as the hybrid-path suite's: the transcript
	// route's path parameter is typed `uuid.UUID` server-side.
	const CONV_ID = "1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901";

	let dir: string;

	function makeRealCtx(): ToolContext {
		return {
			client: { get: vi.fn(), post: vi.fn(), markDelivered: vi.fn() } as never,
			configDir: dir,
			ownerDir: join(dir, "owner"),
			apiUrl: "https://api.test",
			refreshIdentity: vi.fn(),
		};
	}

	/**
	 * A group row sealed under a sender key this agent holds no state for — a
	 * fresh key each call, so distinct rows never collide on the same id.
	 */
	async function unopenableGroupRow(id: string): Promise<MessageRead> {
		const state = generateSenderKey(GROUP_ID, SENDER_ID);
		// The sender's own copy, which `encryptGroupMessage` advances in place. A
		// stand-in sender needs it as much as a real one does: the tail refuses a
		// state that is on no disk at all rather than discarding the advance.
		saveSenderKeyState(dir, SENDER_ID, GROUP_ID, [state]);
		const { result: enc } = await realEncryptGroupMessage(
			dir,
			SENDER_ID,
			GROUP_ID,
			state,
			{ text: "you cannot read this" },
		);
		// Deliberately no saveSenderKeyState for RECIPIENT_ID.
		return {
			id,
			type: "rine.v1.dm",
			from_agent_id: SENDER_ID,
			group_id: GROUP_ID,
			encryption_version: "sender-key-v1",
			encrypted_payload: enc.encrypted_payload,
		} as MessageRead;
	}

	/** GET stub: empty pending-distribution inbox, so the one-shot scan ingests nothing. */
	function mockGetWithNoDistributions(
		ctx: ToolContext,
		byPath: Record<string, unknown>,
	) {
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				if (path in byPath) return Promise.resolve(byPath[path]);
				if (path.endsWith("/messages")) return Promise.resolve({ items: [] });
				return Promise.reject(new Error(`Unexpected GET: ${path}`));
			},
		);
	}

	beforeEach(() => {
		mockResolveActor.mockReset();
		mockAgentKeysExist.mockReset().mockImplementation((...args: unknown[]) =>
			(realAgentKeysExist as (...a: unknown[]) => unknown)(...args),
		);

		dir = fs.mkdtempSync(join(tmpdir(), "rine-mcp-ch6-"));
		seedAgentKeys(dir, SENDER_ID);
		seedAgentKeys(dir, RECIPIENT_ID);
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	// Tier MULTI, first row of the page.
	it("rine_inbox explains the cause in full on a page's first unopenable row, and never earns a code it did not check for", async () => {
		const ctx = makeRealCtx();
		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });
		const rows = [
			await unopenableGroupRow("row-1"),
			await unopenableGroupRow("row-2"),
			await unopenableGroupRow("row-3"),
		];
		mockGetWithNoDistributions(ctx, {
			[`/agents/${RECIPIENT_ID}/messages`]: { items: rows, next_cursor: null },
		});

		const result = (await rineInbox.handler(ctx, {
			agent: RECIPIENT_ID,
			status: "new",
		})) as { items: Array<Record<string, unknown>> };

		const [first, second, third] = result.items;
		expect(first!.decrypt_error).toContain("sealed under sender key");
		expect(first!.decrypt_error).toContain(
			"did not go looking for the distribution",
		);
		// The remedy is a read this surface ships, not the `retrySenderKey` switch
		// it does not expose.
		expect(first!.decrypt_error).toContain("read this one message on its own");
		expect(first!.decrypt_error).not.toContain("recovery left on");
		// Second and later rows carrying the SAME cause in this page just mark it —
		// with THIS sentence's marker. Marked with the earned verdict's, the page
		// said "no fetch went looking" on row 1 and asserted the final answer's
		// remedy on every row after it.
		expect(second!.decrypt_error).toBe(SENDER_KEY_NOT_RECOVERED_PREVIEW);
		expect(third!.decrypt_error).toBe(SENDER_KEY_NOT_RECOVERED_PREVIEW);
		expect(second!.decrypt_error).not.toBe(SENDER_KEY_UNAVAILABLE_PREVIEW);
		// openInboxRow never runs the one-shot recovery, so this sentence is
		// un-earned — it must never carry the code that says the verdict is final.
		expect(first!.decrypt_error_code).toBeUndefined();
		expect(second!.decrypt_error_code).toBeUndefined();
		expect(third!.decrypt_error_code).toBeUndefined();
	});

	// A fresh render (a new page fetch) explains again — the state is per-call,
	// not module-global.
	it("a fresh rine_inbox page explains its own first row again, independent of a prior page", async () => {
		const ctx = makeRealCtx();
		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });

		mockGetWithNoDistributions(ctx, {
			[`/agents/${RECIPIENT_ID}/messages`]: {
				items: [await unopenableGroupRow("page1-row1")],
				next_cursor: null,
			},
		});
		const page1 = (await rineInbox.handler(ctx, {
			agent: RECIPIENT_ID,
			status: "new",
		})) as { items: Array<Record<string, unknown>> };
		expect(page1.items[0]!.decrypt_error).toContain("sealed under sender key");

		mockGetWithNoDistributions(ctx, {
			[`/agents/${RECIPIENT_ID}/messages`]: {
				items: [await unopenableGroupRow("page2-row1")],
				next_cursor: null,
			},
		});
		const page2 = (await rineInbox.handler(ctx, {
			agent: RECIPIENT_ID,
			status: "new",
		})) as { items: Array<Record<string, unknown>> };
		// Not the preview marker: a second CALL is a new render, not a later row of
		// the first one.
		expect(page2.items[0]!.decrypt_error).toContain("sealed under sender key");
		expect(page2.items[0]!.decrypt_error).not.toBe(
			SENDER_KEY_NOT_RECOVERED_PREVIEW,
		);
	});

	// Tier SINGLE — one row asked for, so the sentence is earned (the one-shot
	// recovery ran and lost) and carries the stable code a caller can branch on.
	it("rine_read affords the one-shot recovery, earns the full sentence, and sets the stable code", async () => {
		const ctx = makeRealCtx();
		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });
		const row = await unopenableGroupRow("read-msg-1");
		mockGetWithNoDistributions(ctx, {
			"/messages/read-msg-1": row,
		});

		const out = (await rineRead.handler(ctx, {
			message_id: "read-msg-1",
			agent: RECIPIENT_ID,
		})) as Record<string, unknown>;

		expect(out.decrypt_error).toContain("sealed under sender key");
		expect(out.decrypt_error).toContain("Ask the sender to post to the group again");
		expect(out.decrypt_error_code).toBe(SENDER_KEY_UNAVAILABLE_CODE);
		expect(out.decrypted).toBeUndefined();
	});

	// Tier MULTI via the plural `decryptThreadRows` — the render boundary is the
	// whole transcript fetch, so the first unopenable turn explains in full and
	// the rest just mark it, same as the inbox page.
	it("rine_thread explains once for the whole transcript and marks the rest", async () => {
		const ctx = makeRealCtx();
		mockResolveActor.mockResolvedValue({ agentId: RECIPIENT_ID });
		const row1 = await unopenableGroupRow("t1");
		const row2 = await unopenableGroupRow("t2");
		const page = {
			messages: [
				{
					id: "t1",
					type: "rine.v1.dm",
					direction: "received",
					from_agent_id: SENDER_ID,
					sender_handle: "alice@org",
					group_id: GROUP_ID,
					encryption_version: "sender-key-v1",
					encrypted_payload: row1.encrypted_payload,
					created_at: "2026-06-20T00:00:00Z",
				},
				{
					id: "t2",
					type: "rine.v1.dm",
					direction: "received",
					from_agent_id: SENDER_ID,
					sender_handle: "alice@org",
					group_id: GROUP_ID,
					encryption_version: "sender-key-v1",
					encrypted_payload: row2.encrypted_payload,
					created_at: "2026-06-20T00:00:01Z",
				},
			],
			truncated: false,
		};
		mockGetWithNoDistributions(ctx, {
			[`/conversations/${CONV_ID}/messages`]: page,
		});

		const out = (await rineThread.handler(ctx, {
			conversation_id: CONV_ID,
		})) as { messages: Array<Record<string, unknown>> };

		expect(out.messages[0]!.text).toContain("sealed under sender key");
		expect(out.messages[0]!.text).toContain(
			"Ask the sender to post to the group again",
		);
		expect(out.messages[1]!.text).toBe(SENDER_KEY_UNAVAILABLE_PREVIEW);
	});
});

// A reply routes to the "other party" of a 1:1 pair. Two kinds of message have no such
// party, and both used to be refused only by accident or not at all.
describe("rine_reply — messages that cannot be replied to", () => {
	function ctxWith(original: Record<string, unknown>): ToolContext {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(original);
		return ctx;
	}

	// A group post carries `to_agent_id: null`, so the recipient lookup fails. The bare
	// "cannot determine recipient" sent operators looking for a broken message instead of
	// a group; the refusal now names the case and the way to answer a group.
	//
	// The sentence is gated by nothing cross-stack, so its SHAPE is
	// pinned here — rung 1 names the group the caller actually tried to answer,
	// rung 2 describes a handle it cannot name. Neither may print a placeholder
	// domain, which is what this refusal did before (`#logistics@acme.rine.network`,
	// labelled "for example").
	it("refuses a group post by naming the group's own handle, off the message", async () => {
		const ctx = ctxWith({
			id: "grp-1",
			to_agent_id: null,
			from_agent_id: "agent-a",
			group_id: "3f0d1f5e-group-uuid",
			group_handle: "#logistics@acmecorp.rine.network",
			type: "rine.v1.dm",
		});
		await expect(
			rineReply.handler(ctx, { message_id: "grp-1", payload: { text: "hi" } }),
		).rejects.toThrow(
			"Cannot reply to a group post — it has no single recipient. " +
				"Answer the group by sending to #logistics@acmecorp.rine.network.",
		);
		// The handle is an ECHO of the read the tool already paid for: exactly one
		// GET, the message itself, and no `GET /groups/{id}` behind it.
		expect((ctx.client.get as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	it("describes the handle it cannot name when the row carries none", async () => {
		const ctx = ctxWith({
			id: "grp-2",
			to_agent_id: null,
			from_agent_id: "agent-a",
			group_id: "3f0d1f5e-group-uuid",
			type: "rine.v1.dm",
		});
		const refusal = await rineReply
			.handler(ctx, { message_id: "grp-2", payload: { text: "hi" } })
			.then(
				() => "resolved",
				(e: Error) => e.message,
			);

		expect(refusal).toBe(
			"Cannot reply to a group post — it has no single recipient. Answer the " +
				"group by sending to its own handle: a leading hash, the group's name, " +
				"an at sign, and its org's domain.",
		);
		// Rung 2 describes the parts of a handle and prints none: nothing to paste,
		// no at sign to complete, and no `<slot>` for a model to fill with the
		// schema's own placeholder text.
		expect(refusal).not.toContain("@");
		expect(refusal).not.toMatch(/example|<|>/);
		expect(ctx.client.post).not.toHaveBeenCalled();
	});

	// A control frame's payload is machine-parsed, and a reply mirrors the original's type,
	// so a prose reply to one goes on the wire wearing a crypto envelope's label and is
	// discarded at the far end. Measured live before this guard existed.
	for (const type of ["rine.v1.sender_key_distribution", "rine.v1.group_invite"]) {
		it(`refuses a ${type} control frame`, async () => {
			const ctx = ctxWith({
				id: "ctl-1",
				to_agent_id: "agent-b",
				from_agent_id: "agent-a",
				type,
			});
			await expect(
				rineReply.handler(ctx, { message_id: "ctl-1", payload: { text: "sure!" } }),
			).rejects.toThrow(/control frame/);
			expect(ctx.client.post).not.toHaveBeenCalled();
		});
	}

	// The guard is exact-match: a type that merely embeds a control frame's name is an
	// ordinary message and falls through to the ordinary refusal.
	it("does not treat a type that merely embeds a control frame name as one", async () => {
		const ctx = ctxWith({
			id: "note-1",
			to_agent_id: null,
			from_agent_id: "agent-a",
			type: "rine.v1.sender_key_distribution_note",
		});
		await expect(
			rineReply.handler(ctx, { message_id: "note-1", payload: { text: "hi" } }),
		).rejects.toThrow("Cannot determine recipient from message");
	});
});
