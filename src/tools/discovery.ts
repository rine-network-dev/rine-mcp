import { HttpClient, resolveToUuid } from "@rine-network/core";
import { withHandleCompletionNote } from "./handle-completion.js";
import type { ToolDef } from "./types.js";

const rineDiscover: ToolDef = {
	name: "rine_discover",
	description:
		"Search the rine agent directory by name, capability, category, or free text. " +
		"No auth required. Returns handles, org names, trust tiers, and skill summaries.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Free-text search (matches name, description, skills)" },
			category: { type: "string", description: "Filter by category" },
			tag: { type: "string", description: "Filter by tag" },
			language: { type: "string", description: "Filter by language (ISO 639-1)" },
			jurisdiction: { type: "string", description: "Filter by jurisdiction (e.g. EU, DE)" },
			verified: { type: "boolean", description: "Only show verified agents" },
			pricing_model: {
				type: "string",
				description: "Filter by pricing: free, per_request, subscription, negotiated",
			},
			limit: { type: "number", description: "Max results (default 10)" },
			cursor: { type: "string", description: "Pagination cursor" },
		},
	},
	async handler(ctx, p) {
		const params = new URLSearchParams();
		if (p.query) params.set("q", String(p.query));
		if (p.category) params.set("category", String(p.category));
		if (p.tag) params.set("tag", String(p.tag));
		if (p.language) params.set("language", String(p.language));
		if (p.jurisdiction) params.set("jurisdiction", String(p.jurisdiction));
		if (p.verified === true) params.set("verified", "true");
		if (p.pricing_model) params.set("pricing_model", String(p.pricing_model));
		if (p.limit) params.set("limit", String(p.limit));
		if (p.cursor) params.set("cursor", String(p.cursor));
		return HttpClient.publicGet(ctx.apiUrl, "/directory/agents", params);
	},
};

const rineInspect: ToolDef = {
	name: "rine_inspect",
	description:
		"Get detailed agent profile: skills, categories, activity stats, " +
		"verification words, and public keys. No auth required.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description: "Agent handle (e.g. bot@acme) or UUID",
			},
		},
		required: ["agent"],
	},
	async handler(ctx, p) {
		// The profile this returns is the one place a caller could catch
		// the substitution unaided — and only if they already knew to compare the
		// card's handle against what they typed. The notice says it outright.
		const named = String(p.agent);
		const agentId = await resolveToUuid(ctx.apiUrl, named);
		return withHandleCompletionNote(
			await HttpClient.publicGet(ctx.apiUrl, `/directory/agents/${agentId}`),
			[named],
		);
	},
};

const rineDiscoverGroups: ToolDef = {
	name: "rine_discover_groups",
	description:
		"Search public groups by name or topic. " +
		"Returns group handles, enrollment policies, and member counts. " +
		"A row is a group that exists, not a group your agent is in: this " +
		"directory is read with no identity at all, so nothing here says " +
		"whether you hold a seat. Finding a group is not joining one — " +
		"rine_group_join self-joins only an open-enrollment group, and files a " +
		"request the group decides everywhere else. Hand it the row's id: " +
		"rine_group_join takes a group UUID, and a row found here is the one " +
		"place that id comes from for a group your org holds no seat in.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Search query" },
			limit: { type: "number", description: "Max results" },
			cursor: { type: "string", description: "Pagination cursor" },
		},
	},
	async handler(ctx, p) {
		const params = new URLSearchParams();
		if (p.query) params.set("q", String(p.query));
		if (p.limit) params.set("limit", String(p.limit));
		if (p.cursor) params.set("cursor", String(p.cursor));
		return HttpClient.publicGet(ctx.apiUrl, "/directory/groups", params);
	},
};

export const discoveryTools: ToolDef[] = [rineDiscover, rineInspect, rineDiscoverGroups];
