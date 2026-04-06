import type { MessageRead, PaginatedResponse } from "@rine-network/core";
import {
	agentKeysExist,
	decryptGroupMessage,
	decryptMessage,
	encryptGroupMessage,
	encryptMessage,
	fetchAgents,
	fetchAndIngestPendingSKDistributions,
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
		"Send an E2E-encrypted message to an agent or group. " +
		"Payload is encrypted client-side before transmission (HPKE for 1:1, Sender Keys for groups). " +
		"The server never sees plaintext.",
	inputSchema: {
		type: "object",
		properties: {
			to: {
				type: "string",
				description:
					"Recipient: agent handle (name@org.rine.network), " +
					"agent UUID, or group handle (#name@org.rine.network)",
			},
			payload: {
				type: "object",
				description: "Message content (any JSON). Will be E2E encrypted before sending",
			},
			type: {
				type: "string",
				description:
					"Message type namespace (default: rine.v1.dm). " +
					"Common: rine.v1.task_request, rine.v1.task_response",
			},
			from: {
				type: "string",
				description:
					"Sender agent (name, handle, or UUID). " +
					"Only needed if your org has multiple agents",
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
		const agentId = await resolveAgent(ctx.apiUrl, agents, p.from as string | undefined);

		const to = String(p.to);
		const isGroup = to.startsWith("#");

		if (isGroup) {
			const extraHeaders: Record<string, string> = { "X-Rine-Agent": agentId };

			const { state, groupId } = await getOrCreateSenderKey(
				ctx.client, ctx.configDir, agentId, to, extraHeaders,
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
		"List inbox messages, automatically decrypted and signature-verified. " +
		"Each message includes `decrypted` (plaintext payload) and `verified` (signature check) fields.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description: "Agent name, handle, or UUID (only needed for multi-agent orgs)",
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
		"Read and decrypt a single message by ID. " +
		"Returns full message with `decrypted` payload and `verified` signature status.",
	inputSchema: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description: "Message UUID to read",
			},
			agent: {
				type: "string",
				description: "Agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
		},
		required: ["message_id"],
	},
	async handler(ctx, p) {
		const agents = await fetchAgents(ctx.client);
		const agentId = await resolveAgent(ctx.apiUrl, agents, p.agent as string | undefined);

		const msg = (await ctx.client.get(`/messages/${String(p.message_id)}`)) as MessageRead;

		if (!agentKeysExist(ctx.configDir, agentId)) return msg;

		try {
			if (msg.encryption_version === "hpke-v1") {
				const result = await decryptMessage(ctx.configDir, agentId, msg.encrypted_payload, ctx.client);
				return { ...msg, decrypted: JSON.parse(result.plaintext), verified: result.verified };
			}
			if (msg.encryption_version === "sender-key-v1" && msg.group_id) {
				try {
					const result = await decryptGroupMessage(ctx.configDir, agentId, msg.group_id, msg.encrypted_payload, ctx.client);
					return { ...msg, decrypted: JSON.parse(result.plaintext), verified: result.verified };
				} catch (err) {
					const match = err instanceof Error && err.message.match(/^unknown sender key id: (.+)$/);
					if (match) {
						const ingested = await fetchAndIngestPendingSKDistributions(ctx.client, ctx.configDir, agentId, match[1]);
						if (ingested > 0) {
							try {
								const result = await decryptGroupMessage(ctx.configDir, agentId, msg.group_id, msg.encrypted_payload, ctx.client);
								return { ...msg, decrypted: JSON.parse(result.plaintext), verified: result.verified };
							} catch { /* retry exhausted */ }
						}
					}
				}
			}
		} catch {
			// Return raw if HPKE decryption fails
		}
		return msg;
	},
};

const rineReply: ToolDef = {
	name: "rine_reply",
	description:
		"Reply to a message within its conversation. " +
		"Auto-routes to the original sender with E2E encryption. " +
		"Preserves conversation_id for threading.",
	inputSchema: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description: "UUID of the message to reply to",
			},
			payload: {
				type: "object",
				description: "Reply content (any JSON). Will be E2E encrypted",
			},
			type: {
				type: "string",
				description: "Override message type (defaults to original message's type)",
			},
		},
		required: ["message_id", "payload"],
	},
	async handler(ctx, p) {
		const messageId = String(p.message_id);
		const original = (await ctx.client.get(`/messages/${messageId}`)) as MessageRead;

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

		return ctx.client.post(`/messages/${messageId}/reply`, {
			type: p.type ?? original.type,
			...result,
		}, { "X-Rine-Agent": agentId });
	},
};

export const messagingTools: ToolDef[] = [rineSend, rineInbox, rineRead, rineReply];
