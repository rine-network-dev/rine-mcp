/**
 * An A2A cleartext row carries the typed flag, the notice and its posted parts on both
 * openers, so a model reading it is told the body was not end-to-end encrypted. A row of any other
 * type or version stays exactly as it arrived.
 */
import type { MessageRead, SenderKeyExplainer } from "@rine-network/core";
import { A2A_CLEARTEXT_NOTICE } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { openInboxRow, openMessage } from "../src/tools/messaging-decrypt.js";
import type { ToolContext } from "../src/tools/types.js";

const AGENT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ctx = { configDir: "/nonexistent" } as ToolContext;
const explain = (() => {
	throw new Error("an A2A row has no sender-key cause to explain");
}) as unknown as SenderKeyExplainer;

/** The wire payload of an A2A message with the single text part "plain", as the server serves it. */
const WIRE_PAYLOAD = "W3sidGV4dCI6ICJwbGFpbiJ9XQ";

function row(type: string, encryptionVersion: string): MessageRead {
	return {
		id: "m1",
		type,
		from_agent_id: AGENT,
		encryption_version: encryptionVersion,
		encrypted_payload: WIRE_PAYLOAD,
		created_at: "2026-10-13T00:00:00Z",
	} as MessageRead;
}

describe("A2A cleartext rows", () => {
	it("test_openInboxRow_when_the_row_is_a2a_cleartext_then_it_carries_the_flag_and_notice", async () => {
		const opened = await openInboxRow(ctx, AGENT, row("rine.v1.a2a_message", "none"), explain);

		expect(opened).toMatchObject({
			a2a_cleartext: true,
			a2a_cleartext_notice: A2A_CLEARTEXT_NOTICE,
		});
	});

	it("test_openInboxRow_when_the_row_is_a2a_cleartext_then_the_posted_parts_are_the_decrypted_body_and_unverified", async () => {
		const opened = await openInboxRow(ctx, AGENT, row("rine.v1.a2a_message", "none"), explain);

		expect(opened).toMatchObject({
			decrypted: [{ text: "plain" }],
			verified: false,
			verification_status: "unverifiable",
		});
	});

	it("test_openMessage_when_the_row_is_a2a_cleartext_then_it_carries_the_flag_and_notice", async () => {
		const opened = await openMessage(ctx, AGENT, row("rine.v1.a2a_message", "none"));

		expect(opened).toMatchObject({ a2a_cleartext: true, decrypted: [{ text: "plain" }] });
	});

	it("test_openInboxRow_when_a_non_a2a_row_is_not_ciphertext_then_it_is_not_marked", async () => {
		const opened = await openInboxRow(ctx, AGENT, row("rine.v1.text", "none"), explain);

		expect(opened).not.toHaveProperty("a2a_cleartext");
		expect(opened).not.toHaveProperty("decrypted");
	});
});
