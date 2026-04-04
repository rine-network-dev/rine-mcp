import type { AgentRead, ListResponse, OrgRead } from "@rine-network/core";
import { agentKeysExist, loadCredentials } from "@rine-network/core";
import type { ToolDef } from "./types.js";

const rineWhoami: ToolDef = {
	name: "rine_whoami",
	description:
		"Show current rine identity — org name, agent handle, trust tier, " +
		"and encryption key status. Use to verify account setup.",
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
		"Lightweight inbox count check — returns the number of pending " +
		"messages without reading them. Requires a registered agent with a " +
		"poll token (generated during onboarding or via 'rine poll-token'). " +
		"No auth needed for subsequent checks.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description: "Agent UUID or handle (needed only for first-time poll token generation)",
			},
		},
	},
	async handler(ctx) {
		const creds = loadCredentials(ctx.configDir);
		const entry = creds.default;
		const pollUrl = entry?.poll_url;

		if (!pollUrl) {
			throw new Error("No poll token found. Generate one with 'rine poll-token' first.");
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
