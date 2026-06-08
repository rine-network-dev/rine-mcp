import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveToUuid = vi.fn();
const mockFetchAgents = vi.fn();
const mockResolveAgent = vi.fn();
const mockProcessMlsWelcomes = vi.fn();
const mockLoadMlsState = vi.fn();
const mockExternalJoinMlsGroup = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveToUuid: (...args: unknown[]) => mockResolveToUuid(...args),
		fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
		resolveAgent: (...args: unknown[]) => mockResolveAgent(...args),
		processMlsWelcomes: (...args: unknown[]) => mockProcessMlsWelcomes(...args),
		loadMlsState: (...args: unknown[]) => mockLoadMlsState(...args),
		externalJoinMlsGroup: (...args: unknown[]) =>
			mockExternalJoinMlsGroup(...args),
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
	beforeEach(() => {
		mockFetchAgents.mockReset();
		mockResolveAgent.mockReset();
	});

	it("posts group with name only, deriving visibility=private from server default enrollment=closed", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
		await rineGroupCreate.handler(ctx, { name: "my-group" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups", {
			name: "my-group",
			visibility: "private",
		}, {});
	});

	it("derives visibility=public when enrollment is open", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
		await rineGroupCreate.handler(ctx, { name: "open-group", enrollment: "open" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups", {
			name: "open-group",
			enrollment_policy: "open",
			visibility: "public",
		}, {});
	});

	it("uses provided enrollment and visibility", async () => {
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
		}, {});
	});

	it("resolves agent and sets X-Rine-Agent header when as is provided", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([]);
		mockResolveAgent.mockResolvedValue("agent-123");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
		await rineGroupCreate.handler(ctx, { name: "my-group", as: "mybot" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups", {
			name: "my-group",
			visibility: "private",
		}, { "X-Rine-Agent": "agent-123" });
	});
});

describe("rine_group_join", () => {
	beforeEach(() => {
		mockFetchAgents.mockReset();
		mockResolveAgent.mockReset();
		mockProcessMlsWelcomes.mockReset().mockResolvedValue(undefined);
		mockLoadMlsState.mockReset().mockReturnValue(null);
		mockExternalJoinMlsGroup.mockReset().mockResolvedValue({ epoch: 2 });
	});

	it("posts to correct group join path", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
		await rineGroupJoin.handler(ctx, { group_id: "g1" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups/g1/join", {}, {});
	});

	it("includes message when provided", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
		await rineGroupJoin.handler(ctx, { group_id: "g1", message: "hello" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups/g1/join", { message: "hello" }, {});
	});

	it("resolves agent and sets X-Rine-Agent header when as is provided", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([]);
		mockResolveAgent.mockResolvedValue("agent-456");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
		await rineGroupJoin.handler(ctx, { group_id: "g1", as: "mybot" });
		expect(ctx.client.post).toHaveBeenCalledWith("/groups/g1/join", {}, {
			"X-Rine-Agent": "agent-456",
		});
	});

	it("external-self-joins when MLS-active and the Welcome path installed no state", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([]);
		mockResolveAgent.mockResolvedValue("agent-self");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});
		// MLS-active group; loadMlsState default returns null (no Welcome state).
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "g1",
			mls_group_id: "mls-latch",
		});

		await rineGroupJoin.handler(ctx, { group_id: "g1" });

		expect(mockProcessMlsWelcomes).toHaveBeenCalledWith(
			"/tmp/test",
			"agent-self",
			ctx.client,
		);
		expect(mockExternalJoinMlsGroup).toHaveBeenCalledWith(
			"/tmp/test",
			"agent-self",
			"g1",
			ctx.client,
			{ "X-Rine-Agent": "agent-self" },
		);
	});

	it("does NOT external-self-join when a Welcome already installed MLS state", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([]);
		mockResolveAgent.mockResolvedValue("agent-self");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "g1",
			mls_group_id: "mls-latch",
		});
		mockLoadMlsState.mockReturnValue({ stateBlob: new Uint8Array(), metadata: {} });

		await rineGroupJoin.handler(ctx, { group_id: "g1" });

		expect(mockExternalJoinMlsGroup).not.toHaveBeenCalled();
	});

	it("does NOT external-self-join for a non-MLS (sender-key) group", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([]);
		mockResolveAgent.mockResolvedValue("agent-self");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });

		await rineGroupJoin.handler(ctx, { group_id: "g1" });

		expect(mockLoadMlsState).not.toHaveBeenCalled();
		expect(mockExternalJoinMlsGroup).not.toHaveBeenCalled();
	});

	it("swallows external-self-join errors (best-effort) and still returns the join result", async () => {
		const ctx = makeCtx();
		mockFetchAgents.mockResolvedValue([]);
		mockResolveAgent.mockResolvedValue("agent-self");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ joined: true });
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "g1",
			mls_group_id: "mls-latch",
		});
		mockExternalJoinMlsGroup.mockRejectedValue(new Error("epoch conflict"));

		const result = await rineGroupJoin.handler(ctx, { group_id: "g1" });

		expect(result).toEqual({ joined: true });
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
	beforeEach(() => {
		mockResolveToUuid.mockReset();
		mockFetchAgents.mockReset();
		mockResolveAgent.mockReset();
	});

	it("resolves agent handle then posts invite", async () => {
		const ctx = makeCtx();
		mockResolveToUuid.mockResolvedValue("agent-uuid");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});

		await rineGroupInvite.handler(ctx, { group_id: "g1", agent: "bot@org.rine.network" });
		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", "bot@org.rine.network");
		expect(ctx.client.post).toHaveBeenCalledWith(
			"/groups/g1/invite",
			{ agent_id: "agent-uuid" },
			{},
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
			{},
		);
	});

	it("resolves acting agent and sets X-Rine-Agent header when as is provided", async () => {
		const ctx = makeCtx();
		mockResolveToUuid.mockResolvedValue("target-uuid");
		mockFetchAgents.mockResolvedValue([]);
		mockResolveAgent.mockResolvedValue("actor-789");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue({});

		await rineGroupInvite.handler(ctx, {
			group_id: "g1",
			agent: "target@org.rine.network",
			as: "mybot",
		});
		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", "target@org.rine.network");
		expect(ctx.client.post).toHaveBeenCalledWith(
			"/groups/g1/invite",
			{ agent_id: "target-uuid" },
			{ "X-Rine-Agent": "actor-789" },
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
