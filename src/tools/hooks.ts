// MCP funnel MANAGEMENT tools: rine_hook_create / rine_hook_list
// / rine_hook_delete. Thin request/response wrappers cloned from rine_groups for
// the X-Rine-Agent resolution pattern. The long-lived `rine relay` is NEVER an
// MCP tool (a never-returning relay would hang the stdio transport).
//
// FROZEN-CONTRACT: rine_hook_create generates the HMAC secret CLIENT-SIDE
// (randomBytes(32) hex) and POSTs ONLY {hook_name, tier: null} — never a secret.
// It persists the secret 0600 under the MCP server's config dir and the result
// states WHERE it was stored (the relay box may differ → point it there with
// --secret-file/--secret-env). A failed create puts the local secret back the
// way it was. The secret appears in create output ONLY, never in list.

import { createHook, deleteHookSecret } from "@rine-network/core";
import {
	ACTING_AGENT_PARAM,
	actingAgent,
	withActorNote,
} from "./tool-actors.js";
import type { ToolDef } from "./types.js";

const SIGNATURE_HEADER = "X-Hub-Signature-256";
const CONTENT_TYPE = "application/json";

const rineHookCreate: ToolDef = {
	name: "rine_hook_create",
	description:
		"Allocate an inbound webhook funnel hook for an agent. Generates an HMAC " +
		"secret locally and returns the public URL + GitHub setup. The secret is " +
		"shown once; save it now — it is stored on this machine, not on rine. The " +
		"returned `tier` is the termination tier resolved from the org's trust tier " +
		"(zero-trust, where rine never sees the cleartext, for Tier 2 and above); to " +
		"choose it explicitly use the CLI `rine hook create --tier zero-trust|shared-edge`.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "Hook name (lowercase, hyphens; default: default)",
			},
			agent: ACTING_AGENT_PARAM,
		},
	},
	async handler(ctx, p) {
		const name = p.name ? String(p.name) : "default";
		const acting = await actingAgent(ctx, p);
		const agentId = acting.agentId;

		// No tier: the server resolves it from the org's trust tier.
		const { created, secret, storedAt } = await createHook(
			ctx.client,
			ctx.configDir,
			agentId,
			name,
		);

		return withActorNote(
			{
				name: created.hook_name,
				hostname: created.hostname,
				tier: created.termination,
				// SNI-routed by hostname; the relay ignores the request path, so the
				// payload URL is the bare host root (matches `rine hook create`).
				public_url: `https://${created.hostname}/`,
				secret,
				signature_header: SIGNATURE_HEADER,
				content_type: CONTENT_TYPE,
				secret_stored_at: storedAt,
				note: `Secret saved at ${storedAt}. It is shown once and not stored on rine. To run the relay on another machine, pass it via --secret-file or --secret-env.`,
			},
			acting,
		);
	},
};

const rineHookList: ToolDef = {
	name: "rine_hook_list",
	description:
		"List an agent's inbound webhook funnel hooks (no secrets are returned).",
	inputSchema: {
		type: "object",
		properties: {
			agent: ACTING_AGENT_PARAM,
		},
	},
	async handler(ctx, p) {
		const acting = await actingAgent(ctx, p);
		return withActorNote(
			await ctx.client.get(`/agents/${acting.agentId}/funnel/hooks`),
			acting,
		);
	},
};

const rineHookDelete: ToolDef = {
	name: "rine_hook_delete",
	description:
		"Delete an inbound webhook funnel hook and purge its local secret.",
	inputSchema: {
		type: "object",
		properties: {
			name: { type: "string", description: "Hook name to delete" },
			agent: ACTING_AGENT_PARAM,
		},
		required: ["name"],
	},
	async handler(ctx, p) {
		const name = String(p.name);
		const acting = await actingAgent(ctx, p);
		const agentId = acting.agentId;
		await ctx.client.delete(`/agents/${agentId}/funnel/hooks/${name}`);
		deleteHookSecret(ctx.configDir, agentId, name);
		return withActorNote({ ok: true }, acting);
	},
};

export const hookTools: ToolDef[] = [
	rineHookCreate,
	rineHookList,
	rineHookDelete,
];
