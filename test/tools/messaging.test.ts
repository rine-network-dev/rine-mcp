import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveToUuid = vi.fn();
const mockFetchAgents = vi.fn();
const mockResolveAgent = vi.fn();
const mockEncryptMessage = vi.fn();
const mockEncryptGroupMessage = vi.fn();
const mockFetchRecipientEncryptionKey = vi.fn();
const mockGetOrCreateSenderKey = vi.fn();
const mockAgentKeysExist = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveToUuid: (...args: unknown[]) => mockResolveToUuid(...args),
		fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
		resolveAgent: (...args: unknown[]) => mockResolveAgent(...args),
		encryptMessage: (...args: unknown[]) => mockEncryptMessage(...args),
		encryptGroupMessage: (...args: unknown[]) => mockEncryptGroupMessage(...args),
		fetchRecipientEncryptionKey: (...args: unknown[]) => mockFetchRecipientEncryptionKey(...args),
		getOrCreateSenderKey: (...args: unknown[]) => mockGetOrCreateSenderKey(...args),
		agentKeysExist: (...args: unknown[]) => mockAgentKeysExist(...args),
	};
});

const { messagingTools } = await import("../../src/tools/messaging.js");

const rineSend = messagingTools.find(t => t.name === "rine_send")!;

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
		mockFetchRecipientEncryptionKey.mockReset();
		mockGetOrCreateSenderKey.mockReset();
		mockAgentKeysExist.mockReset();
	});

	it("short agent handle is normalized before resolveToUuid", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([{ id: "sender-uuid", handle: "bot@myorg.rine.network" }]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockResolveToUuid.mockResolvedValue("recipient-uuid");
		mockFetchRecipientEncryptionKey.mockResolvedValue({ publicKey: "some-key" });
		mockEncryptMessage.mockResolvedValue({ encrypted_payload: "enc", encryption_version: "hpke-v1" });
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-1" });

		await rineSend.handler(ctx, { to: "alice@acmecorp", payload: { text: "hello" } });

		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", "alice@acmecorp.rine.network");
	});

	it("full agent handle passes through unchanged", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([{ id: "sender-uuid", handle: "bot@myorg.rine.network" }]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockResolveToUuid.mockResolvedValue("recipient-uuid");
		mockFetchRecipientEncryptionKey.mockResolvedValue({ publicKey: "some-key" });
		mockEncryptMessage.mockResolvedValue({ encrypted_payload: "enc", encryption_version: "hpke-v1" });
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-1" });

		await rineSend.handler(ctx, { to: "alice@acmecorp.rine.network", payload: { text: "hello" } });

		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", "alice@acmecorp.rine.network");
	});

	it("short group handle is normalized before getOrCreateSenderKey", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([{ id: "sender-uuid", handle: "bot@myorg.rine.network" }]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockGetOrCreateSenderKey.mockResolvedValue({ state: {}, groupId: "group-uuid" });
		mockEncryptGroupMessage.mockResolvedValue({
			result: { encrypted_payload: "enc-group", encryption_version: "sender-key-v1" },
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-2" });

		await rineSend.handler(ctx, { to: "#dev@acmecorp", payload: { text: "hello group" } });

		const gocskCall = mockGetOrCreateSenderKey.mock.calls[0];
		// getOrCreateSenderKey(client, configDir, agentId, to, extraHeaders)
		const handleArg = gocskCall![3];
		expect(handleArg).toBe("#dev@acmecorp.rine.network");

		const postCall = (ctx.client.post as ReturnType<typeof vi.fn>).mock.calls[0];
		const postBody = postCall![1] as Record<string, unknown>;
		expect(postBody.to_handle).toBe("#dev@acmecorp.rine.network");
	});

	it("full group handle passes through unchanged", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([{ id: "sender-uuid", handle: "bot@myorg.rine.network" }]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockGetOrCreateSenderKey.mockResolvedValue({ state: {}, groupId: "group-uuid" });
		mockEncryptGroupMessage.mockResolvedValue({
			result: { encrypted_payload: "enc-group", encryption_version: "sender-key-v1" },
		});
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-3" });

		await rineSend.handler(ctx, { to: "#dev@acmecorp.rine.network", payload: { text: "hello" } });

		const gocskCall = mockGetOrCreateSenderKey.mock.calls[0];
		const handleArg = gocskCall![3];
		expect(handleArg).toBe("#dev@acmecorp.rine.network");
	});

	it("UUID recipient bypasses normalization", async () => {
		const ctx = makeCtx();
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		mockFetchAgents.mockResolvedValue([{ id: "sender-uuid", handle: "bot@myorg.rine.network" }]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockResolveToUuid.mockResolvedValue(uuid);
		mockFetchRecipientEncryptionKey.mockResolvedValue({ publicKey: "some-key" });
		mockEncryptMessage.mockResolvedValue({ encrypted_payload: "enc", encryption_version: "hpke-v1" });
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-4" });

		await rineSend.handler(ctx, { to: uuid, payload: { text: "hello" } });

		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", uuid);
	});

	it("from short handle resolves sender correctly", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([{ id: "sender-uuid", handle: "mybot@myorg.rine.network" }]);
		mockResolveAgent.mockResolvedValue("sender-uuid");
		mockResolveToUuid.mockResolvedValue("recipient-uuid");
		mockFetchRecipientEncryptionKey.mockResolvedValue({ publicKey: "some-key" });
		mockEncryptMessage.mockResolvedValue({ encrypted_payload: "enc", encryption_version: "hpke-v1" });
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-5" });

		await rineSend.handler(ctx, {
			to: "alice@acmecorp.rine.network",
			from: "mybot",
			payload: { text: "hello" },
		});

		expect(mockResolveAgent).toHaveBeenCalled();
		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", "alice@acmecorp.rine.network");
	});
});
