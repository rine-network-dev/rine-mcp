/**
 * `rine_group_inspect` — what KIND of group this is, as against who is in it.
 *
 * Its own module because `groups.ts` is already past the file-size ceiling, and
 * because this tool answers the question the roster does not: an agent that can
 * list a group's members still has no way to learn whether the group runs MLS
 * or Sender Keys, and the choice was made for it by the enrollment policy.
 *
 * Which read answers is the ladder's to choose, not this module's: a UUID is
 * read off `GET /groups/{group_id}` and a name or a handle out of the org's
 * `GET /groups` list. Both build through `_build_group_read`
 * (`src/rine/api/groups.py`), so the MLS fields are on the row either way.
 *
 * Both reads are ORG-scoped and neither takes acting-agent narrowing —
 * `list_groups` selects every group any agent of the calling org holds a seat
 * in, and `get_group`'s `has_read_access` admits the owning org or any org with
 * a seated agent — so the group being FOUND here is not proof the named agent
 * may post to it. What answers that is `member_agent_ids` on the row itself:
 * it names which of the caller's own agents are seated, and it rides
 * through the spread below untouched, so the caller can look for the acting
 * agent's id in it. Same scope as `rine_send`'s group lookup; do not describe
 * either read as per-agent.
 *
 * 🔴 The list and the match are `resolveGroupRef`'s, not this module's. It held
 * its own two-branch matcher — id equality or a normalised whole handle — which
 * meant the one group verb here that could not take a bare
 * name was the one whose whole job is answering *what KIND of group is this*,
 * asked before posting to it. Every other verb on this surface now resolves
 * through that ladder, and a surface where nine verbs accept a spelling and the
 * tenth refuses it teaches a model that the spelling is unreliable.
 */

import { groupEncryption, resolveGroupRef } from "@rine-network/core";
import { ACTING_AGENT_PARAM, actingHeaders } from "./group-actors.js";
import { GROUP_REF_PARAM, groupRefArgument } from "./group-ref.js";
import type { ToolDef } from "./types.js";

const rineGroupInspect: ToolDef = {
	name: "rine_group_inspect",
	description:
		"Show a group's kind: its enrollment policy and encryption mode (MLS or " +
		"sender-key), so you can tell how a group is run before posting to it. " +
		"It covers every group this org holds a seat in. The reply carries " +
		"member_agent_ids — which of your agents are seated in it, empty when " +
		"none is — so it also answers whether the acting agent may post. It does " +
		"not list members — use rine_group_roster for that.",
	inputSchema: {
		type: "object",
		properties: {
			group: GROUP_REF_PARAM,
			agent: ACTING_AGENT_PARAM,
		},
		required: ["group"],
	},
	async handler(ctx, p) {
		const headers = await actingHeaders(ctx, p);
		const group = await resolveGroupRef(ctx.client, groupRefArgument(p), headers);
		// `groupEncryption` is rine-core's single answer to "which cryptography
		// does this group actually run, and is it post-quantum" — the same one the
		// CLI prints. A second reading of the same fields here is how surfaces
		// ended up labelling a sender-key group "MLS".
		return { ...group, encryption: groupEncryption(group) };
	},
};

export const groupInspectTools: ToolDef[] = [rineGroupInspect];
