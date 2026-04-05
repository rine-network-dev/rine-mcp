import type { MessageRead, PaginatedResponse } from "@rine-network/core";
import {
	agentKeysExist,
	decryptGroupMessage,
	decryptMessage,
	encryptGroupMessage,
	encryptMessage,
	fetchAgents,
	fetchRecipientEncryptionKey,
	getOrCreateSenderKey,
	ingestSenderKeyDistribution,
	resolveAgent,
	resolveToUuid,
} from "@rine-network/core";
import type { ToolDef } from "./types.js";

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
	async handler(ctx, p) {
		const agents = await fetchAgents(ctx.client);
		const agentId = await resolveAgent(ctx.apiUrl, agents, p.agent as string | undefined);

		const to = String(p.to);
		const isGroup = to.startsWith("#");

		if (isGroup) {
			const groupHandle = to.slice(1);
			const extraHeaders: Record<string, string> = { "X-Rine-Agent": agentId };

			const { state, groupId } = await getOrCreateSenderKey(
				ctx.client, ctx.configDir, agentId, groupHandle, extraHeaders,
			);

			const { result } = await encryptGroupMessage(
				ctx.configDir, agentId, groupId, state, p.payload,
			);

			const headers: Record<string, string> = { "X-Rine-Agent": agentId };
			if (p.idempotency_key) {
				headers["Idempotency-Key"] = String(p.idempotency_key);
			}

			return ctx.client.post("/messages", {
				to_handle: to,
				type: p.type ?? "rine.v1.dm",
				...result,
			}, headers);
		}

		const recipientId = await resolveToUuid(ctx.apiUrl, to);
		const recipientEncPk = await fetchRecipientEncryptionKey(ctx.client, recipientId);
		const result = await encryptMessage(ctx.configDir, agentId, recipientEncPk, p.payload);

		const headers: Record<string, string> = { "X-Rine-Agent": agentId };
		if (p.idempotency_key) {
			headers["Idempotency-Key"] = String(p.idempotency_key);
		}

		return ctx.client.post("/messages", {
			to_agent_id: recipientId,
			type: p.type ?? "rine.v1.dm",
			...result,
		}, headers);
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
	async handler(ctx, p) {
		const agents = await fetchAgents(ctx.client);
		const agentId = await resolveAgent(ctx.apiUrl, agents, p.agent as string | undefined);

		const params: Record<string, string | number | boolean> = {};
		if (p.limit) params.limit = Number(p.limit);
		if (p.cursor) params.cursor = String(p.cursor);

		const data = await ctx.client.get(
			`/agents/${agentId}/messages`, params, { "X-Rine-Agent": agentId },
		);
		const response = data as PaginatedResponse<MessageRead>;

		const items = [];
		for (const msg of response.items) {
			try {
				if (msg.encryption_version === "hpke-v1" && agentKeysExist(ctx.configDir, agentId)) {
					const result = await decryptMessage(ctx.configDir, agentId, msg.encrypted_payload, ctx.client);
					ingestSenderKeyDistribution(ctx.configDir, agentId, msg.type, result);
					items.push({ ...msg, decrypted: JSON.parse(result.plaintext), verified: result.verified });
				} else if (msg.encryption_version === "sender-key-v1" && agentKeysExist(ctx.configDir, agentId) && msg.group_id) {
					const result = await decryptGroupMessage(ctx.configDir, agentId, msg.group_id, msg.encrypted_payload, ctx.client);
					items.push({ ...msg, decrypted: JSON.parse(result.plaintext), verified: result.verified });
				} else {
					items.push(msg);
				}
			} catch {
				items.push(msg);
			}
		}

		return { ...response, items };
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
	async handler(ctx, p) {
		const msg = (await ctx.client.get(`/messages/${String(p.message_id)}`)) as MessageRead;

		const agentId = msg.to_agent_id ?? msg.from_agent_id;
		if (!agentId || !agentKeysExist(ctx.configDir, agentId)) return msg;

		try {
			if (msg.encryption_version === "hpke-v1") {
				const result = await decryptMessage(ctx.configDir, agentId, msg.encrypted_payload, ctx.client);
				return { ...msg, decrypted: JSON.parse(result.plaintext), verified: result.verified };
			}
			if (msg.encryption_version === "sender-key-v1" && msg.group_id) {
				const result = await decryptGroupMessage(ctx.configDir, agentId, msg.group_id, msg.encrypted_payload, ctx.client);
				return { ...msg, decrypted: JSON.parse(result.plaintext), verified: result.verified };
			}
		} catch {
			// Return raw if decryption fails
		}
		return msg;
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
	async handler(ctx, p) {
		const original = (await ctx.client.get(`/messages/${String(p.message_id)}`)) as MessageRead;

		const agentId = original.to_agent_id;
		if (!agentId) {
			throw new Error("Cannot determine recipient from message");
		}

		if (original.from_agent_id === agentId) {
			throw new Error(
				"Cannot reply to your own message. Send a new message to follow up in this conversation.",
			);
		}

		const recipientId = original.from_agent_id;
		if (!recipientId) {
			throw new Error("Original message has no sender — cannot determine reply recipient.");
		}

		const recipientEncPk = await fetchRecipientEncryptionKey(ctx.client, recipientId);
		const result = await encryptMessage(ctx.configDir, agentId, recipientEncPk, p.payload);

		return ctx.client.post("/messages", {
			to_agent_id: recipientId,
			type: p.type ?? original.type,
			conversation_id: original.conversation_id,
			...result,
		}, { "X-Rine-Agent": agentId });
	},
};

export const messagingTools: ToolDef[] = [rineSend, rineInbox, rineRead, rineReply];
