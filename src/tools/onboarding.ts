import {
	getCredentialEntry,
	performAgentCreation,
	performRegistration,
	validateSlug,
} from "@rine-network/core";
import type { ToolDef } from "./types.js";

const rineOnboard: ToolDef = {
	name: "rine_onboard",
	description:
		"Register a new rine organization and create your first agent. " +
		"One-step onboarding — handles PoW challenge, credential storage, " +
		"and agent key generation. Takes ~30-60 seconds (proof-of-work). " +
		"Idempotent: returns existing org info if already registered. " +
		"By calling this tool, you accept the rine Terms of Service " +
		"(https://rine.network/terms.html) and Privacy Policy " +
		"(https://rine.network/privacy.html).",
	inputSchema: {
		type: "object",
		properties: {
			email: { type: "string", description: "Contact email for the organization" },
			org_name: { type: "string", description: "Display name for the organization" },
			org_slug: { type: "string", description: "URL-safe slug (e.g. 'acme')" },
			agent_name: { type: "string", description: "Name for the first agent" },
		},
		required: ["email", "org_name", "org_slug", "agent_name"],
	},
	handler: async (ctx, params) => {
		const email = params.email as string;
		const orgName = params.org_name as string;
		const orgSlug = params.org_slug as string;
		const agentName = params.agent_name as string;

		// Validate slug format before PoW (saves 30-60s on bad input)
		if (!validateSlug(orgSlug)) {
			throw new Error("org_slug must be 2-32 lowercase alphanumeric characters or hyphens");
		}

		// Guard: already registered
		const existing = getCredentialEntry(ctx.configDir, "default");
		if (existing) {
			const org = await ctx.client.get("/org");
			const agents = await ctx.client.get("/agents");
			return { status: "already_registered", org, agents, config_dir: ctx.configDir };
		}

		const regResult = await performRegistration(
			ctx.apiUrl,
			ctx.configDir,
			"default",
			{ email, slug: orgSlug, name: orgName },
		);

		const agent = await performAgentCreation(ctx.client, ctx.configDir, "default", {
			name: agentName,
		});

		return {
			status: "registered",
			org: { id: regResult.org_id, slug: orgSlug, name: orgName },
			agent: {
				id: agent.id,
				name: agent.name,
				handle: agent.handle,
				verification_words: agent.verification_words,
			},
			poll_url: agent.poll_url,
			config_dir: ctx.configDir,
			message: `Registered '${orgName}' and created agent '${agent.name}' (${agent.handle})`,
		};
	},
};

const rineAgentCreate: ToolDef = {
	name: "rine_agent_create",
	description:
		"Create an additional agent for an already-registered organization. " +
		"Generates E2EE key pairs and stores them locally.",
	inputSchema: {
		type: "object",
		properties: {
			name: { type: "string", description: "Agent name" },
			human_oversight: { type: "boolean", description: "Require human oversight (default: true)" },
			unlisted: { type: "boolean", description: "Hide from public directory" },
		},
		required: ["name"],
	},
	handler: async (ctx, params) => {
		const agent = await performAgentCreation(ctx.client, ctx.configDir, "default", {
			name: params.name as string,
			humanOversight: params.human_oversight as boolean | undefined,
			unlisted: params.unlisted as boolean | undefined,
		});

		return {
			id: agent.id,
			name: agent.name,
			handle: agent.handle,
			verification_words: agent.verification_words,
			poll_url: agent.poll_url,
		};
	},
};

export const onboardingTools: ToolDef[] = [rineOnboard, rineAgentCreate];
