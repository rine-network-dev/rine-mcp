import {
	type GroupRead,
	type HttpClient,
	addMlsGroupMember,
	externalJoinMlsGroup,
	fetchAgents,
	initMlsGroup,
	listMyInvites,
	loadMlsState,
	processMlsWelcomes,
	resolveAgent,
	resolveToUuid,
	sendGroupInviteNotification,
} from "@rine-network/core";
import type { ToolContext, ToolDef } from "./types.js";

// Best-effort: if the group is MLS-active, add a member (claim KP, commit,
// deliver Welcome) as the acting admin. No-op for sender-key groups. Mirrors
// the CLI's `addMemberToMls`. `groupId` is the rine group UUID — never the
// opaque `mls_group_id` latch — and is what `addMlsGroupMember` keys on.
async function addMemberToMls(
	client: HttpClient,
	configDir: string,
	apiUrl: string,
	groupId: string,
	memberAgentId: string,
	as?: string,
): Promise<void> {
	try {
		const group = (await client.get(`/groups/${groupId}`)) as GroupRead;
		if (!group.mls_group_id) return;
		const agents = await fetchAgents(client);
		const adminId = await resolveAgent(apiUrl, agents, as);
		await addMlsGroupMember(configDir, adminId, groupId, memberAgentId, client, {
			"X-Rine-Agent": adminId,
		});
	} catch (e) {
		console.warn(`MLS add-member failed for group ${groupId}:`, e);
	}
}

// Best-effort: seal a `rine.v1.group_invite` notification to the invitee so the
// invite lands in their normal inbox/poll/SSE path. Fetches the group handle for
// the sealed payload and sends as the inviting agent. The authoritative discovery
// path is `GET /groups/invites` — this is only a convenience nudge, so a failure
// (e.g. groups_only 403, missing keys) warns but never fails the invite. Mirrors
// the surface's other best-effort MLS error handling.
async function notifyInvitee(
	client: HttpClient,
	configDir: string,
	apiUrl: string,
	groupId: string,
	inviteeAgentId: string,
	message: string | null,
	as?: string,
): Promise<void> {
	try {
		const group = (await client.get(`/groups/${groupId}`)) as GroupRead;
		const agents = await fetchAgents(client);
		const inviterId = await resolveAgent(apiUrl, agents, as);
		await sendGroupInviteNotification(
			client,
			configDir,
			inviterId,
			inviteeAgentId,
			{ group_id: groupId, group_handle: group.handle, message },
		);
	} catch (e) {
		console.warn(`Invite notification failed for group ${groupId}:`, e);
	}
}

// Best-effort: for an MLS-active group the joiner just joined, if the Welcome
// path installed no local MLS state (the open-enrollment case — the server
// added them with no member in the loop, so no Welcome was minted), self-join
// via an RFC 9420 external commit so the joiner becomes a real MLS member and
// can send/receive. No-op for sender-key groups or when a Welcome already
// established state. Non-fatal — mirrors the surface's other MLS error handling.
async function externalJoinFallback(
	ctx: ToolContext,
	agentId: string,
	groupId: string,
): Promise<void> {
	try {
		const group = (await ctx.client.get(`/groups/${groupId}`)) as GroupRead;
		if (!group.mls_group_id) return;
		if (loadMlsState(ctx.configDir, agentId, groupId)) return;
		await externalJoinMlsGroup(ctx.configDir, agentId, groupId, ctx.client, {
			"X-Rine-Agent": agentId,
		});
	} catch (e) {
		console.warn(`MLS external self-join failed for group ${groupId}:`, e);
	}
}

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
				description:
					"Agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
		},
	},
	async handler(ctx, p) {
		const headers: Record<string, string> = {};
		if (p.agent) {
			const agents = await fetchAgents(ctx.client);
			headers["X-Rine-Agent"] = await resolveAgent(
				ctx.apiUrl,
				agents,
				p.agent as string,
			);
		}
		return ctx.client.get("/groups", undefined, headers);
	},
};

const rineGroupCreate: ToolDef = {
	name: "rine_group_create",
	description:
		"Create a messaging group for multi-agent collaboration. " +
		"Messages sent to groups use Sender Key encryption. " +
		"Group handle format: #name@org.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "Group name (lowercase, hyphens allowed, max 63 chars)",
			},
			enrollment: {
				type: "string",
				description:
					"Join policy: open (default), closed, majority, or unanimity",
			},
			visibility: {
				type: "string",
				description: "Visibility: public (default) or private",
			},
			as: {
				type: "string",
				description:
					"Acting agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
		},
		required: ["name"],
	},
	async handler(ctx, p) {
		const agents = await fetchAgents(ctx.client);
		const agentId = await resolveAgent(
			ctx.apiUrl,
			agents,
			p.as as string | undefined,
		);
		const headers: Record<string, string> = { "X-Rine-Agent": agentId };

		const enrollment = p.enrollment ? String(p.enrollment) : undefined;
		const visibility = p.visibility
			? String(p.visibility)
			: enrollment === "open"
				? "public"
				: "private";
		const group = (await ctx.client.post(
			"/groups",
			{
				name: String(p.name),
				...(enrollment ? { enrollment_policy: enrollment } : {}),
				visibility,
			},
			headers,
		)) as GroupRead;

		// Best-effort MLS group init: the creator is the lowest-UUID admin of a
		// fresh group and latches mls_group_id server-side. Non-fatal on failure
		// (a stuck mls_pending self-clears server-side after 15 min).
		try {
			await initMlsGroup(ctx.configDir, agentId, group.id, ctx.client, {
				"X-Rine-Agent": agentId,
			});
		} catch (e) {
			console.warn(
				`MLS group init failed for ${group.id} (group still created):`,
				e,
			);
		}

		return group;
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
			group_id: {
				type: "string",
				description: "Group UUID (from rine_discover_groups or rine_groups)",
			},
			message: {
				type: "string",
				description: "Optional message with join request",
			},
			as: {
				type: "string",
				description:
					"Acting agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
		},
		required: ["group_id"],
	},
	async handler(ctx, p) {
		const agents = await fetchAgents(ctx.client);
		const agentId = await resolveAgent(
			ctx.apiUrl,
			agents,
			p.as as string | undefined,
		);
		const headers: Record<string, string> = { "X-Rine-Agent": agentId };

		const body: Record<string, string> = {};
		if (p.message) body.message = String(p.message);
		const result = await ctx.client.post(
			`/groups/${String(p.group_id)}/join`,
			body,
			headers,
		);

		// Best-effort: install any pending MLS Welcome an admin has already
		// delivered for this joiner (establishes local MLS state). Non-fatal —
		// if the group is not MLS or no Welcome is pending yet, this is a no-op.
		try {
			await processMlsWelcomes(ctx.configDir, agentId, ctx.client);
		} catch (e) {
			console.warn("MLS welcome processing failed after join:", e);
		}

		// Open-enrollment fallback (Phase 6): the rine server can add a joiner to
		// an MLS-active group with no member in the loop, so no Welcome is ever
		// minted. If the group is MLS-active but the Welcome path installed no
		// local state, self-join via an RFC 9420 external commit. Best-effort.
		await externalJoinFallback(ctx, agentId, String(p.group_id));

		return result;
	},
};

const rineGroupMembers: ToolDef = {
	name: "rine_group_members",
	description:
		"List members of a group with their handles, roles (admin/member), and join dates.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: {
				type: "string",
				description: "Group UUID (from rine_discover_groups or rine_groups)",
			},
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
			group_id: {
				type: "string",
				description: "Group UUID (from rine_discover_groups or rine_groups)",
			},
			agent: {
				type: "string",
				description: "Agent handle (e.g. bot@acme) or UUID to invite",
			},
			message: { type: "string", description: "Optional invitation message" },
			as: {
				type: "string",
				description:
					"Acting agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
		},
		required: ["group_id", "agent"],
	},
	async handler(ctx, p) {
		const headers: Record<string, string> = {};
		if (p.as) {
			const agents = await fetchAgents(ctx.client);
			headers["X-Rine-Agent"] = await resolveAgent(
				ctx.apiUrl,
				agents,
				p.as as string,
			);
		}
		const agentId = await resolveToUuid(ctx.apiUrl, String(p.agent));
		const body: Record<string, string> = { agent_id: agentId };
		if (p.message) body.message = String(p.message);
		const result = await ctx.client.post(
			`/groups/${String(p.group_id)}/invite`,
			body,
			headers,
		);

		// For MLS-active groups, add the invitee now (claims their KP and
		// delivers a Welcome) so it's waiting when they accept via join.
		// Best-effort, acting as the inviting admin.
		await addMemberToMls(
			ctx.client,
			ctx.configDir,
			ctx.apiUrl,
			String(p.group_id),
			agentId,
			p.as ? String(p.as) : undefined,
		);

		// Best-effort: nudge the invitee with a sealed `rine.v1.group_invite`
		// notification so it surfaces in their inbox. Authoritative discovery is
		// `rine_group_invites` (GET /groups/invites); a failure here is non-fatal.
		await notifyInvitee(
			ctx.client,
			ctx.configDir,
			ctx.apiUrl,
			String(p.group_id),
			agentId,
			p.message ? String(p.message) : null,
			p.as ? String(p.as) : undefined,
		);

		return result;
	},
};

const rineGroupInvites: ToolDef = {
	name: "rine_group_invites",
	description:
		"List group invites addressed to your agent. " +
		"Each invite shows the group, who invited you, and any message — " +
		"join with rine_group_join using the group_id.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description:
					"Agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
		},
	},
	async handler(ctx, p) {
		const headers: Record<string, string> = {};
		if (p.agent) {
			const agents = await fetchAgents(ctx.client);
			headers["X-Rine-Agent"] = await resolveAgent(
				ctx.apiUrl,
				agents,
				p.agent as string,
			);
		}
		const items = await listMyInvites(ctx.client, headers);
		return { items };
	},
};

export const groupTools: ToolDef[] = [
	rineGroups,
	rineGroupCreate,
	rineGroupJoin,
	rineGroupMembers,
	rineGroupInvite,
	rineGroupInvites,
];
