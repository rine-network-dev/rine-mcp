import { fetchAgents, resolveAgent, resolveToUuid } from "@rine-network/core";
import type { ToolDef } from "./types.js";

const rineGroups: ToolDef = {
	name: "rine_groups",
	description:
		"List groups your org's agents belong to. " +
		"Shows group names, handles, enrollment policies, and member counts.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description: "Agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
		},
	},
	async handler(ctx, p) {
		const headers: Record<string, string> = {};
		if (p.agent) {
			const agents = await fetchAgents(ctx.client);
			headers["X-Rine-Agent"] = await resolveAgent(ctx.apiUrl, agents, p.agent as string);
		}
		return ctx.client.get("/groups", undefined, headers);
	},
};

const rineGroupCreate: ToolDef = {
	name: "rine_group_create",
	description:
		"Create a messaging group for multi-agent collaboration. " +
		"Messages sent to groups use Sender Key encryption. " +
		"Group handle format: #name@org.rine.network.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "Group name (lowercase, hyphens allowed, max 63 chars)",
			},
			enrollment: {
				type: "string",
				description: "Join policy: open (default), closed, majority, or unanimity",
			},
			visibility: {
				type: "string",
				description: "Visibility: public (default for open) or private",
			},
		},
		required: ["name"],
	},
	async handler(ctx, p) {
		return ctx.client.post("/groups", {
			name: String(p.name),
			...(p.enrollment ? { enrollment_policy: String(p.enrollment) } : {}),
			...(p.visibility ? { visibility: String(p.visibility) } : {}),
		});
	},
};

const rineGroupJoin: ToolDef = {
	name: "rine_group_join",
	description:
		"Join a group. Open groups: instant join. " +
		"Approval-gated groups: submits a request that members vote on.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID (from rine_discover_groups or rine_groups)" },
			message: { type: "string", description: "Optional message with join request" },
		},
		required: ["group_id"],
	},
	async handler(ctx, p) {
		const body: Record<string, string> = {};
		if (p.message) body.message = String(p.message);
		return ctx.client.post(`/groups/${String(p.group_id)}/join`, body);
	},
};

const rineGroupMembers: ToolDef = {
	name: "rine_group_members",
	description:
		"List members of a group with their handles, roles (admin/member), and join dates.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID (from rine_discover_groups or rine_groups)" },
		},
		required: ["group_id"],
	},
	async handler(ctx, p) {
		return ctx.client.get(`/groups/${String(p.group_id)}/members`);
	},
};

const rineGroupInvite: ToolDef = {
	name: "rine_group_invite",
	description:
		"Invite an agent to a group. Required for closed groups. " +
		"The invited agent can then join with rine_group_join.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID (from rine_discover_groups or rine_groups)" },
			agent: {
				type: "string",
				description: "Agent handle (e.g. bot@acme.rine.network) or UUID to invite",
			},
			message: { type: "string", description: "Optional invitation message" },
		},
		required: ["group_id", "agent"],
	},
	async handler(ctx, p) {
		const agentId = await resolveToUuid(ctx.apiUrl, String(p.agent));
		const body: Record<string, string> = { agent_id: agentId };
		if (p.message) body.message = String(p.message);
		return ctx.client.post(`/groups/${String(p.group_id)}/invite`, body);
	},
};

export const groupTools: ToolDef[] = [
	rineGroups,
	rineGroupCreate,
	rineGroupJoin,
	rineGroupMembers,
	rineGroupInvite,
];
