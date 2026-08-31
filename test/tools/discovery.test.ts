import { handleCompletionNotes } from "@rine-network/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

// Mock resolveToUuid and HttpClient.publicGet
const mockResolveToUuid = vi.fn();
const mockPublicGet = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveToUuid: (...args: unknown[]) => mockResolveToUuid(...args),
		HttpClient: {
			...orig.HttpClient,
			publicGet: (...args: unknown[]) => mockPublicGet(...args),
		},
	};
});

const { discoveryTools } = await import("../../src/tools/discovery.js");

const rineDiscover = discoveryTools.find(t => t.name === "rine_discover")!;
const rineInspect = discoveryTools.find(t => t.name === "rine_inspect")!;
const rineDiscoverGroups = discoveryTools.find(t => t.name === "rine_discover_groups")!;

const ctx: ToolContext = {
	client: { get: vi.fn(), post: vi.fn() } as never,
	configDir: "/tmp/test",
	apiUrl: "https://api.test",
};

describe("rine_discover", () => {
	beforeEach(() => mockPublicGet.mockReset());

	it("calls publicGet with search params", async () => {
		mockPublicGet.mockResolvedValue({ items: [] });
		await rineDiscover.handler(ctx, { query: "translator", language: "de", limit: 5 });
		expect(mockPublicGet).toHaveBeenCalledWith(
			"https://api.test",
			"/directory/agents",
			expect.any(URLSearchParams),
		);
		const params = mockPublicGet.mock.calls[0]![2] as URLSearchParams;
		expect(params.get("q")).toBe("translator");
		expect(params.get("language")).toBe("de");
		expect(params.get("limit")).toBe("5");
	});

	it("omits unset params", async () => {
		mockPublicGet.mockResolvedValue({ items: [] });
		await rineDiscover.handler(ctx, {});
		const params = mockPublicGet.mock.calls[0]![2] as URLSearchParams;
		expect(params.toString()).toBe("");
	});

	it("sets verified=true when flag is true", async () => {
		mockPublicGet.mockResolvedValue({ items: [] });
		await rineDiscover.handler(ctx, { verified: true });
		const params = mockPublicGet.mock.calls[0]![2] as URLSearchParams;
		expect(params.get("verified")).toBe("true");
	});

	it("does not set verified when flag is false", async () => {
		mockPublicGet.mockResolvedValue({ items: [] });
		await rineDiscover.handler(ctx, { verified: false });
		const params = mockPublicGet.mock.calls[0]![2] as URLSearchParams;
		expect(params.has("verified")).toBe(false);
	});
});

describe("rine_inspect", () => {
	beforeEach(() => {
		mockPublicGet.mockReset();
		mockResolveToUuid.mockReset();
	});

	it("resolves handle then fetches agent profile", async () => {
		const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		mockResolveToUuid.mockResolvedValue(uuid);
		mockPublicGet.mockResolvedValue({ id: uuid, name: "bot" });

		const result = await rineInspect.handler(ctx, { agent: "bot@org.rine.network" });
		expect(mockResolveToUuid).toHaveBeenCalledWith("https://api.test", "bot@org.rine.network");
		expect(mockPublicGet).toHaveBeenCalledWith(
			"https://api.test",
			`/directory/agents/${uuid}`,
		);
		expect(result).toEqual({ id: uuid, name: "bot" });
	});

	// The profile card is the one place a caller could catch the
	// substitution unaided — and only by already knowing to compare the card's
	// handle against what they typed. The notice says it outright.
	//
	// 🔴 The mocked `resolveToUuid` answers the same UUID for both spellings on
	// purpose: what the notice reports is the SPELLING the caller typed, and it
	// must not be derivable from the lookup's answer. The sentence is derived
	// from `@rine-network/core`, never retyped.
	it("reports a completed handle beside the profile it actually fetched", async () => {
		const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		mockResolveToUuid.mockResolvedValue(uuid);
		mockPublicGet.mockResolvedValue({ id: uuid, handle: "bot@org.rine.network" });

		const result = await rineInspect.handler(ctx, { agent: "bot@org" });

		expect(result).toEqual({
			id: uuid,
			handle: "bot@org.rine.network",
			handle_completion: handleCompletionNotes(["bot@org"]),
		});
	});

	it("says nothing when the spelling was already whole", async () => {
		const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		mockResolveToUuid.mockResolvedValue(uuid);
		mockPublicGet.mockResolvedValue({ id: uuid, name: "bot" });

		const result = await rineInspect.handler(ctx, {
			agent: "bot@org.rine.network",
		});

		expect(result).not.toHaveProperty("handle_completion");
	});
});

describe("rine_discover_groups", () => {
	beforeEach(() => mockPublicGet.mockReset());

	it("calls publicGet on /directory/groups", async () => {
		mockPublicGet.mockResolvedValue({ items: [] });
		await rineDiscoverGroups.handler(ctx, { query: "finance" });
		expect(mockPublicGet).toHaveBeenCalledWith(
			"https://api.test",
			"/directory/groups",
			expect.any(URLSearchParams),
		);
		const params = mockPublicGet.mock.calls[0]![2] as URLSearchParams;
		expect(params.get("q")).toBe("finance");
	});

	it("names the verb that acts on a row it found", () => {
		// This is the one tool on this surface that returns groups the calling
		// org holds no seat in, and the route it reads carries no identity — so
		// a row here can never say whether the agent is in the group, and the
		// description is the only place the next step can be stated. The
		// assertion is the verb, not the wording around it.
		expect(rineDiscoverGroups.description).toContain("rine_group_join");
		expect(rineDiscoverGroups.description).toContain("not a group your agent is in");
	});
});
