import type {
	GroupRead,
	MessageRead,
	PaginatedResponse,
} from "@rine-network/core";
import {
	agentKeysExist,
	decryptGroupMessage,
	decryptMessage,
	encryptGroupMessage,
	encryptMessage,
	encryptMlsGroupMessage,
	fetchAgents,
	fetchAndIngestPendingSKDistributions,
	fetchRecipientKeys,
	getOrCreateSenderKey,
	ingestSenderKeyDistribution,
	normalizeHandle,
	processMlsWelcomes,
	resolveAgent,
	resolveToUuid,
	syncMlsGroup,
} from "@rine-network/core";
import type { ToolContext, ToolDef } from "./types.js";

/**
 * MLS group send with one-shot recovery: if local MLS state is missing, install
 * pending welcomes + sync, then retry the encrypt once before surfacing.
 */
async function encryptMlsWithRecovery(
	ctx: ToolContext,
	senderAgentId: string,
	groupId: string,
	payload: unknown,
): Promise<ReturnType<typeof encryptMlsGroupMessage>> {
	const hdrs = { "X-Rine-Agent": senderAgentId };
	// Pre-sync: advance local epoch so we encrypt at the group's current state.
	await processMlsWelcomes(ctx.configDir, senderAgentId, ctx.client).catch(() => {});
	await syncMlsGroup(ctx.configDir, senderAgentId, groupId, ctx.client, hdrs).catch(() => {});

	try {
		return await encryptMlsGroupMessage(
			ctx.configDir,
			senderAgentId,
			groupId,
			payload,
		);
	} catch (err) {
		if (
			err instanceof Error &&
			err.message.startsWith("No MLS state for group")
		) {
			await processMlsWelcomes(ctx.configDir, senderAgentId, ctx.client);
			await syncMlsGroup(ctx.configDir, senderAgentId, groupId, ctx.client, hdrs);
			return await encryptMlsGroupMessage(
				ctx.configDir,
				senderAgentId,
				groupId,
				payload,
			);
		}
		throw err;
	}
}

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
					"Recipient: agent handle (name@org), " +
					"agent UUID, or group handle (#name@org)",
			},
			payload: {
				type: "object",
				description:
					"Message content (any JSON). Will be E2E encrypted before sending",
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
		const agentId = await resolveAgent(
			ctx.apiUrl,
			agents,
			p.from as string | undefined,
		);

		const to = normalizeHandle(String(p.to));
		const isGroup = to.startsWith("#");

		if (isGroup) {
			const extraHeaders: Record<string, string> = { "X-Rine-Agent": agentId };

			// Resolve the target group to decide MLS vs sender-key. A non-null
			// mls_group_id is an opaque "MLS-active" latch — never use its value
			// as a state key; the rine group UUID (group.id) is the only state key.
			const groupList = (await ctx.client.get("/groups", { handle: to })) as {
				items: GroupRead[];
			};
			const group = groupList.items?.[0];
			if (!group) throw new Error(`Group not found: ${to}`);

			let result: Awaited<ReturnType<typeof encryptGroupMessage>>["result"];
			if (group.mls_group_id) {
				result = await encryptMlsWithRecovery(
					ctx,
					agentId,
					group.id,
					p.payload,
				);
			} else {
				const { state, groupId } = await getOrCreateSenderKey(
					ctx.client,
					ctx.configDir,
					agentId,
					to,
					extraHeaders,
				);
				({ result } = await encryptGroupMessage(
					ctx.configDir,
					agentId,
					groupId,
					state,
					p.payload,
				));
			}

			const headers: Record<string, string> = { "X-Rine-Agent": agentId };
			if (p.idempotency_key) {
				headers["Idempotency-Key"] = String(p.idempotency_key);
			}

			return ctx.client.post(
				"/messages",
				{
					to_handle: to,
					type: p.type ?? "rine.v1.dm",
					...result,
				},
				headers,
			);
		}

		const recipientId = await resolveToUuid(ctx.apiUrl, to);
		const recipientKeys = await fetchRecipientKeys(ctx.client, recipientId);
		const result = await encryptMessage(
			ctx.configDir,
			agentId,
			recipientKeys.encryption,
			p.payload,
			recipientKeys.pqEncryption,
		);

		const headers: Record<string, string> = { "X-Rine-Agent": agentId };
		if (p.idempotency_key) {
			headers["Idempotency-Key"] = String(p.idempotency_key);
		}

		return ctx.client.post(
			"/messages",
			{
				to_agent_id: recipientId,
				type: p.type ?? "rine.v1.dm",
				...result,
			},
			headers,
		);
	},
};

const rineInbox: ToolDef = {
	name: "rine_inbox",
	description:
		"List inbox messages, automatically decrypted and signature-verified. " +
		"Each message includes `decrypted` (plaintext payload) and `verified` (signature check) fields. " +
		"Defaults to new (undelivered) messages only.",
	inputSchema: {
		type: "object",
		properties: {
			agent: {
				type: "string",
				description:
					"Agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
			status: {
				type: "string",
				description:
					"Filter by status: new, delivered, read, or all (default: new)",
				default: "new",
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
		const agentId = await resolveAgent(
			ctx.apiUrl,
			agents,
			p.agent as string | undefined,
		);

		const statusParam = (p.status as string) || "new";
		const params: Record<string, string | number | boolean> = {};
		if (statusParam !== "all") params.status = statusParam;
		if (p.limit) params.limit = Number(p.limit);
		if (p.cursor) params.cursor = String(p.cursor);

		const data = await ctx.client.get(`/agents/${agentId}/messages`, params, {
			"X-Rine-Agent": agentId,
		});
		const response = data as PaginatedResponse<MessageRead>;

		const items = [];
		for (const msg of response.items) {
			try {
				if (
					(msg.encryption_version === "hpke-v1" ||
						msg.encryption_version === "hpke-hybrid-v1") &&
					agentKeysExist(ctx.configDir, agentId)
				) {
					const result = await decryptMessage(
						ctx.configDir,
						agentId,
						msg.encrypted_payload,
						ctx.client,
					);
					ingestSenderKeyDistribution(ctx.configDir, agentId, msg.type, result);
					items.push({
						...msg,
						decrypted: JSON.parse(result.plaintext),
						verified: result.verified,
					});
				} else if (
					(msg.encryption_version === "sender-key-v1" ||
						msg.encryption_version === "mls-v1") &&
					agentKeysExist(ctx.configDir, agentId) &&
					msg.group_id
				) {
					const result = await decryptGroupMessage(
						ctx.configDir,
						agentId,
						msg.group_id,
						msg.encrypted_payload,
						ctx.client,
					);
					items.push({
						...msg,
						decrypted: JSON.parse(result.plaintext),
						verified: result.verified,
					});
				} else {
					items.push(msg);
				}
			} catch {
				items.push(msg);
			}
		}

		// Auto-mark new messages as delivered
		if ((statusParam === "new" || statusParam === "all") && items.length > 0) {
			const ids = items.map((m) => m.id);
			try {
				await ctx.client.markDelivered(agentId, ids, {
					"X-Rine-Agent": agentId,
				});
			} catch (e) {
				console.warn("Failed to mark messages as delivered:", e);
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
				description:
					"Agent name, handle, or UUID (only needed for multi-agent orgs)",
			},
		},
		required: ["message_id"],
	},
	async handler(ctx, p) {
		const agents = await fetchAgents(ctx.client);
		const agentId = await resolveAgent(
			ctx.apiUrl,
			agents,
			p.agent as string | undefined,
		);

		const msg = (await ctx.client.get(
			`/messages/${String(p.message_id)}`,
		)) as MessageRead;

		if (!agentKeysExist(ctx.configDir, agentId)) return msg;

		try {
			if (
				msg.encryption_version === "hpke-v1" ||
				msg.encryption_version === "hpke-hybrid-v1"
			) {
				const result = await decryptMessage(
					ctx.configDir,
					agentId,
					msg.encrypted_payload,
					ctx.client,
				);
				return {
					...msg,
					decrypted: JSON.parse(result.plaintext),
					verified: result.verified,
				};
			}
			if (
				(msg.encryption_version === "sender-key-v1" ||
					msg.encryption_version === "mls-v1") &&
				msg.group_id
			) {
				try {
					const result = await decryptGroupMessage(
						ctx.configDir,
						agentId,
						msg.group_id,
						msg.encrypted_payload,
						ctx.client,
					);
					return {
						...msg,
						decrypted: JSON.parse(result.plaintext),
						verified: result.verified,
					};
				} catch (err) {
					const match =
						err instanceof Error &&
						err.message.match(/^unknown sender key id: (.+)$/);
					if (match) {
						const ingested = await fetchAndIngestPendingSKDistributions(
							ctx.client,
							ctx.configDir,
							agentId,
							match[1],
						);
						if (ingested > 0) {
							try {
								const result = await decryptGroupMessage(
									ctx.configDir,
									agentId,
									msg.group_id,
									msg.encrypted_payload,
									ctx.client,
								);
								return {
									...msg,
									decrypted: JSON.parse(result.plaintext),
									verified: result.verified,
								};
							} catch {
								/* retry exhausted */
							}
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
				description:
					"Override message type (defaults to original message's type)",
			},
		},
		required: ["message_id", "payload"],
	},
	async handler(ctx, p) {
		const messageId = String(p.message_id);
		const original = (await ctx.client.get(
			`/messages/${messageId}`,
		)) as MessageRead;

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
			throw new Error(
				"Original message has no sender — cannot determine reply recipient.",
			);
		}

		const recipientKeys = await fetchRecipientKeys(ctx.client, recipientId);
		const result = await encryptMessage(
			ctx.configDir,
			agentId,
			recipientKeys.encryption,
			p.payload,
			recipientKeys.pqEncryption,
		);

		return ctx.client.post(
			`/messages/${messageId}/reply`,
			{
				type: p.type ?? original.type,
				...result,
			},
			{ "X-Rine-Agent": agentId },
		);
	},
};

export const messagingTools: ToolDef[] = [
	rineSend,
	rineInbox,
	rineRead,
	rineReply,
];
