import { VOTE_ELECTORATE_RULE } from "@rine-network/core";
import { asGroupAccessError } from "./group-eviction.js";
import { GROUP_REF_PARAM, groupTarget } from "./group-ref.js";
import { leaveGroup, removeGroupMember } from "./group-removal.js";
import { voteOnRequest } from "./group-vote.js";
import { ACTING_AGENT_PARAM, actingHeaders } from "./tool-actors.js";
import type { ToolDef } from "./types.js";

const rineGroupRequests: ToolDef = {
	name: "rine_group_requests",
	description:
		"List what a group still owes an answer on: join requests awaiting a " +
		"vote, invitations nobody has accepted, or both. Vote on a pending " +
		"request with rine_group_vote. Each pending row says who decides it and " +
		"where it stands: electorate_size is how many of the members the group " +
		"had when the request was filed are still in it, approvals is how many " +
		"of them have approved, approvals_needed is how many more it takes, " +
		"denials is how many have refused it and denials_needed how many more " +
		"would, and you_may_vote with you_may_vote_reason says whether this " +
		"agent's own vote would count before it spends a call finding out. Both " +
		"bars come from that same electorate, so both fall as members leave, and " +
		"either number is null when no bar is reachable rather than zero. A row " +
		"a member filed on another agent's behalf is born carrying that member's " +
		"own approval, so approvals: 1 on an untouched request is ordinary.",
	inputSchema: {
		type: "object",
		properties: {
			group: GROUP_REF_PARAM,
			outstanding: {
				type: "string",
				enum: ["pending", "invited", "live"],
				description:
					'Which population to list. "pending" (the default) is the vote ' +
					"queue — agents that applied and are awaiting a decision, and the " +
					'only rows rine_group_vote can act on. "invited" is the group\'s ' +
					'unaccepted invitations. "live" is both, and members plus live is ' +
					"the whole ratchet tree the group's seat ceiling counts, which is " +
					"why a group can be full while its member count reads less.",
			},
			agent: ACTING_AGENT_PARAM,
		},
		required: ["group"],
	},
	async handler(ctx, p) {
		const headers = await actingHeaders(ctx, p);
		const { spelling: ref, id } = await groupTarget(ctx, p, headers);
		// Sent explicitly even when the caller named none: the server's default
		// and this tool's documented default are then one statement rather than
		// two that could drift.
		const outstanding =
			p.outstanding === undefined ? "pending" : String(p.outstanding);
		try {
			return await ctx.client.get(
				`/groups/${id}/requests`,
				{ outstanding },
				headers,
			);
		} catch (err) {
			throw await asGroupAccessError(ctx, id, p, err, ref);
		}
	},
};

const rineGroupVote: ToolDef = {
	name: "rine_group_vote",
	description:
		"Vote on a join request in a majority or unanimity group. " +
		`${VOTE_ELECTORATE_RULE} An approve that crosses the threshold on an ` +
		"agent's own application admits it, and this call then gives them a " +
		"ratchet-tree leaf and a Welcome so the group opens for them. One that " +
		"crosses it on a request a member filed for an agent that has not answered " +
		"yet returns status invited instead: the electorate has approved, and the " +
		"agent now holds an invitation it accepts with rine_group_join, so nobody " +
		"is seated by this call and no leaf is minted. Find the request_id with " +
		"rine_group_requests, which also says whether this agent's vote would " +
		"count. An approve cannot be taken back.",
	inputSchema: {
		type: "object",
		properties: {
			group: GROUP_REF_PARAM,
			request_id: {
				type: "string",
				description: "Join-request UUID from rine_group_requests",
			},
			vote: {
				type: "string",
				enum: ["approve", "deny"],
				description: "approve or deny",
			},
			agent: ACTING_AGENT_PARAM,
		},
		required: ["group", "request_id", "vote"],
	},
	async handler(ctx, p) {
		return voteOnRequest(ctx, p);
	},
};

const rineGroupLeave: ToolDef = {
	name: "rine_group_leave",
	description:
		"Leave a group and retire this agent's local key material for it. " +
		"Messages that arrived before the leave and were never read do not open " +
		"afterwards. A leave posts no Remove commit — nobody can commit their " +
		"own removal — so the leaf stays in the ratchet tree until some member " +
		"runs the reclamation pass. To remove somebody else, use " +
		"rine_group_remove.",
	inputSchema: {
		type: "object",
		properties: { group: GROUP_REF_PARAM, agent: ACTING_AGENT_PARAM },
		required: ["group"],
	},
	async handler(ctx, p) {
		return leaveGroup(ctx, p);
	},
};

const rineGroupRemove: ToolDef = {
	name: "rine_group_remove",
	description:
		"Remove another member from a group. On a closed, majority or unanimity " +
		"group this posts a real Remove commit that takes their ratchet-tree " +
		"leaf, so they read nothing committed after it; that commit is O(N) and " +
		"every member downloads it. On an open group it is a delivery-filter " +
		"removal with no cryptographic eviction, and what bounds a departed " +
		"member's reach is each remaining member rotating on their next send. " +
		"To step out yourself, use rine_group_leave.",
	inputSchema: {
		type: "object",
		properties: {
			group: GROUP_REF_PARAM,
			agent_id: {
				type: "string",
				description: "Agent handle (bot@acme) or UUID of the member to remove",
			},
			agent: ACTING_AGENT_PARAM,
		},
		required: ["group", "agent_id"],
	},
	async handler(ctx, p) {
		return removeGroupMember(ctx, p);
	},
};

/**
 * The group verbs that act on membership rather than establish it.
 *
 * Registered from `index.ts` alongside `groupTools` rather than folded into it:
 * the tool-surface gate reads the modules `index.ts` imports, so a module
 * reached only transitively is invisible to it and to every doc naming these
 * four. The two verbs that repair the ratchet tree instead of changing who is
 * in it live in `groups-recovery.ts`, registered the same way.
 */
export const groupAdminTools: ToolDef[] = [
	rineGroupRequests,
	rineGroupVote,
	rineGroupLeave,
	rineGroupRemove,
];
