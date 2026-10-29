// Every decrypt on the MCP read path passes the row's own `created_at`.
//
// The key generation a message opens under is chosen by the instant the server
// stamped on it. The argument is optional in rine-core, so a call site that
// drops it still compiles and silently falls back to the current key, which is
// wrong for a message sealed before a rotation.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SENDER_ID = "22222222-2222-2222-2222-222222222222";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";
const CREATED_AT = "2026-03-04T05:06:07Z";

const mockDecryptMessage = vi.fn();
const mockDecryptGroupMessage = vi.fn();
const mockDecryptGroupWithRecovery = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		agentKeysExist: () => true,
		ingestSenderKeyDistribution: () => {},
		decryptMessage: (...a: unknown[]) => mockDecryptMessage(...a),
		decryptGroupMessage: (...a: unknown[]) => mockDecryptGroupMessage(...a),
		decryptGroupMessageWithRecovery: (...a: unknown[]) =>
			mockDecryptGroupWithRecovery(...a),
	};
});

const { openInboxRow, openMessage } = await import(
	"../../src/tools/messaging-decrypt.js"
);
const core = await import("@rine-network/core");

const ctx = { client: {}, configDir: "/tmp/cfg" } as unknown as ToolContext;
const decrypted = { payload: { text: "hi" }, verified: true };

function row(encryption_version: string, extra: object = {}) {
	return {
		id: "m1",
		type: "rine.v1.dm",
		from_agent_id: SENDER_ID,
		encrypted_payload: "enc",
		encryption_version,
		created_at: CREATED_AT,
		...extra,
	} as never;
}

const direct = () => row("hpke-hybrid-v2");
const group = () => row("mls-v1", { group_id: GROUP_ID });

beforeEach(() => {
	mockDecryptMessage.mockReset().mockResolvedValue(decrypted);
	mockDecryptGroupMessage.mockReset().mockResolvedValue(decrypted);
	mockDecryptGroupWithRecovery.mockReset().mockResolvedValue(decrypted);
});

describe("MCP decrypt call sites pass the row's created_at", () => {
	it("inbox_when_row_is_direct_then_decryptMessage_gets_created_at", async () => {
		await openInboxRow(ctx, AGENT_ID, direct(), core.senderKeyExplainer());
		expect(mockDecryptMessage.mock.calls[0]?.at(-1)).toBe(CREATED_AT);
	});

	it("inbox_when_row_is_group_then_decryptGroupMessage_gets_created_at", async () => {
		await openInboxRow(ctx, AGENT_ID, group(), core.senderKeyExplainer());
		expect(mockDecryptGroupMessage.mock.calls[0]?.at(-1)).toBe(CREATED_AT);
	});

	it("read_when_row_is_direct_then_decryptMessage_gets_created_at", async () => {
		await openMessage(ctx, AGENT_ID, direct());
		expect(mockDecryptMessage.mock.calls[0]?.at(-1)).toBe(CREATED_AT);
	});

	it("read_when_row_is_group_then_the_recovery_decrypt_gets_created_at", async () => {
		await openMessage(ctx, AGENT_ID, group());
		expect(mockDecryptGroupWithRecovery.mock.calls[0]?.at(-1)).toBe(CREATED_AT);
	});
});
