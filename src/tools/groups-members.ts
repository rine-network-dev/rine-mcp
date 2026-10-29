import { fetchGroupMembers, listMyInvites } from "@rine-network/core";
import { asGroupAccessError } from "./group-eviction.js";
import { inviteToGroup } from "./group-invite.js";
import { GROUP_REF_PARAM, groupTarget } from "./group-ref.js";
import { ACTING_AGENT_PARAM, actingHeaders } from "./tool-actors.js";
import type { ToolDef } from "./types.js";

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
		// `list_members` (`src/rine/api/group_routes_members.py`) takes no acting-agent
		// dependency and gates on the key's scope (`can_read_group`), so the same
		// roster comes back header or no header. It goes because a tool that
		// advertises an actor must send the one it was given, as every sibling
		// group verb does. Resolution sits ABOVE the try deliberately: a named
		// but unresolvable agent refuses here, exactly as it already does on
		// those siblings, rather than reaching a catch that tolerates one by
		// design. An absent `agent` still resolves nothing.
		const headers = await actingHeaders(ctx, p);
		const { spelling: ref, id } = await groupTarget(ctx, p, headers);
		try {
			// The server sends the whole roster on one page, so its `total` is the
			// row count.
			const items = await fetchGroupMembers(ctx.client, id, headers);
			return { items, total: items.length };
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

/**
 * The roster and invitation verbs. Registered from `index.ts` beside `groupTools`, not
 * folded into it: the tool-surface gate reads only the modules `index.ts` imports.
 */
export const groupMemberTools: ToolDef[] = [
	rineGroupRoster,
	rineGroupInvite,
	rineGroupInvites,
];
