import { ACTING_AGENT_PARAM } from "./group-actors.js";
import { reclaimGroupLeaves } from "./group-reclaim.js";
import { syncGroupState } from "./group-sync.js";
import { GROUP_REF_PARAM } from "./group-ref.js";
import type { ToolDef } from "./types.js";

const rineGroupSync: ToolDef = {
	name: "rine_group_sync",
	description:
		"Catch this agent's encryption state up with a group it can no longer " +
		"read, and report what that cost. Closed, majority and unanimity groups " +
		"run post-quantum MLS and have an epoch chain: the cheap rung replays the " +
		"commits the group stored and posts nothing; the expensive rung posts one " +
		"external commit that is O(N) and is billed to every member. An open " +
		"group runs Sender Keys and has no epoch chain, so there this installs " +
		"the sender keys this agent is missing — the ones waiting in its own " +
		"inbox — and posts nothing at all. Either way the answer names which " +
		"ran. A group created to run MLS whose ratchet tree was never founded " +
		"runs Sender Keys too, so it gets that same install, and the answer " +
		"additionally warns that the group has not got the MLS it was created " +
		"for — a member has to found the group's MLS state, and no verb here " +
		"does that.",
	inputSchema: {
		type: "object",
		properties: { group: GROUP_REF_PARAM, agent: ACTING_AGENT_PARAM },
		required: ["group"],
	},
	async handler(ctx, p) {
		return syncGroupState(ctx, p);
	},
};

const rineGroupReclaim: ToolDef = {
	name: "rine_group_reclaim",
	description:
		"Retire the ratchet-tree leaves a group's members and live invitations do " +
		"not account for. A lapsed invitation frees its seat but not its leaf, and " +
		"a member who leaves takes their row and not their leaf either — nobody " +
		"can commit their own removal — so a group that churns invitations makes " +
		"every later commit heavier for everyone in it, without bound. Nothing " +
		"retires a leaf until a member runs this: the server holds no MLS keys, " +
		"and it takes membership and no role beyond it, so any member may. It " +
		"costs one Remove commit per leaf, each O(N) and billed to every member, " +
		"which is why it is a call and not a background chore. Seats anyone " +
		"entitled to a leaf who has none first, so an agent that rotated its " +
		"signing key is re-seated rather than dropped. Closed, majority and " +
		"unanimity groups have a ratchet tree; an open group runs Sender Keys and " +
		"has none.",
	inputSchema: {
		type: "object",
		properties: { group: GROUP_REF_PARAM, agent: ACTING_AGENT_PARAM },
		required: ["group"],
	},
	async handler(ctx, p) {
		return reclaimGroupLeaves(ctx, p);
	},
};

/**
 * The two verbs that repair a group's ratchet tree rather than change who is in
 * it: one catches this agent up with the tree, the other retires the leaves the
 * tree is carrying for nobody.
 *
 * A registry of its own, imported by `index.ts` directly, for two reasons that
 * pull the same way. `groups-admin.ts` sits at the file-size ceiling, and the
 * tool-surface gate reads only the modules `index.ts` imports
 * (`scripts/lib/skill-tool-sources.mjs:mcpNames`) — so a ToolDef parked in a
 * module reached transitively would be served and yet invisible to every gate
 * and every doc that counts this surface's tools.
 */
export const groupRecoveryTools: ToolDef[] = [rineGroupSync, rineGroupReclaim];
