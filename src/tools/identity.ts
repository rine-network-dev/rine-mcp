import type { AgentRead, ListResponse, OrgRead } from "@rine-network/core";
import {
	agentKeysExist,
	getWalletAddress,
	loadCredentials,
	loadPolicy,
	verifyIdentitySpiffe,
	walletKeyExists,
} from "@rine-network/core";
import type { ToolDef } from "./types.js";

const rineWhoami: ToolDef = {
	name: "rine_whoami",
	// The `id`→`handle` clause is the pointer this tool owes. It returns raw wire
	// and renders no prose, so `rine_groups` hands back `member_agent_ids` as
	// UUIDs — values a model has never seen for itself and cannot join to
	// anything without being told where the other half of the pair lives. This
	// tool IS that other half: it is the only place the two are reported side by
	// side. Adding the pointer here costs one clause; resolving the ids inside
	// `rine_groups` would mean this surface stopped emitting the wire.
	description:
		"Show current rine identity: org name/slug, trust tier, and all agents " +
		"with their handles, policies, local key status, and x402 wallet info " +
		"(EVM address + whether a spend policy is set — never key material). " +
		"Each agent's id is reported next to its handle, which is what rine_groups' " +
		"member_agent_ids needs: those are agent UUIDs, and this is where you " +
		"resolve one to the agent it names — including your own.",
	inputSchema: { type: "object", properties: {} },
	async handler(ctx) {
		const [org, agentsData] = await Promise.all([
			ctx.client.get("/org") as Promise<OrgRead>,
			ctx.client.get("/agents") as Promise<ListResponse<AgentRead>>,
		]);

		const agents = agentsData.items.map((a) => ({
			...a,
			has_keys: agentKeysExist(ctx.configDir, a.id),
			// x402 wallet: public address only (deriving it needs no secret to
			// leave the process), plus a boolean policy-present flag. The wallet
			// private key and the policy contents are NEVER surfaced.
			wallet_address: walletKeyExists(ctx.configDir, a.id)
				? getWalletAddress(ctx.configDir, a.id)
				: null,
			has_payment_policy: loadPolicy(ctx.configDir, a.id) !== null,
		}));

		return { org, agents };
	},
};

const rinePoll: ToolDef = {
	name: "rine_poll",
	description:
		"Lightweight inbox count — returns pending message count without downloading them. " +
		"Uses the poll token from onboarding (no auth overhead). " +
		"Call at the start of each turn. If count > 0, call rine_inbox to read messages. " +
		"If this errors, call rine_onboard first.",
	inputSchema: {
		type: "object",
		properties: {},
	},
	async handler(ctx) {
		const creds = loadCredentials(ctx.configDir);
		const entry = creds.default;
		const pollUrl = entry?.poll_url;

		if (!pollUrl) {
			throw new Error(
				"No poll token found. Register with rine_onboard or generate one with 'rine poll-token'.",
			);
		}

		const res = await fetch(pollUrl, { signal: AbortSignal.timeout(30_000) });
		if (!res.ok) {
			throw new Error(`Poll failed: ${res.status} ${res.statusText}`);
		}
		const body = (await res.json()) as Record<string, unknown>;
		if (typeof body.count !== "number") {
			throw new Error(`Unexpected poll response: ${JSON.stringify(body)}`);
		}
		return { count: body.count };
	},
};

const rineVerifyIdentity: ToolDef = {
	name: "rine_verify_identity",
	description:
		"Prove control of a SPIFFE identity for an agent, elevating the org to trust tier 2. " +
		"Supply a SPIFFE JWT-SVID (compact JWS) via `svid` — its `aud` is bound to a single-use " +
		"challenge minted by the server, so the flow is replay-safe. Automatic fetch from " +
		"SPIFFE_ENDPOINT_SOCKET is not available in this build; pass `svid` explicitly.",
	inputSchema: {
		type: "object",
		properties: {
			agent_id: { type: "string", description: "Agent UUID to verify." },
			svid: {
				type: "string",
				description:
					"A SPIFFE JWT-SVID (compact JWS) whose aud matches the issued challenge.",
			},
		},
		required: ["agent_id"],
	},
	async handler(ctx, params) {
		return verifyIdentitySpiffe(ctx.client, params.agent_id as string, {
			svid: params.svid as string | undefined,
		});
	},
};

export const identityTools: ToolDef[] = [
	rineWhoami,
	rinePoll,
	rineVerifyIdentity,
];
