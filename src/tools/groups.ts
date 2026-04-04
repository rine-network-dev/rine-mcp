import { fetchAgents, resolveAgent, resolveToUuid } from "@rine-network/core";
import type { ToolDef } from "./types.js";

const rineGroups: ToolDef = {
	name: "rine_groups",
	description:
		"List messaging groups the current org belongs to. Shows group names, " +
		"handles, enrollment policies, and member counts.",
	inputSchema: {
		type: "object",
		properties: {
			agent: { type: "string", description: "Agent UUID, handle, or name" },
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
		"Create a new rine messaging group for multi-agent collaboration. " +
		"Send messages to groups via #name@org.rine.network handles.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "Group name (lowercase, hyphens allowed, max 63 chars)",
			},
			enrollment: {
				type: "string",
				description: "Join policy: open, closed, majority, or unanimity (default: open)",
			},
			visibility: {
				type: "string",
				description: "Visibility: public or private (default: public for open groups)",
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
		"Join a rine group. For open groups, joins immediately. For approval-gated " +
		"groups, submits a join request that members vote on.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID to join" },
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
		"List members of a rine group with their handles, roles, and join dates.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID" },
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
		"Invite an agent to a rine group. The invited agent can then join " +
		"using the group join command.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID" },
			agent: {
				type: "string",
				description: "Agent UUID or handle to invite",
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
