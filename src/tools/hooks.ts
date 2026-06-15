// REQ-CLI-10/11 — MCP funnel MANAGEMENT tools: rine_hook_create / rine_hook_list
// / rine_hook_delete. Thin request/response wrappers cloned from rine_groups for
// the X-Rine-Agent resolution pattern. The long-lived `rine relay` is NEVER an
// MCP tool (a never-returning relay would hang the stdio transport, REQ-CLI-11).
//
// FROZEN-CONTRACT: rine_hook_create generates the HMAC secret CLIENT-SIDE
// (randomBytes(32) hex) and POSTs ONLY {hook_name} — never a secret. It persists
// the secret 0600 under the MCP server's config dir and the result states WHERE
// it was stored (the relay box may differ → point it there with --secret-file/
// --secret-env). The secret appears in create output ONLY, never in list.

import {
	type HookCreated,
	deleteHookSecret,
	fetchAgents,
	generateHookSecret,
	resolveAgent,
	saveHookSecret,
} from "@rine-network/core";
import type { ToolContext, ToolDef } from "./types.js";

const SIGNATURE_HEADER = "X-Hub-Signature-256";
const CONTENT_TYPE = "application/json";

async function resolveAgentId(
	ctx: ToolContext,
	agent?: unknown,
): Promise<string> {
	const agents = await fetchAgents(ctx.client);
	return resolveAgent(ctx.apiUrl, agents, agent as string | undefined);
}

const rineHookCreate: ToolDef = {
	name: "rine_hook_create",
	description:
		"Allocate an inbound webhook funnel hook for an agent. Generates an HMAC " +
		"secret locally and returns the public URL + GitHub setup. The secret is " +
		"shown once; save it now — it is stored on this machine, not on rine.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "Hook name (lowercase, hyphens; default: default)",
			},
			agent: {
				type: "string",
				description: "Agent name, handle, or UUID (multi-agent orgs)",
			},
		},
	},
	async handler(ctx, p) {
		const name = p.name ? String(p.name) : "default";
		const agentId = await resolveAgentId(ctx, p.agent);

		// Generate + persist the secret locally; POST carries ONLY {hook_name}.
		const secret = generateHookSecret();
		const storedAt = saveHookSecret(ctx.configDir, agentId, name, secret);
		const created = (await ctx.client.post(`/agents/${agentId}/funnel/hooks`, {
			hook_name: name,
		})) as HookCreated;

		return {
			name: created.hook_name,
			hostname: created.hostname,
			public_url: `https://${created.hostname}/${name}`,
			secret,
			signature_header: SIGNATURE_HEADER,
			content_type: CONTENT_TYPE,
			secret_stored_at: storedAt,
			note: `Secret saved at ${storedAt}. It is shown once and not stored on rine. To run the relay on another machine, pass it via --secret-file or --secret-env.`,
		};
	},
};

const rineHookList: ToolDef = {
	name: "rine_hook_list",
	description:
		"List an agent's inbound webhook funnel hooks (no secrets are returned).",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description: "Agent name, handle, or UUID (multi-agent orgs)",
			},
		},
	},
	async handler(ctx, p) {
		const agentId = await resolveAgentId(ctx, p.agent);
		return ctx.client.get(`/agents/${agentId}/funnel/hooks`);
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
			agent: {
				type: "string",
				description: "Agent name, handle, or UUID (multi-agent orgs)",
			},
		},
		required: ["name"],
	},
	async handler(ctx, p) {
		const name = String(p.name);
		const agentId = await resolveAgentId(ctx, p.agent);
		await ctx.client.delete(`/agents/${agentId}/funnel/hooks/${name}`);
		deleteHookSecret(ctx.configDir, agentId, name);
		return { ok: true };
	},
};

export const hookTools: ToolDef[] = [
	rineHookCreate,
	rineHookList,
	rineHookDelete,
];
