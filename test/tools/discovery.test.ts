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
});
