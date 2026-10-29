// Input schema of the MCP x402 payee tool rine_fulfill.

import type { ToolDef } from "./types.js";

export const FULFILL_INPUT_SCHEMA: ToolDef["inputSchema"] = {
	type: "object",
	properties: {
		message_id: {
			type: "string",
			description:
				"UUID of the received rine.v1.x402_payment message to settle.",
		},
		facilitator: {
			type: "string",
			description:
				"Facilitator preset ('cdp' | 'payai' | 'x402-rs') or an http(s):// " +
				"base URL. Defaults to 'payai' (keyless). verify/settle is plain " +
				"external HTTP; rine never touches funds.",
		},
		facilitator_headers: {
			type: "object",
			description:
				"Optional auth headers for the facilitator (e.g. CDP credentials). " +
				"Passed verbatim as request headers.",
		},
		verify_path: {
			type: "string",
			description: "Override the facilitator's /verify path.",
		},
		settle_path: {
			type: "string",
			description: "Override the facilitator's /settle path.",
		},
		pay_to: {
			type: "string",
			description:
				"Expected-terms override: the payee wallet (0x) the payment must pay. " +
				"Requires expect_amount + expect_asset + expect_network together; " +
				"authorizes an out-of-band quote and is authoritative, needing no " +
				"stamped quote reference.",
		},
		expect_amount: {
			type: "string",
			description:
				"Expected-terms override: minimum amount in MAJOR units (e.g. '1.00'). " +
				"Overpayment is allowed, underpayment refused.",
		},
		expect_asset: {
			type: "string",
			description:
				"Expected-terms override: the token contract address (0x) required.",
		},
		expect_network: {
			type: "string",
			description:
				"Expected-terms override: the CAIP-2 network (e.g. 'eip155:8453') required.",
		},
		emit_marker: {
			type: "boolean",
			description:
				"Attach the cleartext status marker (metadata['rine.x402']). " +
				"Default true. The marker carries only coarse lifecycle state " +
				"(never amounts/assets/addresses/tx-hashes).",
		},
	},
	required: ["message_id"],
};
