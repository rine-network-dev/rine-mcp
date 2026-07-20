/**
 * 11 — Payments: rine_pay end-to-end + wallet state in rine_whoami
 *
 * Drives the MCP x402 payer tool against the isolated live server. MCP exposes
 * no wallet-management tool (wallet create / policy set are CLI / off-rine), so
 * the payer wallet + spend policy are bootstrapped with the SAME rine-core
 * primitives the CLI uses under the hood (`createWallet`, `savePolicy`) — no
 * reimplemented crypto. The quote is issued through `rine_send` with the x402
 * message type; the payer then pays it with `rine_pay`.
 *
 * Asserts:
 *  - the in-policy payment lands in-thread as rine.v1.x402_payment carrying a
 *    {status, rail}-only marker (no amount / asset / address ever leaks),
 *  - the once-per-message double-pay guard holds (already-paid; allow_repay
 *    bypasses it),
 *  - an over-cap quote is refused with a typed policy-refused status and
 *    NOTHING is sent,
 *  - paying a non-x402 message returns not-payment-required,
 *  - wallet address + policy flag surface in rine_whoami (never key material).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PaymentPolicy,
	createWallet,
	savePolicy,
} from "@rine-network/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness } from "../harness.js";
import { getApiUrl, isProd } from "../helpers.js";

// EURC on base-sepolia (eip155:84532), 6-decimal — matches rine-core's asset
// registry so a symbol-based policy (allowedAssets=["EURC"]) admits it.
const EURC_ASSET = "0x808456652fdb597867f38412077a9182bf77359f";
const NETWORK = "eip155:84532";

/** Verbatim x402 V2 PaymentRequired quote (carries a `resource`, per D4). */
function paymentRequired(
	amount: string,
	payTo: string,
): Record<string, unknown> {
	return {
		x402Version: 2,
		error: "payment required",
		resource: {
			url: "rine://task/mcp-e2e",
			description: "mcp e2e paid task",
			mimeType: "application/json",
		},
		accepts: [
			{
				scheme: "exact",
				network: NETWORK,
				amount,
				asset: EURC_ASSET,
				payTo,
				maxTimeoutSeconds: 600,
				extra: { name: "EURC", version: "2" },
			},
		],
		extensions: {},
	};
}

interface SendResult {
	id: string;
	conversation_id: string;
}
interface PayResult {
	status: string;
	reason?: string;
	message?: SendResult;
}
interface X402Marker {
	status: string;
	rail: string;
}
interface ReadResult {
	metadata?: Record<string, X402Marker>;
	verified?: boolean;
}
interface WhoamiAgent {
	id: string;
	name: string;
	wallet_address: string | null;
	has_payment_policy: boolean;
}
interface WhoamiResult {
	agents: WhoamiAgent[];
}

const PAYER_POLICY: PaymentPolicy = {
	perTxCap: "5.00",
	dailyCap: "50.00",
	allowedAssets: ["EURC"],
	allowedNetworks: [NETWORK],
	autoPayThreshold: "1.00",
};

describe.skipIf(isProd())("11 — Payments (rine_pay + wallet)", () => {
	const apiUrl = getApiUrl();
	const payerDir = mkdtempSync(join(tmpdir(), "rine-e2e-payer-"));
	const payeeDir = mkdtempSync(join(tmpdir(), "rine-e2e-payee-"));

	let payer: McpHarness;
	let payee: McpHarness;
	let payerAgentId: string;
	let payerHandle: string;
	let payeeAgentId: string;
	let payerAddr: string;
	let payeeAddr: string;

	// Shared across the happy-path assertions.
	let quoteId: string;
	let quoteConv: string;
	let paymentId: string;

	beforeAll(async () => {
		payer = new McpHarness({ apiUrl, configDir: payerDir });
		payee = new McpHarness({ apiUrl, configDir: payeeDir });
		await Promise.all([payer.connect(), payee.connect()]);

		const suffix = Date.now().toString(36);
		const payerReg = await payer.call<Record<string, Record<string, string>>>(
			"rine_onboard",
			{
				email: `x402-payer-${suffix}@gmail.com`,
				org_name: "X402 Payer",
				org_slug: `x402-payer-${suffix}`.slice(0, 32),
				agent_name: "payer",
			},
		);
		payerAgentId = payerReg.agent.id;
		payerHandle = payerReg.agent.handle;

		const payeeReg = await payee.call<Record<string, Record<string, string>>>(
			"rine_onboard",
			{
				email: `x402-payee-${suffix}@gmail.com`,
				org_name: "X402 Payee",
				org_slug: `x402-payee-${suffix}`.slice(0, 32),
				agent_name: "payee",
			},
		);
		payeeAgentId = payeeReg.agent.id;

		// Bootstrap wallets + payer policy with the rine-core primitives the CLI
		// wraps. rine_pay reads them fresh from disk on each call, so no restart.
		payerAddr = createWallet(payerDir, payerAgentId).address;
		payeeAddr = createWallet(payeeDir, payeeAgentId).address;
		savePolicy(payerDir, payerAgentId, PAYER_POLICY);
		// Payee deliberately gets a wallet but NO policy — the whoami control.
	});

	afterAll(async () => {
		await Promise.allSettled([payer?.close(), payee?.close()]);
		rmSync(payerDir, { recursive: true, force: true });
		rmSync(payeeDir, { recursive: true, force: true });
	});

	it("11.1 rine_whoami surfaces payer wallet address + policy flag", async () => {
		const who = await payer.call<WhoamiResult>("rine_whoami");
		const agent = who.agents.find((a) => a.id === payerAgentId);
		expect(agent).toBeDefined();
		expect(agent!.wallet_address).toBe(payerAddr);
		expect(agent!.has_payment_policy).toBe(true);
		// Never leaks key material or raw policy contents.
		const keys = Object.keys(agent!);
		expect(keys).not.toContain("wallet_key");
		expect(keys).not.toContain("private_key");
		expect(keys).not.toContain("policy");
	});

	it("11.2 rine_whoami control — wallet without a policy reports has_payment_policy=false", async () => {
		const who = await payee.call<WhoamiResult>("rine_whoami");
		const agent = who.agents.find((a) => a.id === payeeAgentId);
		expect(agent).toBeDefined();
		expect(agent!.wallet_address).toBe(payeeAddr);
		expect(agent!.has_payment_policy).toBe(false);
	});

	it("11.3 payer pays an in-policy quote in-thread", async () => {
		const quote = await payee.call<SendResult>("rine_send", {
			to: payerHandle,
			type: "rine.v1.x402_payment_required",
			payload: paymentRequired("100000", payeeAddr), // 0.10 EURC
		});
		quoteId = quote.id;
		quoteConv = quote.conversation_id;
		expect(quoteId).toBeTruthy();

		const pay = await payer.call<PayResult>("rine_pay", {
			message_id: quoteId,
		});
		expect(pay.status).toBe("payment-submitted");
		expect(pay.message?.id).toBeTruthy();
		// Payment is a reply — it stays in the quote's conversation.
		expect(pay.message?.conversation_id).toBe(quoteConv);
		paymentId = pay.message!.id;
	});

	it("11.4 the payment marker is {status: payment-submitted, rail: x402} and nothing else", async () => {
		const read = await payee.call<ReadResult>("rine_read", {
			message_id: paymentId,
			agent: payeeAgentId,
		});
		const marker = read.metadata?.["rine.x402"];
		expect(marker).toBeDefined();
		expect(Object.keys(marker!).sort()).toEqual(["rail", "status"]);
		expect(marker!.status).toBe("payment-submitted");
		expect(marker!.rail).toBe("x402");
	});

	it("11.5 the marker leaks no amount / asset / address", async () => {
		const read = await payee.call<ReadResult>("rine_read", {
			message_id: paymentId,
			agent: payeeAgentId,
		});
		const markerJson = JSON.stringify(read.metadata?.["rine.x402"]);
		for (const secret of ["100000", EURC_ASSET, payerAddr, payeeAddr]) {
			expect(markerJson).not.toContain(secret);
		}
	});

	it("11.6 double-pay guard — a repeat rine_pay of the same quote is already-paid and sends nothing", async () => {
		const repeat = await payer.call<PayResult>("rine_pay", {
			message_id: quoteId,
		});
		expect(repeat.status).toBe("already-paid");
		expect(repeat.message).toBeUndefined();
	});

	it("11.7 allow_repay bypasses the guard and submits a second payment", async () => {
		const repay = await payer.call<PayResult>("rine_pay", {
			message_id: quoteId,
			allow_repay: true,
		});
		expect(repay.status).toBe("payment-submitted");
		expect(repay.message?.conversation_id).toBe(quoteConv);
	});

	it("11.8 over-cap quote — rine_pay refuses (typed) and nothing is sent", async () => {
		const quote = await payee.call<SendResult>("rine_send", {
			to: payerHandle,
			type: "rine.v1.x402_payment_required",
			payload: paymentRequired("6000000", payeeAddr), // 6.00 EURC > 5.00 cap
		});

		const pay = await payer.call<PayResult>("rine_pay", {
			message_id: quote.id,
		});
		expect(pay.status).toBe("policy-refused");
		expect(pay.reason).toBe("per-tx-cap-exceeded");
		expect(pay.message).toBeUndefined();

		// Nothing landed: the payee's inbox has no x402_payment in that thread.
		const inbox = await payee.call<{
			items: Array<{ type: string; conversation_id: string }>;
		}>("rine_inbox", { agent: payeeAgentId, status: "all", limit: 50 });
		const sent = inbox.items.filter(
			(m) =>
				m.type === "rine.v1.x402_payment" &&
				m.conversation_id === quote.conversation_id,
		);
		expect(sent).toHaveLength(0);
	});

	it("11.9 paying a non-x402 message returns not-payment-required", async () => {
		const dm = await payee.call<SendResult>("rine_send", {
			to: payerHandle,
			type: "rine.v1.dm",
			payload: { note: "just a chat, not a quote" },
		});
		const pay = await payer.call<PayResult>("rine_pay", { message_id: dm.id });
		expect(pay.status).toBe("not-payment-required");
		expect(pay.message).toBeUndefined();
	});
});
