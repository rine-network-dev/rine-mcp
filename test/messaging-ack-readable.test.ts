/**
 * `rine_inbox` must stop consuming rows it could not read: it marks delivered
 * only the rows that actually decrypted, and leaves the rest for another look.
 *
 * The mark-delivered call is what takes a row out of `?status=new`, `/poll` and
 * SSE catch-up, and there is no un-mark route — so acking a row that came back
 * sealed spends the only remaining chance to open it. This listing used to ack
 * the whole page, readable or not.
 *
 * 🔴 **The assertion is on the wire.** Every test here reads the ids the handler
 * actually passed to `markDelivered`, never a predicate's return value: the
 * property under test is which ids reach the server, and a test that asked
 * `rowOpened` directly would pass while the handler filtered nothing.
 *
 * The crypto is REAL on every arm. A fixture whose readability is mocked cannot
 * tell the four classes of row apart, and it is precisely the classes that
 * `openInboxRow` returns UNCHANGED — no `decrypted` and no `decrypt_error` —
 * that make the `!decrypt_error` idiom the other surfaces use unsound here.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageRead } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/tools/types.js";
import { FIXTURE_ROOT, keysGet, seedAgentKeys } from "@rine-network/core/testing";

const mockResolveActor = vi.fn();

// Actor resolution is the one collaborator stubbed: it needs a server to answer
// which of an org's agents acts, and it is not what these tests measure.
vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveActor: (...args: unknown[]) => mockResolveActor(...args),
	};
});

const realCore =
	await vi.importActual<typeof import("@rine-network/core")>(
		"@rine-network/core",
	);
const {
	deriveAgent,
	deriveBranch,
	deriveOrg,
	encryptGroupMessage,
	encryptMessage,
	generateSenderKey,
	saveSenderKeyState,
} = realCore;

const { inboxTools } = await import("../src/tools/messaging-inbox.js");
const rineInbox = inboxTools.find((t) => t.name === "rine_inbox")!;

// Real UUIDs: the group paths carry these into routes the server types as
// `uuid.UUID`, and a fixture that could not have been a real row is not a test.
const SENDER_ID = "a1b2c3d4-e5f6-4071-8293-a4b5c6d7e8f1";
const RECIPIENT_ID = "b2c3d4e5-f607-4182-93a4-b5c6d7e8f902";
const THIRD_ID = "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a13";
const GROUP_ID = "d4e5f607-1829-43a4-b5c6-d7e8f90a1b24";

let dir: string;

// The recipient's published keys, exactly what `fetchRecipientKeys` would hand
// back for a fixture-org agent: the seal is built against the same chain the
// server publishes, so the decrypt genuinely opens.
const recipientDerived = deriveAgent(
	deriveBranch(deriveOrg(FIXTURE_ROOT), "main"),
	RECIPIENT_ID,
	0,
);
const recipientKeys = {
	encryption: recipientDerived.x25519.publicKey,
	pqEncryption: recipientDerived.mlKem768.publicKey,
};

/** A row's server stamp: a decrypt of a row without one fails closed. */
const CREATED_AT = "2026-10-09T10:00:00.000Z";

/**
 * A ctx whose GET answers the inbox listing and the published-key lookups the
 * verify path makes. `markDelivered` records rather than asserts — the tests
 * read its arguments.
 */
function makeCtx(rows: MessageRead[]): ToolContext {
	const get = vi.fn((path: string) => {
		if (path === `/agents/${RECIPIENT_ID}/messages`) {
			return Promise.resolve({ items: rows, next_cursor: null });
		}
		return Promise.resolve(keysGet(path));
	});
	return {
		client: {
			get,
			post: vi.fn(),
			markDelivered: vi.fn().mockResolvedValue({ marked: 0 }),
		} as never,
		configDir: dir,
		ownerDir: join(dir, "owner"),
		apiUrl: "https://api.test",
		refreshIdentity: vi.fn(),
	};
}

const markDeliveredMock = (ctx: ToolContext) =>
	(ctx.client as unknown as { markDelivered: ReturnType<typeof vi.fn> })
		.markDelivered;

/** The ids this listing actually asked the server to consume. */
function ackedIds(ctx: ToolContext): string[] {
	const calls = markDeliveredMock(ctx).mock.calls;
	expect(calls).toHaveLength(1);
	return calls[0]![1] as string[];
}

/** A 1:1 envelope this agent can open, signed by the sender the row names. */
async function openableRow(id: string): Promise<MessageRead> {
	const enc = await encryptMessage(
		dir,
		SENDER_ID,
		RECIPIENT_ID,
		recipientKeys,
		{ text: `opened ${id}` },
	);
	return {
		id,
		type: "rine.v1.dm",
		from_agent_id: SENDER_ID,
		encryption_version: "hpke-hybrid-v2",
		encrypted_payload: enc.encrypted_payload,
		created_at: CREATED_AT,
	} as MessageRead;
}

/**
 * A group row sealed under a sender key this agent holds no state for — the
 * transient class the readable-only ack exists to protect. It carries
 * `decrypt_error` and may become readable once the distribution arrives.
 */
async function sealedGroupRow(id: string): Promise<MessageRead> {
	const state = generateSenderKey(GROUP_ID, SENDER_ID);
	// The sender's own copy, which the encrypt advances in place; deliberately
	// never saved for RECIPIENT_ID.
	saveSenderKeyState(dir, SENDER_ID, GROUP_ID, [state]);
	const { result: enc } = await encryptGroupMessage(
		dir,
		SENDER_ID,
		GROUP_ID,
		state,
		{ text: "you cannot read this" },
	);
	return {
		id,
		type: "rine.v1.dm",
		from_agent_id: SENDER_ID,
		group_id: GROUP_ID,
		encryption_version: "sender-key-v1",
		encrypted_payload: enc.encrypted_payload,
		created_at: CREATED_AT,
	} as MessageRead;
}

/**
 * A row the server listed with no authenticated sender. `openInboxRow` hands it
 * straight back — no `decrypted` AND no `decrypt_error` — which is the class
 * that makes `!decrypt_error` the wrong predicate on this surface.
 */
async function unattributedRow(id: string): Promise<MessageRead> {
	const enc = await encryptMessage(
		dir,
		SENDER_ID,
		RECIPIENT_ID,
		recipientKeys,
		{ text: "no sender on the row" },
	);
	return {
		id,
		type: "rine.v1.dm",
		encryption_version: "hpke-hybrid-v2",
		encrypted_payload: enc.encrypted_payload,
		created_at: CREATED_AT,
	} as MessageRead;
}

/**
 * A row whose envelope was signed by SENDER_ID while the server attributes it
 * to THIRD_ID: an authenticity refusal, permanent by construction.
 */
async function forgedRow(id: string): Promise<MessageRead> {
	const row = await openableRow(id);
	return { ...row, from_agent_id: THIRD_ID };
}

/**
 * The SAME forgery as {@link forgedRow}, in the encryption that changes how it
 * arrives.
 *
 * 🔴 This fixture exists because {@link forgedRow} cannot see the defect it was
 * written to cover: the 1:1 decrypt RETURNS a `RefusedDecrypt`, so its verdict
 * reaches the row builder, while the group decrypt THROWS — the refusal only
 * reaches the caller if the opener's `catch` asks. And group messages are the
 * entire motivating class of this pass.
 *
 * The recipient is handed the sender's own chain key, taken BEFORE the seal
 * advances it (a deep copy — `chainKey` is a view the seal overwrites), so the
 * ciphertext genuinely opens and the authenticity check genuinely is what
 * refuses it. A fixture the recipient held no key for would refuse one step
 * earlier, as the transient sealed class, and prove nothing.
 */
async function forgedGroupRow(id: string): Promise<MessageRead> {
	const state = generateSenderKey(GROUP_ID, SENDER_ID);
	saveSenderKeyState(dir, RECIPIENT_ID, GROUP_ID, [
		{ ...state, chainKey: new Uint8Array(state.chainKey) },
	]);
	saveSenderKeyState(dir, SENDER_ID, GROUP_ID, [state]);
	const { result: enc } = await encryptGroupMessage(
		dir,
		SENDER_ID,
		GROUP_ID,
		state,
		{ text: "signed by someone else" },
	);
	return {
		id,
		type: "rine.v1.dm",
		from_agent_id: THIRD_ID,
		group_id: GROUP_ID,
		encryption_version: "sender-key-v1",
		encrypted_payload: enc.encrypted_payload,
		created_at: CREATED_AT,
	} as MessageRead;
}

/**
 * A row that was never ciphertext: `encryption_version: "none"`, which
 * `src/rine/api/a2a_messages.py` writes for any agent whose A2A card sets
 * `a2a_accept_cleartext`, with the parts JSON-encoded into the payload field
 * (`a2a_translate.py`).
 *
 * 🔴 Recorded from `git archive HEAD` rather than written against the fix: this
 * exact shape was the fixture in `test/tools/inbox.test.ts` until this pass
 * replaced it with an openable row, which is the only reason the new ack filter
 * could have shipped consuming nothing of this class. A gate authored with the
 * code it guards pins whatever that code does; this one predates it.
 */
function cleartextRow(id: string): MessageRead {
	return {
		id,
		type: "rine.v1.text",
		from_agent_id: SENDER_ID,
		encryption_version: "none",
		encrypted_payload: JSON.stringify([{ kind: "text", text: `plain ${id}` }]),
		created_at: CREATED_AT,
	} as MessageRead;
}

describe("rine_inbox — the ack list is the rows that were accounted for", () => {
	beforeEach(() => {
		mockResolveActor.mockReset().mockResolvedValue({ agentId: RECIPIENT_ID });
		dir = fs.mkdtempSync(join(tmpdir(), "rine-mcp-ack-"));
		seedAgentKeys(dir, SENDER_ID);
		seedAgentKeys(dir, RECIPIENT_ID);
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("acks every id on a page whose rows all opened", async () => {
		const rows = [await openableRow("open-1"), await openableRow("open-2")];
		const ctx = makeCtx(rows);

		const result = (await rineInbox.handler(ctx, { status: "new" })) as {
			items: Array<Record<string, unknown>>;
		};

		expect(result.items.map((r) => r.decrypted)).toEqual([
			{ text: "opened open-1" },
			{ text: "opened open-2" },
		]);
		expect(ackedIds(ctx)).toEqual(["open-1", "open-2"]);
		expect(markDeliveredMock(ctx)).toHaveBeenCalledWith(
			RECIPIENT_ID,
			["open-1", "open-2"],
			{ "X-Rine-Agent": RECIPIENT_ID },
		);
	});

	it("leaves a sealed row out of the ack while its readable neighbour stays in", async () => {
		const rows = [
			await openableRow("open-1"),
			await sealedGroupRow("sealed-1"),
			await openableRow("open-2"),
		];
		const ctx = makeCtx(rows);

		const result = (await rineInbox.handler(ctx, { status: "new" })) as {
			items: Array<Record<string, unknown>>;
		};

		// The row really is the unreadable-but-may-heal class, not a fixture that
		// failed for some other reason.
		expect(result.items[1]!.decrypted).toBeUndefined();
		expect(result.items[1]!.decrypt_error).toContain("sealed under sender key");

		expect(ackedIds(ctx)).toEqual(["open-1", "open-2"]);
		expect(ackedIds(ctx)).not.toContain("sealed-1");
	});

	it("leaves out a row that came back with no verdict at all", async () => {
		const rows = [await openableRow("open-1"), await unattributedRow("bare-1")];
		const ctx = makeCtx(rows);

		const result = (await rineInbox.handler(ctx, { status: "new" })) as {
			items: Array<Record<string, unknown>>;
		};

		// Neither field — so `!decrypt_error` would have called this row readable
		// and acked it. `rowOpened` asks the positive question instead.
		expect(result.items[1]!.decrypted).toBeUndefined();
		expect(result.items[1]!.decrypt_error).toBeUndefined();

		expect(ackedIds(ctx)).toEqual(["open-1"]);
	});

	it("does not call markDelivered at all when nothing on the page opened", async () => {
		const ctx = makeCtx([
			await sealedGroupRow("sealed-1"),
			await unattributedRow("bare-1"),
		]);

		await rineInbox.handler(ctx, { status: "new" });

		expect(markDeliveredMock(ctx)).not.toHaveBeenCalled();
	});

	// The one deliberate exception, and today's behaviour for this class: a
	// signature that does not check out never becomes valid, so preserving the
	// row would pin it at the head of every future listing forever.
	it("still acks a row refused for authenticity, and hands back no content for it", async () => {
		const rows = [await forgedRow("forged-1"), await openableRow("open-1")];
		const ctx = makeCtx(rows);

		const result = (await rineInbox.handler(ctx, { status: "new" })) as {
			items: Array<Record<string, unknown>>;
		};

		expect(result.items[0]!.verification_status).toBe("sender-mismatch");
		expect(result.items[0]!.decrypted).toBeUndefined();
		expect(ackedIds(ctx)).toEqual(["forged-1", "open-1"]);
	});

	// 🔴 The mutation guard for the group arm: delete either opener's
	// `groupAuthenticityStatus` check and this row goes back with no verdict
	// field, which reads to the ack filter as the transient sealed class — so the
	// forged row stays `new` and heads every future listing for the life of the
	// agent, with nothing that can ever make it verify.
	it("acks a GROUP row refused for authenticity, whose refusal arrives as a throw", async () => {
		const rows = [await forgedGroupRow("forged-g1"), await openableRow("open-1")];
		const ctx = makeCtx(rows);

		const result = (await rineInbox.handler(ctx, { status: "new" })) as {
			items: Array<Record<string, unknown>>;
		};

		// The verdict, not merely the absence of content: an unreadable row has no
		// content either, and the two get opposite treatment.
		expect(result.items[0]!.verification_status).toBe("sender-mismatch");
		expect(result.items[0]!.verified).toBe(false);
		expect(result.items[0]!.decrypted).toBeUndefined();
		expect(result.items[0]!.decrypt_error).toBeUndefined();
		expect(ackedIds(ctx)).toEqual(["forged-g1", "open-1"]);
	});

	// 🔴 The mutation guard for the never-ciphertext arm: drop
	// `rowNeverCiphertext` from the filter and this row's fate is decided by
	// falling off the end of two envelope predicates — left `new`, growing by one
	// per inbound A2A message, with no verb on this surface that can clear it.
	it("acks a row that was never ciphertext, and hands it no verdict", async () => {
		const ctx = makeCtx([cleartextRow("plain-1"), await openableRow("open-1")]);

		const result = (await rineInbox.handler(ctx, { status: "new" })) as {
			items: Array<Record<string, unknown>>;
		};

		// Nothing was opened and nothing was refused — there was never anything to
		// open, so the row carries neither a verdict nor an explanation.
		expect(result.items[0]!.decrypted).toBeUndefined();
		expect(result.items[0]!.verification_status).toBeUndefined();
		expect(result.items[0]!.decrypt_error).toBeUndefined();
		expect(ackedIds(ctx)).toEqual(["plain-1", "open-1"]);
	});

	it("returns every row to the caller, acked or not", async () => {
		const rows = [
			await openableRow("open-1"),
			await sealedGroupRow("sealed-1"),
			await unattributedRow("bare-1"),
		];
		const ctx = makeCtx(rows);

		const result = (await rineInbox.handler(ctx, { status: "new" })) as {
			items: Array<Record<string, unknown>>;
		};

		expect(result.items.map((r) => r.id)).toEqual([
			"open-1",
			"sealed-1",
			"bare-1",
		]);
		expect(ackedIds(ctx)).toEqual(["open-1"]);
	});

	it("acks nothing at all on status=all, readable row included", async () => {
		const rows = [await openableRow("open-1"), await sealedGroupRow("sealed-1")];
		const ctx = makeCtx(rows);

		await rineInbox.handler(ctx, { status: "all" });

		// 🔴 NOT "acks only the readable row" — that is what this asserted before,
		// and it was the defect. `status: "all"` is a browse over history, and it
		// used to spend the unread mail sitting inside that history: ask to see
		// everything, and every row you had not read yet is silently consumed.
		// `open-1` opens here and must still be `new` on the server afterwards, so
		// the next `status: "new"` read is still offered it. On `new` the mark is
		// correct and stays — that is the read, and the assertions above cover it.
		//
		// `rine-mastra` and `rine-eve` already return before marking on every
		// non-`new` status and both say so in their tool descriptions; this
		// assertion is what holds this surface on their behaviour rather than
		// leaving the three to drift apart again.
		expect(markDeliveredMock(ctx)).not.toHaveBeenCalled();
	});
});
