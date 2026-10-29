import type { RecipientTarget } from "@rine-network/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveActor = vi.fn();
const mockResolveRecipient = vi.fn();
const mockSealForAgent = vi.fn();
const mockAgentKeysExist = vi.fn();
const mockDecryptMessage = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveActor: (...args: unknown[]) => mockResolveActor(...args),
		resolveRecipient: (...args: unknown[]) => mockResolveRecipient(...args),
		sealForAgent: (...args: unknown[]) => mockSealForAgent(...args),
		agentKeysExist: (...args: unknown[]) => mockAgentKeysExist(...args),
		decryptMessage: (...args: unknown[]) => mockDecryptMessage(...args),
	};
});

// The real (un-mocked) core, so the bare-name case below drives the GENUINE
// recipient ladder — the rungs it climbs are `rine-core`'s and are gated there,
// but that a bare word reaches this verb as a GROUP, and stops here, is this
// file's to pin.
const realCore =
	await vi.importActual<typeof import("@rine-network/core")>(
		"@rine-network/core",
	);

const { messagingSyncTools } =
	await import("../../src/tools/messaging-sync.js");

const rineSendAndWait = messagingSyncTools.find(
	(t) => t.name === "rine_send_and_wait",
)!;

// Real UUIDs: the ids that reach the seal are bound into the signature scope
// and the key lookup, and a fixture that could not have been a real row is not
// a test.
const AGENT_ID = "a1b2c3d4-e5f6-4071-8293-a4b5c6d7e8f1";
const RECIPIENT_ID = "b2c3d4e5-f607-4182-93a4-b5c6d7e8f902";

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: "/tmp/test",
		ownerDir: "/tmp/test-owner",
		apiUrl: "https://api.test",
		refreshIdentity: vi.fn(),
	};
}

const post = (ctx: ToolContext) => ctx.client.post as ReturnType<typeof vi.fn>;
const get = (ctx: ToolContext) => ctx.client.get as ReturnType<typeof vi.fn>;

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

/**
 * Let the genuine ladder answer, for a case that must climb its real rungs.
 *
 * The 1:1 tests cannot: their arm ends in a WebFinger request that no
 * `ctx.client` mock can reach, because the ladder calls the agent resolver
 * inside `rine-core`'s own bundle rather than through this module's imports. A
 * bare name never gets that far — it is answered from `GET /agents` and
 * `GET /groups`, both of which are `ctx.client`'s.
 */
function ladderAnswersForReal(): void {
	mockResolveRecipient
		.mockReset()
		.mockImplementation(
			(...args: Parameters<typeof realCore.resolveRecipient>) =>
				realCore.resolveRecipient(...args),
		);
}

/** The reply row the server hands back inside a sync response. */
function replyRow() {
	return {
		id: "reply-1",
		type: "rine.v1.dm",
		from_agent_id: RECIPIENT_ID,
		to_agent_id: AGENT_ID,
		encryption_version: "hpke-hybrid-v2",
		encrypted_payload: "sealed",
		created_at: "2026-10-09T10:00:00.000Z",
	};
}

describe("rine_send_and_wait", () => {
	beforeEach(() => {
		mockResolveActor.mockReset().mockResolvedValue({ agentId: AGENT_ID });
		mockResolveRecipient
			.mockReset()
			.mockResolvedValue(agentTarget(RECIPIENT_ID, "peer@other.rine.network"));
		mockSealForAgent.mockReset().mockResolvedValue({
			encrypted_payload: "sealed",
			encryption_version: "hpke-hybrid-v2",
			sender_signing_kid: "kid-1",
		});
		mockAgentKeysExist.mockReset().mockReturnValue(false);
		mockDecryptMessage.mockReset();
	});

	it("posts the sealed body to /messages/sync with the wait as a query parameter", async () => {
		const ctx = makeCtx();
		post(ctx).mockResolvedValue({
			message: { id: "sent-1" },
			reply: null,
			conversation_id: "conv-1",
			status: "open",
		});

		await rineSendAndWait.handler(ctx, {
			to: "peer@other",
			payload: { text: "ping" },
			wait_seconds: 45,
		});

		const [path, body, headers] = post(ctx).mock.calls[0];
		expect(path).toBe("/messages/sync?timeout_ms=45000");
		expect(body).toMatchObject({
			to_agent_id: RECIPIENT_ID,
			type: "rine.v1.dm",
			encrypted_payload: "sealed",
			encryption_version: "hpke-hybrid-v2",
		});
		expect(headers).toEqual({ "X-Rine-Agent": AGENT_ID });
	});

	it("defaults the wait to 30 seconds when the caller names none", async () => {
		const ctx = makeCtx();
		post(ctx).mockResolvedValue({
			message: { id: "sent-1" },
			reply: null,
			conversation_id: "conv-1",
			status: "open",
		});

		await rineSendAndWait.handler(ctx, {
			to: "peer@other",
			payload: { text: "ping" },
		});

		expect(post(ctx).mock.calls[0][0]).toBe("/messages/sync?timeout_ms=30000");
	});

	it("returns the reply decrypted, with the verdict the decrypt reached", async () => {
		const ctx = makeCtx();
		mockAgentKeysExist.mockReturnValue(true);
		mockDecryptMessage.mockResolvedValue({
			plaintext: JSON.stringify({ text: "pong" }),
			verified: true,
			verificationStatus: "verified",
		});
		post(ctx).mockResolvedValue({
			message: { id: "sent-1" },
			reply: replyRow(),
			conversation_id: "conv-1",
			status: "open",
		});

		const result = (await rineSendAndWait.handler(ctx, {
			to: "peer@other",
			payload: { text: "ping" },
		})) as { reply: { decrypted?: unknown; verified?: boolean } };

		expect(result.reply.decrypted).toEqual({ text: "pong" });
		expect(result.reply.verified).toBe(true);
	});

	it("reports a wait that elapsed as a null reply, not as a failure", async () => {
		const ctx = makeCtx();
		post(ctx).mockResolvedValue({
			message: { id: "sent-1" },
			reply: null,
			conversation_id: "conv-1",
			status: "open",
		});

		const result = (await rineSendAndWait.handler(ctx, {
			to: "peer@other",
			payload: { text: "ping" },
			wait_seconds: 1,
		})) as { reply: unknown; message: { id: string } };

		expect(result.reply).toBeNull();
		expect(result.message.id).toBe("sent-1");
		expect(mockDecryptMessage).not.toHaveBeenCalled();
	});

	it("refuses a group handle before it makes any call at all", async () => {
		const ctx = makeCtx();

		await expect(
			rineSendAndWait.handler(ctx, {
				to: "#dev@acme",
				payload: { text: "ping" },
			}),
		).rejects.toThrow(
			"rine_send_and_wait is 1:1 only — the /messages/sync endpoint refuses " +
				"a group handle. Use rine_send to post to a group.",
		);

		// Refused on syntax, so nothing has been resolved and there is no group to
		// name — the refusal ladder's rung 2, and it describes rather than prints
		// one.
		expect(mockResolveRecipient).not.toHaveBeenCalled();
		expect(mockResolveActor).not.toHaveBeenCalled();
		expect(mockSealForAgent).not.toHaveBeenCalled();
		expect(post(ctx)).not.toHaveBeenCalled();
	});

	// A bare word is a GROUP reference on this path, so it no longer dies on
	// the agent resolver's syntactic "expected a UUID or handle" — it climbs
	// the same ladder rine_send climbs, and stops here because this verb is
	// 1:1. The refusal is the ladder's rung 1: the group's OWN handle, off the
	// row the ladder already read, never the caller's spelling and never a
	// placeholder domain.
	it("resolves a bare name as a group and refuses it by its own handle", async () => {
		const ctx = makeCtx();
		ladderAnswersForReal();
		get(ctx).mockImplementation((path: string) =>
			path === "/agents"
				? { items: [{ id: "a-1", name: "mybot", handle: "mybot@acme.rine.network" }] }
				: {
						items: [
							{
								id: "g-1",
								name: "ops",
								handle: "#ops@acme.rine.network",
							},
						],
					},
		);

		await expect(
			rineSendAndWait.handler(ctx, { to: "ops", payload: { text: "ping" } }),
		).rejects.toThrow(
			"rine_send_and_wait is 1:1 only — the /messages/sync endpoint refuses " +
				"the group #ops@acme.rine.network. Use rine_send to post to a group.",
		);

		expect(post(ctx)).not.toHaveBeenCalled();
		expect(mockSealForAgent).not.toHaveBeenCalled();
	});

	// 🔴 The other half of the ratified route, and the arm that separates this
	// verb from `rine_send`: the ladder MISSED. A `rine_send_and_wait` is 1:1 by
	// construction, so the only thing a bare word can have meant here is an agent
	// handle with the org half dropped — and the ladder's own miss leads with
	// `Group not found` and closes with a roster of groups this verb refuses
	// anyway. Only the miss falls back; the two arms below must not.
	it("answers a bare name no group answers to in the agent namespace", async () => {
		const ctx = makeCtx();
		ladderAnswersForReal();
		get(ctx).mockImplementation((path: string) =>
			path === "/agents"
				? { items: [{ id: "a-1", name: "mybot", handle: "mybot@acme.rine.network" }] }
				: {
						items: [
							{ id: "g-1", name: "ops", handle: "#ops@acme.rine.network" },
						],
					},
		);

		const refusal = await rineSendAndWait
			.handler(ctx, { to: "kofi", payload: { text: "ping" } })
			.then(
				() => "resolved",
				(e: Error) => e.message,
			);

		// `rine-core`'s own sentence, composed by the agent resolver and not copied
		// here — a re-pin of it reaches this verb without touching this file.
		expect(refusal).toBe(realCore.invalidAgentIdentifierRefusal("kofi"));
		// Neither the group lead nor the roster of groups it cannot use survives.
		expect(refusal).not.toContain(realCore.GROUP_NOT_FOUND_LEAD);
		expect(refusal).not.toContain("#ops@acme.rine.network");
		expect(post(ctx)).not.toHaveBeenCalled();
		expect(mockSealForAgent).not.toHaveBeenCalled();
	});

	// 🔴 The bounds above, on the verb that fell back. The fall-back may not
	// swallow this: two groups answering to one word is the case that must
	// never be guessed at, and answering it with "that is not an agent
	// identifier" would send the caller back to a spelling that resolves to two
	// things.
	it("still refuses an ambiguous bare name by naming both groups", async () => {
		const ctx = makeCtx();
		ladderAnswersForReal();
		get(ctx).mockImplementation((path: string) =>
			path === "/agents"
				? { items: [] }
				: {
						items: [
							{ id: "g-1", name: "ops", handle: "#ops@acme.rine.network" },
							{ id: "g-2", name: "ops", handle: "#ops@partner.rine.network" },
						],
					},
		);

		const refusal = await rineSendAndWait
			.handler(ctx, { to: "ops", payload: { text: "ping" } })
			.then(
				() => "resolved",
				(e: Error) => e.message,
			);

		expect(refusal).toContain("is ambiguous");
		expect(refusal).toContain("#ops@acme.rine.network");
		expect(refusal).toContain("#ops@partner.rine.network");
		expect(post(ctx)).not.toHaveBeenCalled();
	});

	// The collision guard, the other bound the fall-back must not swallow. A
	// caller who meant `mybot@acme` and wrote `mybot` is told which handle sends
	// the DM — not that `mybot` is an invalid agent identifier, which it is not.
	it("still refuses a bare name that is one of the org's own agents", async () => {
		const ctx = makeCtx();
		ladderAnswersForReal();
		get(ctx).mockImplementation((path: string) =>
			path === "/agents"
				? { items: [{ id: "a-1", name: "mybot", handle: "mybot@acme.rine.network" }] }
				: { items: [] },
		);

		const refusal = await rineSendAndWait
			.handler(ctx, { to: "mybot", payload: { text: "ping" } })
			.then(
				() => "resolved",
				(e: Error) => e.message,
			);

		expect(refusal).toContain("is the name of an agent of your org");
		expect(refusal).toContain("mybot@acme.rine.network");
		expect(post(ctx)).not.toHaveBeenCalled();
	});

	it("names the bounds when the wait is outside what the server accepts", async () => {
		const ctx = makeCtx();

		await expect(
			rineSendAndWait.handler(ctx, {
				to: "peer@other",
				payload: { text: "ping" },
				wait_seconds: 3600,
			}),
		).rejects.toThrow(/between 1 and 300/);

		expect(post(ctx)).not.toHaveBeenCalled();
	});

	it("seals the payload for the resolved recipient as the acting agent", async () => {
		const ctx = makeCtx();
		post(ctx).mockResolvedValue({
			message: { id: "sent-1" },
			reply: null,
			conversation_id: "conv-1",
			status: "open",
		});

		await rineSendAndWait.handler(ctx, {
			to: "peer@other",
			payload: { text: "ping" },
		});

		expect(mockSealForAgent).toHaveBeenCalledWith(
			ctx.client,
			ctx.configDir,
			{ senderAgentId: AGENT_ID, recipientAgentId: RECIPIENT_ID },
			{ text: "ping" },
		);
	});
});
