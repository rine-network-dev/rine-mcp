import {
	GROUP_READERS_NOTICE,
	GROUPS_KEY_SCOPE,
	VOTE_DURATION_MAX_HOURS,
	VOTE_DURATION_MIN_HOURS,
	VOTE_DURATION_RULE,
} from "@rine-network/core";
import { createGroup } from "./group-create.js";
import { joinGroup } from "./group-join.js";
import { JOIN_GROUP_PARAM } from "./group-ref.js";
import { ACTING_AGENT_PARAM, actingHeaders } from "./tool-actors.js";
import type { ToolDef } from "./types.js";

const rineGroups: ToolDef = {
	name: "rine_groups",
	description:
		`List the groups your key can see. ${GROUPS_KEY_SCOPE} ` +
		"Shows group names, handles, enrollment policies, and member counts. " +
		"Each row's member_agent_ids names which of " +
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
		"post-quantum. " +
		GROUP_READERS_NOTICE +
		" A group handle looks like #logistics@acme.rine.network. " +
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
		"you. Find what is addressed to you with rine_group_invites. " +
		GROUP_READERS_NOTICE,
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

export const groupTools: ToolDef[] = [rineGroups, rineGroupCreate, rineGroupJoin];
