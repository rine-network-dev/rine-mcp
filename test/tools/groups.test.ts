import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveToUuid = vi.fn();
const mockFetchAgents = vi.fn();
const mockResolveAgent = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveToUuid: (...args: unknown[]) => mockResolveToUuid(...args),
		fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
		resolveAgent: (...args: unknown[]) => mockResolveAgent(...args),
	};
});

const { groupTools } = await import("../../src/tools/groups.js");

const rineGroupCreate = groupTools.find(t => t.name === "rine_group_create")!;
const rineGroupJoin = groupTools.find(t => t.name === "rine_group_join")!;
const rineGroupMembers = groupTools.find(t => t.name === "rine_group_members")!;
const rineGroupInvite = groupTools.find(t => t.name === "rine_group_invite")!;
const rineGroups = groupTools.find(t => t.name === "rine_groups")!;

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: "/tmp/test",
		apiUrl: "https://api.test",
	};
}

describe("rine_group_create", () => {
	it("posts group with name only", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
		await rineGroupCreate.handler(ctx, { name: "my-group" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups", { name: "my-group" });
	});

	it("includes enrollment and visibility when set", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
		await rineGroupCreate.handler(ctx, {
			name: "private-group",
			enrollment: "closed",
			visibility: "private",
		});
		expect(ctx.client.post).toHaveBeenCalledWith("/groups", {
			name: "private-group",
			enrollment_policy: "closed",
			visibility: "private",
		});
	});
});

describe("rine_group_join", () => {
	it("posts to correct group join path", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});
		await rineGroupJoin.handler(ctx, { group_id: "g1" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups/g1/join", {});
	});

	it("includes message when provided", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});
		await rineGroupJoin.handler(ctx, { group_id: "g1", message: "hello" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups/g1/join", { message: "hello" });
	});
});

describe("rine_group_members", () => {
	it("fetches members for group", async () => {
		const ctx = makeCtx();
		const members = [{ agent_id: "a1", role: "admin" }];
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ items: members });
		const result = await rineGroupMembers.handler(ctx, { group_id: "g1" });
		expect(ctx.client.get).toHaveBeenCalledWith("/groups/g1/members");
		expect(result).toEqual({ items: members });
	});
});

describe("rine_group_invite", () => {
	beforeEach(() => mockResolveToUuid.mockReset());

	it("resolves agent handle then posts invite", async () => {
		const ctx = makeCtx();
		mockResolveToUuid.mockResolvedValue("agent-uuid");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});

		await rineGroupInvite.handler(ctx, { group_id: "g1", agent: "bot@org.rine.network" });
		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", "bot@org.rine.network");
		expect(ctx.client.post).toHaveBeenCalledWith(
			"/groups/g1/invite",
			{ agent_id: "agent-uuid" },
		);
	});

	it("includes message in invite", async () => {
		const ctx = makeCtx();
		mockResolveToUuid.mockResolvedValue("agent-uuid");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});

		await rineGroupInvite.handler(ctx, {
			group_id: "g1",
			agent: "agent-uuid",
			message: "join us",
		});
		expect(ctx.client.post).toHaveBeenCalledWith(
			"/groups/g1/invite",
			{ agent_id: "agent-uuid", message: "join us" },
		);
	});
});

describe("rine_groups", () => {
	beforeEach(() => {
		mockFetchAgents.mockReset();
		mockResolveAgent.mockReset();
	});

	it("lists groups without agent header when no agent specified", async () => {
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
		await rineGroups.handler(ctx, {});
		expect(ctx.client.get).toHaveBeenCalledWith("/groups", undefined, {});
	});

	it("resolves agent and sets X-Rine-Agent header", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([]);
		mockResolveAgent.mockResolvedValue("resolved-id");
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });

		await rineGroups.handler(ctx, { agent: "mybot" });
		expect(ctx.client.get).toHaveBeenCalledWith(
			"/groups", undefined, { "X-Rine-Agent": "resolved-id" },
		);
	});
});
