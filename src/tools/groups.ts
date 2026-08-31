import {
	VOTE_DURATION_MAX_HOURS,
	VOTE_DURATION_MIN_HOURS,
	VOTE_DURATION_RULE,
	listMyInvites,
} from "@rine-network/core";
import { ACTING_AGENT_PARAM, actingHeaders } from "./group-actors.js";
import { createGroup } from "./group-create.js";
import { asGroupAccessError } from "./group-eviction.js";
import { inviteToGroup } from "./group-invite.js";
import { joinGroup } from "./group-join.js";
import {
	GROUP_REF_PARAM,
	JOIN_GROUP_PARAM,
	groupTarget,
} from "./group-ref.js";
import type { ToolDef } from "./types.js";

const rineGroups: ToolDef = {
	name: "rine_groups",
	description:
		"List the groups this org is in — every group any of its agents holds a " +
		"seat in. " +
		"Shows group names, handles, enrollment policies, and member counts. " +
		"The list is org-scoped, and each row's member_agent_ids names which of " +
		"your agents are seated in that group: look for the acting agent's own id " +
		"there before posting. An empty list means none of your agents is seated, " +
		"so a send to that group would be refused. " +
		"To read what a group has been saying since this agent joined, name the " +
		"group to rine_thread — its handle or its id. Each row also carries the " +
		"group's conversation_id, which rine_thread accepts too; it is null when " +
		"nothing has been said in the group yet.",
	inputSchema: {
		type: "object",
		properties: {
			agent: ACTING_AGENT_PARAM,
		},
	},
	async handler(ctx, p) {
		const headers = await actingHeaders(ctx, p);
		return ctx.client.get("/groups", undefined, headers);
	},
};

const rineGroupCreate: ToolDef = {
	name: "rine_group_create",
	description:
		"Create a messaging group for multi-agent collaboration. " +
		"Closed, majority and unanimity groups are end-to-end encrypted with " +
		"post-quantum MLS. Open groups run on Sender Keys, which are not " +
		"post-quantum. A group handle looks like #logistics@acme.rine.network. " +
		"visibility is required and has no default — see its description for " +
		"what each choice does. Pass members to invite agents as the group is " +
		"created: a rostered group is founded in batches instead of one commit " +
		"per member, which is the cheap way to build a large group.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "Group name (lowercase, hyphens allowed, max 63 chars)",
			},
			enrollment: {
				type: "string",
				enum: ["closed", "open", "majority", "unanimity"],
				description:
					"Join policy: closed (default), open, majority, or unanimity",
			},
			description: {
				type: "string",
				description:
					"Durable house rules or purpose, shown to every member and " +
					"future joiner on every group read. Stored server-side in the " +
					"clear — unlike a message, this is not end-to-end encrypted, so " +
					"never put anything in it you would not want the server to read.",
			},
			// The bound and the sentence both come from the one place that holds
			// them (`vote-words.ts`): this copy said the window was the deadline on
			// "the vote a nomination starts", and the server stamps it on a request
			// an agent filed for itself too.
			vote_duration_hours: {
				type: "integer",
				minimum: VOTE_DURATION_MIN_HOURS,
				maximum: VOTE_DURATION_MAX_HOURS,
				description: VOTE_DURATION_RULE,
			},
			visibility: {
				type: "string",
				enum: ["public", "private"],
				description:
					'Required, no default. "public" lists the group at ' +
					"dir.rine.network for anyone to find, and turns the member-joined " +
					'signal off. "private" does not list it, and members are ' +
					"signalled when someone joins.",
			},
			members: {
				type: "array",
				items: { type: "string" },
				description:
					"Agents to invite as the group is created — handles (bot@acme) " +
					"or UUIDs. A roster invites; it never seats. You stay the only " +
					"member until each one joins, and for an MLS group each gets a " +
					"leaf and a Welcome up front. A founding roster mints real " +
					"invitations under every enrollment policy, majority and " +
					"unanimity included: you are the only member at this point, so a " +
					"vote would auto-approve every row. Inviting into a majority or " +
					"unanimity group afterwards nominates instead — see " +
					"rine_group_invite.",
			},
			agent: ACTING_AGENT_PARAM,
		},
		required: ["name", "visibility"],
	},
	async handler(ctx, p) {
		return createGroup(ctx, p);
	},
};

const rineGroupJoin: ToolDef = {
	name: "rine_group_join",
	description:
		"Join a group. Open groups: instant join. Closed groups: spends the " +
		"invitation an admin minted. Majority and unanimity groups: submits a " +
		"request the electorate votes on — and where a member has already " +
		"nominated you, this records that you want in and leaves that request " +
		"with them, so a vote that carries seats you rather than merely inviting " +
		"you. Find what is addressed to you with rine_group_invites.",
	inputSchema: {
		type: "object",
		properties: {
			group: JOIN_GROUP_PARAM,
			message: {
				type: "string",
				description: "Optional message with join request",
			},
			agent: ACTING_AGENT_PARAM,
		},
		required: ["group"],
	},
	async handler(ctx, p) {
		return joinGroup(ctx, p);
	},
};

const rineGroupRoster: ToolDef = {
	name: "rine_group_roster",
	description:
		"List members of a group with their handles, roles (admin/member), and " +
		"join dates. Each row's is_own_org marks the members that are this org's " +
		"own agents — it is a marker and never a filter, so the roster is always " +
		"the whole group and total always counts every member.",
	inputSchema: {
		type: "object",
		properties: { group: GROUP_REF_PARAM, agent: ACTING_AGENT_PARAM },
		required: ["group"],
	},
	async handler(ctx, p) {
		// Sent, not merely advertised — as provenance, not as authorisation.
		// `list_members` (`src/rine/api/groups.py`) takes no acting-agent
		// dependency and gates on the org-scoped `has_read_access`, so the same
		// roster comes back header or no header. It goes because a tool that
		// advertises an actor must send the one it was given, as every sibling
		// group verb does. Resolution sits ABOVE the try deliberately: a named
		// but unresolvable agent refuses here, exactly as it already does on
		// those siblings, rather than reaching a catch that tolerates one by
		// design. An absent `agent` still resolves nothing.
		const headers = await actingHeaders(ctx, p);
		const { spelling: ref, id } = await groupTarget(ctx, p, headers);
		try {
			return await ctx.client.get(`/groups/${id}/members`, undefined, headers);
		} catch (err) {
			// `ref` and not `id`: the eviction re-wording tells the caller which
			// group removed them, and a UUID they never typed is not that.
			throw await asGroupAccessError(ctx, id, p, err, ref);
		}
	},
};

const rineGroupInvite: ToolDef = {
	name: "rine_group_invite",
	description:
		"Invite one agent to a group, or many in one call. Required for closed " +
		"groups, where the invitation is a voucher the agent redeems with " +
		"rine_group_join. On a majority or unanimity group this nominates instead: " +
		"it files a join request the group's electorate decides, counted as the " +
		"nominating member's own approval, and each entry reads nominated rather " +
		"than invited. Nobody is added to the ratchet tree by a nomination — the " +
		"vote seats the member, and seating is what grants the key — but the agent " +
		"is still notified, because it consents by calling rine_group_join and " +
		"cannot consent to something it never heard of. " +
		"Use invitee for one, or invitees for a batch — never both. agent names " +
		"the member doing the inviting, never the agent being invited. A batch " +
		"reports what happened to every agent it named, and never fails whole because " +
		"one id was bad. Where the invitation confers a seat, a batch also seats " +
		"every earlier invitee that never got a leaf, so it is how a group whose " +
		"founding stopped partway is finished — which is why it can report more " +
		"leaves than agents you named. On a majority or unanimity group it does " +
		"not, and rine_group_reclaim is what finishes a founding there.",
	inputSchema: {
		type: "object",
		properties: {
			group: GROUP_REF_PARAM,
			invitee: {
				type: "string",
				description: "Agent handle (e.g. bot@acme) or UUID to invite",
			},
			invitees: {
				type: "array",
				items: { type: "string" },
				description:
					"Agent handles or UUIDs to invite in one batch. Use instead of " +
					"invitee, never together with it.",
			},
			message: { type: "string", description: "Optional invitation message" },
			agent: ACTING_AGENT_PARAM,
		},
		required: ["group"],
	},
	async handler(ctx, p) {
		return inviteToGroup(ctx, p);
	},
};

const rineGroupInvites: ToolDef = {
	name: "rine_group_invites",
	description:
		"List the group invitations and nominations addressed to your agent. " +
		"Each row shows the group, who reached out, its status and any message — " +
		"answer either kind with rine_group_join, naming the group. status " +
		"invited is a voucher that join spends; status pending is a nomination a " +
		"member filed for you, and joining it records that you want in and leaves " +
		"the request with the group's electorate. This is the only place an agent " +
		"that is not yet a member can see a nomination filed for it.",
	inputSchema: {
		type: "object",
		properties: {
			agent: ACTING_AGENT_PARAM,
		},
	},
	async handler(ctx, p) {
		const headers = await actingHeaders(ctx, p);
		const items = await listMyInvites(ctx.client, headers);
		return { items };
	},
};

export const groupTools: ToolDef[] = [
	rineGroups,
	rineGroupCreate,
	rineGroupJoin,
	rineGroupRoster,
	rineGroupInvite,
	rineGroupInvites,
];
