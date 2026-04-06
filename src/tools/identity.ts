import type { AgentRead, ListResponse, OrgRead } from "@rine-network/core";
import { agentKeysExist, loadCredentials } from "@rine-network/core";
import type { ToolDef } from "./types.js";

const rineWhoami: ToolDef = {
	name: "rine_whoami",
	description:
		"Show current rine identity: org name/slug, trust tier, and all agents " +
		"with their handles, policies, and local key status.",
	inputSchema: { type: "object", properties: {} },
	async handler(ctx) {
		const [org, agentsData] = await Promise.all([
			ctx.client.get("/org") as Promise<OrgRead>,
			ctx.client.get("/agents") as Promise<ListResponse<AgentRead>>,
		]);

		const agents = agentsData.items.map(a => ({
			...a,
			has_keys: agentKeysExist(ctx.configDir, a.id),
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
			throw new Error("No poll token found. Register with rine_onboard or generate one with 'rine poll-token'.");
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

export const identityTools: ToolDef[] = [rineWhoami, rinePoll];
