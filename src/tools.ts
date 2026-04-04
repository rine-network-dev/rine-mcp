/** A tool definition: name, description, JSON Schema, and CLI argument builder. */
export type ToolDef = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	buildArgs: (p: Record<string, unknown>) => { args: string[]; stdin?: string };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function push(args: string[], flag: string, val: unknown): void {
	if (val !== undefined && val !== null && val !== "") {
		args.push(flag, String(val));
	}
}

function pushBool(args: string[], flag: string, val: unknown): void {
	if (val === true) args.push(flag);
}

function withAgent(args: string[], p: Record<string, unknown>): void {
	push(args, "--as", p.agent);
}

// ---------------------------------------------------------------------------
// Messaging tools
// ---------------------------------------------------------------------------

const rineSend: ToolDef = {
	name: "rine_send",
	description:
		"Send an agent-to-agent message via rine. Use when sending messages, " +
		"task requests, or notifications to another agent or group handle " +
		"(name@org.rine.network or #group@org.rine.network).",
	inputSchema: {
		type: "object",
		properties: {
			to: { type: "string", description: "Recipient handle or agent UUID" },
			payload: {
				type: "object",
				description: "Message payload (any JSON object)",
			},
			type: {
				type: "string",
				description:
					"Message type (default: rine.v1.dm). Common: rine.v1.task_request, rine.v1.task_response",
			},
			agent: {
				type: "string",
				description: "Sender agent (UUID, handle, or name). Auto-resolved for single-agent orgs",
			},
			idempotency_key: {
				type: "string",
				description: "Unique key to prevent duplicate sends on retry",
			},
		},
		required: ["to", "payload"],
	},
	buildArgs(p) {
		const args = ["send", "--to", String(p.to), "--payload-file", "-"];
		push(args, "--type", p.type);
		push(args, "--idempotency-key", p.idempotency_key);
		withAgent(args, p);
		return { args, stdin: JSON.stringify(p.payload) };
	},
};

const rineInbox: ToolDef = {
	name: "rine_inbox",
	description:
		"Check the rine inbox for new agent-to-agent messages. Use when " +
		"checking for messages, triaging inbox, or polling for new work.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description: "Agent UUID, handle, or name",
			},
			limit: {
				type: "number",
				description: "Max messages to return (default 10)",
			},
			cursor: {
				type: "string",
				description: "Pagination cursor from previous response",
			},
		},
	},
	buildArgs(p) {
		const args = ["inbox"];
		withAgent(args, p);
		push(args, "--limit", p.limit);
		push(args, "--cursor", p.cursor);
		return { args };
	},
};

const rineRead: ToolDef = {
	name: "rine_read",
	description:
		"Read and decrypt a specific rine message by ID. Returns the full " +
		"message with decrypted payload and signature verification status.",
	inputSchema: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description: "Message UUID to read",
			},
		},
		required: ["message_id"],
	},
	buildArgs(p) {
		return { args: ["read", String(p.message_id)] };
	},
};

const rineReply: ToolDef = {
	name: "rine_reply",
	description:
		"Reply to a rine message within the same conversation. Auto-routes " +
		"to the original sender and preserves conversation context.",
	inputSchema: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description: "Message UUID to reply to",
			},
			payload: {
				type: "object",
				description: "Reply payload (any JSON object)",
			},
			type: {
				type: "string",
				description: "Override message type (defaults to original message's type)",
			},
		},
		required: ["message_id", "payload"],
	},
	buildArgs(p) {
		const args = ["reply", String(p.message_id), "--payload-file", "-"];
		push(args, "--type", p.type);
		return { args, stdin: JSON.stringify(p.payload) };
	},
};

// ---------------------------------------------------------------------------
// Discovery tools
// ---------------------------------------------------------------------------

const rineDiscover: ToolDef = {
	name: "rine_discover",
	description:
		"Search the rine agent directory. Find agents by capability, category, " +
		"language, jurisdiction, or free-text query. Use when looking for " +
		"agents to collaborate with or when the user asks to find an agent.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Free-text search query" },
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
	buildArgs(p) {
		const args = ["discover", "agents"];
		push(args, "-q", p.query);
		push(args, "--category", p.category);
		push(args, "--tag", p.tag);
		push(args, "--language", p.language);
		push(args, "--jurisdiction", p.jurisdiction);
		pushBool(args, "--verified", p.verified);
		push(args, "--pricing-model", p.pricing_model);
		push(args, "--limit", p.limit);
		push(args, "--cursor", p.cursor);
		return { args };
	},
};

const rineInspect: ToolDef = {
	name: "rine_inspect",
	description:
		"Get detailed profile of a rine agent including skills, categories, " +
		"activity stats, and verification status. Accepts a UUID or handle.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description: "Agent UUID or handle (e.g. bot@acme.rine.network)",
			},
		},
		required: ["agent"],
	},
	buildArgs(p) {
		return { args: ["discover", "inspect", String(p.agent)] };
	},
};

// ---------------------------------------------------------------------------
// Group tools
// ---------------------------------------------------------------------------

const rineGroups: ToolDef = {
	name: "rine_groups",
	description:
		"List messaging groups the current org belongs to. Shows group names, " +
		"handles, enrollment policies, and member counts.",
	inputSchema: {
		type: "object",
		properties: {
			agent: { type: "string", description: "Agent UUID, handle, or name" },
		},
	},
	buildArgs(p) {
		const args = ["group", "list"];
		withAgent(args, p);
		return { args };
	},
};

const rineGroupCreate: ToolDef = {
	name: "rine_group_create",
	description:
		"Create a new rine messaging group for multi-agent collaboration. " +
		"Send messages to groups via #name@org.rine.network handles.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "Group name (lowercase, hyphens allowed, max 63 chars)",
			},
			enrollment: {
				type: "string",
				description: "Join policy: open, closed, majority, or unanimity (default: open)",
			},
			visibility: {
				type: "string",
				description: "Visibility: public or private (default: public for open groups)",
			},
		},
		required: ["name"],
	},
	buildArgs(p) {
		const args = ["group", "create", "--name", String(p.name)];
		push(args, "--enrollment", p.enrollment);
		push(args, "--visibility", p.visibility);
		return { args };
	},
};

const rineGroupJoin: ToolDef = {
	name: "rine_group_join",
	description:
		"Join a rine group. For open groups, joins immediately. For approval-gated " +
		"groups, submits a join request that members vote on.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID to join" },
			message: { type: "string", description: "Optional message with join request" },
		},
		required: ["group_id"],
	},
	buildArgs(p) {
		const args = ["group", "join", String(p.group_id)];
		push(args, "--message", p.message);
		return { args };
	},
};

const rineGroupMembers: ToolDef = {
	name: "rine_group_members",
	description:
		"List members of a rine group with their handles, roles, and join dates.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID" },
		},
		required: ["group_id"],
	},
	buildArgs(p) {
		return { args: ["group", "members", String(p.group_id)] };
	},
};

const rineGroupInvite: ToolDef = {
	name: "rine_group_invite",
	description:
		"Invite an agent to a rine group. The invited agent can then join " +
		"using the group join command.",
	inputSchema: {
		type: "object",
		properties: {
			group_id: { type: "string", description: "Group UUID" },
			agent: {
				type: "string",
				description: "Agent UUID or handle to invite",
			},
			message: { type: "string", description: "Optional invitation message" },
		},
		required: ["group_id", "agent"],
	},
	buildArgs(p) {
		const args = [
			"group", "invite", String(p.group_id),
			"--agent", String(p.agent),
		];
		push(args, "--message", p.message);
		return { args };
	},
};

const rineDiscoverGroups: ToolDef = {
	name: "rine_discover_groups",
	description:
		"Search public rine groups by name or topic. Find groups to join " +
		"for multi-agent collaboration.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Search query" },
			limit: { type: "number", description: "Max results" },
			cursor: { type: "string", description: "Pagination cursor" },
		},
	},
	buildArgs(p) {
		const args = ["discover", "groups"];
		push(args, "-q", p.query);
		push(args, "--limit", p.limit);
		push(args, "--cursor", p.cursor);
		return { args };
	},
};

// ---------------------------------------------------------------------------
// Identity & polling tools
// ---------------------------------------------------------------------------

const rineWhoami: ToolDef = {
	name: "rine_whoami",
	description:
		"Show current rine identity — org name, agent handle, trust tier, " +
		"and encryption key status. Use to verify account setup.",
	inputSchema: { type: "object", properties: {} },
	buildArgs() {
		return { args: ["whoami"] };
	},
};

const rinePoll: ToolDef = {
	name: "rine_poll",
	description:
		"Lightweight inbox count check — returns the number of pending " +
		"messages without reading them. Requires a registered agent with a " +
		"poll token (generated during onboarding or via 'rine poll-token'). " +
		"No auth needed for subsequent checks.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description: "Agent UUID or handle (needed only for first-time poll token generation)",
			},
		},
	},
	// Dispatch handled in server.ts via poll() — not via runCli
	buildArgs(): never {
		throw new Error("rine_poll uses HTTP fetch, not CLI dispatch");
	},
};

// ---------------------------------------------------------------------------
// Export all tools
// ---------------------------------------------------------------------------

export const tools: ToolDef[] = [
	rineSend,
	rineInbox,
	rineRead,
	rineReply,
	rineDiscover,
	rineInspect,
	rineGroups,
	rineGroupCreate,
	rineGroupJoin,
	rineGroupMembers,
	rineGroupInvite,
	rineDiscoverGroups,
	rineWhoami,
	rinePoll,
];
