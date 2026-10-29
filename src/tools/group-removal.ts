import {
	ACTING_AGENT_HEADER,
	type GroupRead,
	deleteGroupMember,
	evictionMessage,
	loadMlsState,
	resolveToUuid,
	retireLocalGroupState,
	retirementMessage,
} from "@rine-network/core";
import { groupTarget } from "./group-ref.js";
import { withHandleCompletionNote } from "./handle-completion.js";
import {
	actingAgent,
	agentHeaders,
	namedActingAgent,
	withActorNote,
} from "./tool-actors.js";
import type { ToolContext } from "./types.js";

/** The group, or null when it cannot be read — only the sentence depends on it. */
async function readGroup(
	ctx: ToolContext,
	groupId: string,
): Promise<GroupRead | null> {
	try {
		return (await ctx.client.get(`/groups/${groupId}`)) as GroupRead;
	} catch {
		return null;
	}
}

/**
 * Leave a group, then retire this agent's local key material for it.
 *
 * Server first: a refused leave must never leave a member still in the group
 * with no keys to read it.
 *
 * 🔴 `X-Rine-Agent` is mandatory here, and is why the acting agent is resolved
 * before anything else. The server tells a leave from a kick by that header
 * alone and fails closed — without it a multi-agent org's leave is read as a
 * kick and asked for a Remove commit nobody can mint, since MLS gives no member
 * a way to commit their own removal. That is also why no acting admin is passed
 * to `deleteGroupMember`: the server's self-leave carve-out answers this, and
 * there is no commit to post.
 */
export async function leaveGroup(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<unknown> {
	const acting = await actingAgent(ctx, p);
	const agentId = acting.agentId;
	const { id: groupId } = await groupTarget(ctx, p, {
		[ACTING_AGENT_HEADER]: agentId,
	});
	const group = await readGroup(ctx, groupId);
	// Sampled before the wipe: it is the fallback for the sentence below when the
	// group itself could not be read.
	const heldMlsState = loadMlsState(ctx.configDir, agentId, groupId) !== null;

	await deleteGroupMember(
		ctx.client,
		ctx.configDir,
		groupId,
		agentId,
		undefined,
		{ [ACTING_AGENT_HEADER]: agentId },
	);
	const wipe = retireLocalGroupState(ctx.configDir, agentId, groupId);

	return withActorNote(
		{
			left: true,
			local_state_retired: wipe.retired,
			// A wipe that did not happen is reported as one that did not happen:
			// telling a caller that key material is gone while it is still on disk
			// is the defect this field exists to stop.
			local_state_error: wipe.error ?? null,
			message: retirementMessage(group, heldMlsState),
		},
		acting,
	);
}

/**
 * Remove another member from a group.
 *
 * The DELETE goes first and the Remove commit only when the server asks for it —
 * `deleteGroupMember` encodes that order, which is a security control rather
 * than a style: posting the commit first would evict the target before the
 * server has said whether this caller may remove anybody.
 *
 * The acting agent is resolved **lazily**, so a kick from a multi-agent org that
 * named none still works on every group that needs no commit.
 */
export async function removeGroupMember(
	ctx: ToolContext,
	p: Record<string, unknown>,
): Promise<unknown> {
	const named = String(p.agent_id);
	const targetId = await resolveToUuid(ctx.apiUrl, named);
	// Headerless, like the acting agent below it: a kick that named nobody must
	// keep working on a multi-agent org, and `GET /groups` follows the key, not the header, anyway.
	const { id: groupId } = await groupTarget(ctx, p);
	const group = await readGroup(ctx, groupId);

	// Named, not resolved-with-a-fallback: this is still the lazy rung, and a kick
	// that named nobody must not start refusing on a multi-agent org. What it adds
	// over a bare header is the note — a one-agent org that named a value nobody
	// answers to removed the member anyway, and this result says so.
	const acting = await namedActingAgent(ctx, p);
	const removal = await deleteGroupMember(
		ctx.client,
		ctx.configDir,
		groupId,
		targetId,
		async () => (await actingAgent(ctx, p)).agentId,
		agentHeaders(acting?.agentId ?? null),
	);

	// This verb is where a silent completion is least recoverable: a removal
	// takes nothing back. `removed` already echoes the caller's own
	// spelling, which is exactly why the notice is owed — the echo agrees with
	// what was typed while the eviction landed on the completed handle.
	return withHandleCompletionNote(
		withActorNote(
			{
				removed: named,
				agent_id: targetId,
				mls_removal_epoch: removal?.epoch ?? null,
				mls_removed_leaf: removal?.removedLeaf ?? null,
				message: evictionMessage(group, removal),
			},
			acting,
		),
		[named],
	);
}
