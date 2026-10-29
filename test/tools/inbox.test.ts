import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveActor = vi.fn();
const mockAgentKeysExist = vi.fn();
const mockDecryptMessage = vi.fn();
const mockDecryptGroupMessage = vi.fn();
const mockIngestSenderKeyDistribution = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveActor: (...args: unknown[]) => mockResolveActor(...args),
		agentKeysExist: (...args: unknown[]) => mockAgentKeysExist(...args),
		decryptMessage: (...args: unknown[]) => mockDecryptMessage(...args),
		decryptGroupMessage: (...args: unknown[]) => mockDecryptGroupMessage(...args),
		ingestSenderKeyDistribution: (...args: unknown[]) => mockIngestSenderKeyDistribution(...args),
	};
});

const { inboxTools } = await import("../../src/tools/messaging-inbox.js");

const rineInbox = inboxTools.find(t => t.name === "rine_inbox")!;

function makeCtx(): ToolContext {
	return {
		client: {
			get: vi.fn(),
			post: vi.fn(),
			markDelivered: vi.fn(),
		} as never,
		configDir: "/tmp/test",
		apiUrl: "https://api.test",
	};
}

const AGENT_ID = "agent-uuid-1";

function makeInboxResponse(items: unknown[] = []) {
	return { items, total: items.length, next_cursor: null, prev_cursor: null };
}

/**
 * A row that OPENS.
 *
 * `rine_inbox` acks only the rows it could actually account for
 * (`test/messaging-ack-readable.test.ts` pins both arms), so a fixture the
 * decrypt never opened is deliberately no longer in the mark-delivered call.
 * The two tests below are about the ack CALL — that it fires with the page's
 * ids, and that a failure is swallowed — so their rows have to be readable
 * ones, or they assert nothing.
 */
function openableRow(id: string) {
	return { id, encryption_version: "hpke-hybrid-v2", type: "rine.v1.dm", from_agent_id: "sender-uuid-1" };
}

/** Make the mocked 1:1 decrypt open whatever it is handed. */
function opensForReal() {
	mockAgentKeysExist.mockReturnValue(true);
	mockDecryptMessage.mockResolvedValue({
		plaintext: JSON.stringify({ text: "hi" }),
		verified: true,
		verificationStatus: "verified",
		senderKid: "rine:sender-uuid-1",
	});
}

describe("rine_inbox — status filter and auto-mark", () => {
	beforeEach(() => {
		mockResolveActor.mockReset();
		mockAgentKeysExist.mockReset();
		mockDecryptMessage.mockReset();
		mockDecryptGroupMessage.mockReset();
		mockIngestSenderKeyDistribution.mockReset();

		mockResolveActor.mockResolvedValue({ agentId: AGENT_ID });
		mockAgentKeysExist.mockReturnValue(false);
	});

	it("default call passes status=new to API", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeInboxResponse());
		(ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> }).markDelivered.mockResolvedValue({ marked: 0 });

		await rineInbox.handler(ctx, {});

		expect(ctx.client.get).toHaveBeenCalledWith(
			`/agents/${AGENT_ID}/messages`,
			expect.objectContaining({ status: "new" }),
			expect.any(Object),
		);
	});

	it("status=all does not pass status param to API", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeInboxResponse());
		(ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> }).markDelivered.mockResolvedValue({ marked: 0 });

		await rineInbox.handler(ctx, { status: "all" });

		const params = (ctx.client.get as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(params).not.toHaveProperty("status");
	});

	it("calls markDelivered after fetching new messages", async () => {
		const ctx = makeCtx();
		opensForReal();
		const msgs = [openableRow("msg-1"), openableRow("msg-2")];
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeInboxResponse(msgs));
		(ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> }).markDelivered.mockResolvedValue({ marked: 2 });

		await rineInbox.handler(ctx, {});

		expect((ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> }).markDelivered)
			.toHaveBeenCalledWith(AGENT_ID, ["msg-1", "msg-2"], { "X-Rine-Agent": AGENT_ID });
	});

	it("does not call markDelivered for status=delivered", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeInboxResponse([{ id: "msg-1", encryption_version: "none", type: "rine.v1.text" }])
		);

		await rineInbox.handler(ctx, { status: "delivered" });

		expect((ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> }).markDelivered)
			.not.toHaveBeenCalled();
	});

	it("does not call markDelivered for status=read", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeInboxResponse([{ id: "msg-1", encryption_version: "none", type: "rine.v1.text" }])
		);

		await rineInbox.handler(ctx, { status: "read" });

		expect((ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> }).markDelivered)
			.not.toHaveBeenCalled();
	});

	it("skips markDelivered when inbox is empty", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeInboxResponse([]));

		await rineInbox.handler(ctx, {});

		expect((ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> }).markDelivered)
			.not.toHaveBeenCalled();
	});

	it("markDelivered failure is non-fatal", async () => {
		const ctx = makeCtx();
		opensForReal();
		const msgs = [openableRow("msg-1")];
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeInboxResponse(msgs));
		(ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> }).markDelivered
			.mockRejectedValue(new Error("network error"));

		const result = await rineInbox.handler(ctx, {});
		expect((result as { items: unknown[] }).items).toHaveLength(1);
	});
});
