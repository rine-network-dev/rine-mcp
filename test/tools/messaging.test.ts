import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKeys } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveToUuid = vi.fn();
const mockFetchAgents = vi.fn();
const mockResolveAgent = vi.fn();
const mockEncryptMessage = vi.fn();
const mockEncryptGroupMessage = vi.fn();
const mockFetchRecipientKeys = vi.fn();
const mockGetOrCreateSenderKey = vi.fn();
const mockAgentKeysExist = vi.fn();
const mockEncryptMlsGroupMessage = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveToUuid: (...args: unknown[]) => mockResolveToUuid(...args),
		fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
		resolveAgent: (...args: unknown[]) => mockResolveAgent(...args),
		encryptMessage: (...args: unknown[]) => mockEncryptMessage(...args),
		encryptGroupMessage: (...args: unknown[]) =>
			mockEncryptGroupMessage(...args),
		fetchRecipientKeys: (...args: unknown[]) => mockFetchRecipientKeys(...args),
		getOrCreateSenderKey: (...args: unknown[]) =>
			mockGetOrCreateSenderKey(...args),
		agentKeysExist: (...args: unknown[]) => mockAgentKeysExist(...args),
		encryptMlsGroupMessage: (...args: unknown[]) =>
			mockEncryptMlsGroupMessage(...args),
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
	encryptMessage: realEncryptMessage,
	fetchRecipientKeys: realFetchRecipientKeys,
	generateAgentKeys,
	pqPublicKeyToJWK,
	saveAgentKeys,
	signingPublicKeyToJWK,
	toBase64Url,
} = realCore;

const { messagingTools } = await import("../../src/tools/messaging.js");

const rineSend = messagingTools.find((t) => t.name === "rine_send")!;
const rineInbox = messagingTools.find((t) => t.name === "rine_inbox")!;
const rineRead = messagingTools.find((t) => t.name === "rine_read")!;
const rineReply = messagingTools.find((t) => t.name === "rine_reply")!;
const rineThread = messagingTools.find((t) => t.name === "rine_thread")!;

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: "/tmp/test",
		apiUrl: "https://api.test",
	};
}

describe("rine_send — short-handle normalization", () => {
	beforeEach(() => {
		mockResolveToUuid.mockReset();
		mockFetchAgents.mockReset();
		mockResolveAgent.mockReset();
		mockEncryptMessage.mockReset();
		mockEncryptGroupMessage.mockReset();
		mockFetchRecipientKeys.mockReset();
		mockGetOrCreateSenderKey.mockReset();
		mockAgentKeysExist.mockReset();
		mockEncryptMlsGroupMessage.mockReset();
	});

	it("group with non-null mls_group_id routes through MLS encrypt, not sender keys", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([
			{ id: "sender-uuid", handle: "bot@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		// mls_group_id is a non-null opaque latch → MLS path. group.id is the state key.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			items: [{ id: "group-uuid", mls_group_id: "opaque-mls-latch" }],
		});
		mockEncryptMlsGroupMessage.mockResolvedValue({
			encrypted_payload: "enc-mls",
			encryption_version: "mls-v1",
			sender_signing_kid: "kid-1",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-mls",
		});

		await rineSend.handler(ctx, {
			to: "#dev@acmecorp",
			payload: { text: "hi" },
		});

		// MLS encrypt was called with the rine group UUID (group.id), never the latch.
		expect(mockEncryptMlsGroupMessage).toHaveBeenCalledWith(
			ctx.configDir,
			"sender-uuid",
			"group-uuid",
			{ text: "hi" },
		);
		expect(mockGetOrCreateSenderKey).not.toHaveBeenCalled();

		const postBody = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0]![1] as Record<string, unknown>;
		expect(postBody.encryption_version).toBe("mls-v1");
		expect(postBody.to_handle).toBe("#dev@acmecorp.rine.network");
	});

	it("short agent handle is normalized before resolveToUuid", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([
			{ id: "sender-uuid", handle: "bot@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockResolveToUuid.mockResolvedValue("recipient-uuid");
		mockFetchRecipientKeys.mockResolvedValue({
			encryption: new Uint8Array(32),
		});
		mockEncryptMessage.mockResolvedValue({
			encrypted_payload: "enc",
			encryption_version: "hpke-v1",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-1",
		});

		await rineSend.handler(ctx, {
			to: "alice@acmecorp",
			payload: { text: "hello" },
		});

		expect(mockResolveToUuid).toHaveBeenCalledWith(
			"https://api.test",
			"alice@acmecorp.rine.network",
		);
	});

	it("full agent handle passes through unchanged", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([
			{ id: "sender-uuid", handle: "bot@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockResolveToUuid.mockResolvedValue("recipient-uuid");
		mockFetchRecipientKeys.mockResolvedValue({
			encryption: new Uint8Array(32),
		});
		mockEncryptMessage.mockResolvedValue({
			encrypted_payload: "enc",
			encryption_version: "hpke-v1",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-1",
		});

		await rineSend.handler(ctx, {
			to: "alice@acmecorp.rine.network",
			payload: { text: "hello" },
		});

		expect(mockResolveToUuid).toHaveBeenCalledWith(
			"https://api.test",
			"alice@acmecorp.rine.network",
		);
	});

	it("short group handle is normalized before getOrCreateSenderKey", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([
			{ id: "sender-uuid", handle: "bot@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		// Group lookup resolves to a non-MLS group → sender-key path.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			items: [{ id: "group-uuid", mls_group_id: null }],
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

		const gocskCall = mockGetOrCreateSenderKey.mock.calls[0];
		// getOrCreateSenderKey(client, configDir, agentId, to, extraHeaders)
		const handleArg = gocskCall![3];
		expect(handleArg).toBe("#dev@acmecorp.rine.network");

		const postCall = (ctx.client.post as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const postBody = postCall![1] as Record<string, unknown>;
		expect(postBody.to_handle).toBe("#dev@acmecorp.rine.network");
	});

	it("full group handle passes through unchanged", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([
			{ id: "sender-uuid", handle: "bot@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		// Group lookup resolves to a non-MLS group → sender-key path.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			items: [{ id: "group-uuid", mls_group_id: null }],
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

	it("UUID recipient bypasses normalization", async () => {
		const ctx = makeCtx();
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		mockFetchAgents.mockResolvedValue([
			{ id: "sender-uuid", handle: "bot@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockResolveToUuid.mockResolvedValue(uuid);
		mockFetchRecipientKeys.mockResolvedValue({
			encryption: new Uint8Array(32),
		});
		mockEncryptMessage.mockResolvedValue({
			encrypted_payload: "enc",
			encryption_version: "hpke-v1",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-4",
		});

		await rineSend.handler(ctx, { to: uuid, payload: { text: "hello" } });

		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", uuid);
	});

	it("from short handle resolves sender correctly", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([
			{ id: "sender-uuid", handle: "mybot@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockResolveToUuid.mockResolvedValue("recipient-uuid");
		mockFetchRecipientKeys.mockResolvedValue({
			encryption: new Uint8Array(32),
		});
		mockEncryptMessage.mockResolvedValue({
			encrypted_payload: "enc",
			encryption_version: "hpke-v1",
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "msg-5",
		});

		await rineSend.handler(ctx, {
			to: "alice@acmecorp.rine.network",
			from: "mybot",
			payload: { text: "hello" },
		});

		expect(mockResolveAgent).toHaveBeenCalled();
		expect(mockResolveToUuid).toHaveBeenCalledWith(
			"https://api.test",
			"alice@acmecorp.rine.network",
		);
	});
});

// ── Phase A: PQ hybrid path regression (encryption_version "hpke-hybrid-v1") ──
// These drive a real PQ-capable recipient through the genuine encrypt/decrypt
// code so the hybrid dispatch is actually exercised. If commit 180be82 were
// reverted (send/reply dropping the pqEncryption arg, or inbox/read losing the
// "hpke-hybrid-v1" branch), every assertion below would fail.
describe("messaging — hpke-hybrid-v1 path", () => {
	// Real UUIDs: signing kid is `rine:${agentId}` and must parse as a UUID.
	const SENDER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
	const RECIPIENT_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

	let dir: string;
	let senderKeys: AgentKeys;
	let recipientKeys: AgentKeys;

	function makeRealCtx(): ToolContext {
		return {
			client: { get: vi.fn(), post: vi.fn(), markDelivered: vi.fn() } as never,
			configDir: dir,
			apiUrl: "https://api.test",
		};
	}

	// JWK bundle the server would return from GET /agents/{id}/keys.
	function keysResponse(agentId: string, keys: AgentKeys) {
		const body: Record<string, unknown> = {
			agent_id: agentId,
			signing_public_key: signingPublicKeyToJWK(keys.signing.publicKey),
			encryption_public_key: {
				kty: "OKP",
				crv: "X25519",
				x: toBase64Url(keys.encryption.publicKey),
			},
		};
		if (keys.pqEncryption) {
			body.pq_encryption_public_key = pqPublicKeyToJWK(
				keys.pqEncryption.publicKey,
			);
		}
		return body;
	}

	beforeEach(() => {
		mockResolveToUuid.mockReset();
		mockFetchAgents.mockReset();
		mockResolveAgent.mockReset();
		mockEncryptMessage.mockReset();
		mockEncryptGroupMessage.mockReset();
		mockFetchRecipientKeys.mockReset();
		mockGetOrCreateSenderKey.mockReset();
		mockAgentKeysExist.mockReset();

		// Delegate the mocked crypto entry points to their REAL implementations so
		// the hybrid negotiation/dispatch genuinely runs end-to-end.
		mockEncryptMessage.mockImplementation((...args: unknown[]) =>
			(realEncryptMessage as (...a: unknown[]) => unknown)(...args),
		);
		mockFetchRecipientKeys.mockImplementation((...args: unknown[]) =>
			(realFetchRecipientKeys as (...a: unknown[]) => unknown)(...args),
		);
		mockAgentKeysExist.mockImplementation((...args: unknown[]) =>
			(realAgentKeysExist as (...a: unknown[]) => unknown)(...args),
		);

		dir = fs.mkdtempSync(join(tmpdir(), "rine-mcp-hybrid-"));
		senderKeys = generateAgentKeys();
		recipientKeys = generateAgentKeys();
		saveAgentKeys(dir, SENDER_ID, senderKeys);
		saveAgentKeys(dir, RECIPIENT_ID, recipientKeys);
		expect(recipientKeys.pqEncryption).toBeDefined();
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	// A1 — rine_send to a PQ-capable recipient must negotiate hybrid.
	it("rine_send emits encryption_version hpke-hybrid-v1 when the recipient has a PQ key", async () => {
		const ctx = makeRealCtx();
		mockFetchAgents.mockResolvedValue([
			{ id: SENDER_ID, handle: "bot@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue(SENDER_ID);
		mockResolveToUuid.mockResolvedValue(RECIPIENT_ID);
		// Real fetchRecipientKeys reads the recipient's published PQ key from here.
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
			keysResponse(RECIPIENT_ID, recipientKeys),
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
		expect(postBody.encryption_version).toBe("hpke-hybrid-v1");
		expect(postBody.encryption_version).not.toBe("hpke-v1");
		expect(typeof postBody.encrypted_payload).toBe("string");
	});

	// A2 — rine_reply must carry the recipient's PQ key into encryptMessage too.
	it("rine_reply emits encryption_version hpke-hybrid-v1 when the original sender has a PQ key", async () => {
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
				return Promise.resolve(keysResponse(SENDER_ID, senderKeys));
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
		expect(postBody.encryption_version).toBe("hpke-hybrid-v1");
		expect(postBody.encryption_version).not.toBe("hpke-v1");
	});

	// A3 — rine_inbox must decrypt a real hpke-hybrid-v1 message, not return it raw.
	it("rine_inbox decrypts an hpke-hybrid-v1 message to its real plaintext", async () => {
		const ctx = makeRealCtx();
		const payload = { task: "translate", text: "post-quantum" };
		// Real encrypt: SENDER → RECIPIENT, hybrid because recipient has a PQ key.
		const enc = await realEncryptMessage(
			dir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			payload,
			recipientKeys.pqEncryption!.publicKey,
		);
		expect(enc.encryption_version).toBe("hpke-hybrid-v1");

		const msg = {
			id: "inbox-msg-1",
			type: "rine.v1.dm",
			encryption_version: enc.encryption_version,
			encrypted_payload: enc.encrypted_payload,
		};

		mockFetchAgents.mockResolvedValue([
			{ id: RECIPIENT_ID, handle: "me@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue(RECIPIENT_ID);
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				// Listing endpoint returns the inbox; sender-key lookup (signature
				// verification inside decryptMessage) returns the sender's pubkeys.
				if (path === `/agents/${RECIPIENT_ID}/messages`) {
					return Promise.resolve({ items: [msg], next_cursor: null });
				}
				return Promise.resolve(keysResponse(SENDER_ID, senderKeys));
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

	// A4 — rine_read must decrypt a single hpke-hybrid-v1 message, not return it raw.
	it("rine_read decrypts a single hpke-hybrid-v1 message to its real plaintext", async () => {
		const ctx = makeRealCtx();
		const payload = { msg: "lattice forever" };
		const enc = await realEncryptMessage(
			dir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			payload,
			recipientKeys.pqEncryption!.publicKey,
		);
		expect(enc.encryption_version).toBe("hpke-hybrid-v1");

		mockFetchAgents.mockResolvedValue([
			{ id: RECIPIENT_ID, handle: "me@myorg.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue(RECIPIENT_ID);
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				if (path === "/messages/read-msg-1") {
					return Promise.resolve({
						id: "read-msg-1",
						type: "rine.v1.dm",
						encryption_version: enc.encryption_version,
						encrypted_payload: enc.encrypted_payload,
					});
				}
				return Promise.resolve(keysResponse(SENDER_ID, senderKeys));
			},
		);

		const out = (await rineRead.handler(ctx, {
			message_id: "read-msg-1",
			agent: RECIPIENT_ID,
		})) as Record<string, unknown>;

		expect(out.decrypted).toEqual(payload);
		expect(out.verified).toBe(true);
	});

	// T-MCP-1 — rine_thread returns both-sided ThreadEntry rows, resolving the
	// acting agent, and surfaces [unavailable] for an undecryptable row.
	it("rine_thread returns both-sided decrypted rows and [unavailable] for an undecryptable one", async () => {
		const ctx = makeRealCtx();
		// Turn 1: RECIPIENT (us) SENT to the peer → we read our self-blob.
		const sent = await realEncryptMessage(
			dir,
			RECIPIENT_ID,
			senderKeys.encryption.publicKey,
			{ text: "my question" },
			senderKeys.pqEncryption!.publicKey,
		);
		// Turn 2: the peer (SENDER) RECEIVED-side reply to us, sealed to our key.
		const received = await realEncryptMessage(
			dir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			{ text: "their answer" },
			recipientKeys.pqEncryption!.publicKey,
		);

		const page = {
			messages: [
				{
					id: "t1",
					type: "rine.v1.task_request",
					direction: "sent",
					sender_handle: "me@org",
					encryption_version: sent.encryption_version,
					encrypted_payload: sent.encrypted_payload,
					self_encrypted_payload: sent.self_encrypted_payload,
					created_at: "2026-06-20T00:00:00Z",
				},
				{
					id: "t2",
					type: "rine.v1.task_response",
					direction: "received",
					sender_handle: "alice@org",
					encryption_version: received.encryption_version,
					encrypted_payload: received.encrypted_payload,
					created_at: "2026-06-20T00:00:01Z",
				},
				{
					id: "t3",
					type: "rine.v1.dm",
					direction: "received",
					sender_handle: "alice@org",
					encryption_version: "hpke-v1",
					encrypted_payload: "AAAA",
					created_at: "2026-06-20T00:00:02Z",
				},
			],
			truncated: false,
		};

		mockFetchAgents.mockResolvedValue([
			{ id: RECIPIENT_ID, handle: "me@org.rine.network" },
		]);
		mockResolveAgent.mockResolvedValue(RECIPIENT_ID);
		(ctx.client.get as ReturnType<typeof vi.fn>).mockImplementation(
			(path: string) => {
				if (path === `/conversations/conv-1/messages`) {
					return Promise.resolve(page);
				}
				// Signature verification fetches the signer's pubkeys: the sent turn was
				// signed by us (RECIPIENT_ID), the received turn by the peer (SENDER_ID).
				if (path.includes(RECIPIENT_ID)) {
					return Promise.resolve(keysResponse(RECIPIENT_ID, recipientKeys));
				}
				return Promise.resolve(keysResponse(SENDER_ID, senderKeys));
			},
		);

		const out = (await rineThread.handler(ctx, {
			conversation_id: "conv-1",
		})) as {
			messages: Array<Record<string, unknown>>;
			truncated: boolean;
		};

		expect(mockResolveAgent).toHaveBeenCalled();
		expect(out.messages).toHaveLength(3);
		expect(out.messages[0]!.direction).toBe("sent");
		expect(out.messages[0]!.text).toBe("my question");
		expect(out.messages[1]!.direction).toBe("received");
		expect(out.messages[1]!.text).toBe("their answer");
		// Undecryptable row fails closed.
		expect(out.messages[2]!.text).toBe("[unavailable]");
		// No raw ciphertext field on the returned rows.
		expect(out.messages[0]!.encrypted_payload).toBeUndefined();
		expect(out.messages[0]!.self_encrypted_payload).toBeUndefined();
	});
});
