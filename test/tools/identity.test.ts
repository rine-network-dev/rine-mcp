import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockAgentKeysExist = vi.fn();
const mockLoadCredentials = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		agentKeysExist: (...args: unknown[]) => mockAgentKeysExist(...args),
		loadCredentials: (...args: unknown[]) => mockLoadCredentials(...args),
	};
});

const { identityTools } = await import("../../src/tools/identity.js");

const rineWhoami = identityTools.find(t => t.name === "rine_whoami")!;
const rinePoll = identityTools.find(t => t.name === "rine_poll")!;

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: "/tmp/test",
		apiUrl: "https://api.test",
	};
}

describe("rine_whoami", () => {
	beforeEach(() => mockAgentKeysExist.mockReset());

	it("returns org and agents with has_keys flag", async () => {
		const ctx = makeCtx();
		const org = { id: "org-1", name: "Acme", slug: "acme", trust_tier: 1 };
		const agents = {
			items: [
				{ id: "a1", name: "bot", handle: "bot@acme.rine.network" },
				{ id: "a2", name: "helper", handle: "helper@acme.rine.network" },
			],
			total: 2,
		};
		(ctx.client.get as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(org)
			.mockResolvedValueOnce(agents);
		mockAgentKeysExist.mockImplementation((_dir: string, id: string) => id === "a1");

		const result = await rineWhoami.handler(ctx, {}) as { org: unknown; agents: Array<{ has_keys: boolean }> };
		expect(result.org).toEqual(org);
		expect(result.agents).toHaveLength(2);
		expect(result.agents[0]!.has_keys).toBe(true);
		expect(result.agents[1]!.has_keys).toBe(false);
	});
});

describe("rine_poll", () => {
	beforeEach(() => {
		mockLoadCredentials.mockReset();
		vi.restoreAllMocks();
	});

	it("returns count from poll URL", async () => {
		const ctx = makeCtx();
		mockLoadCredentials.mockReturnValue({
			default: { client_id: "x", client_secret: "y", poll_url: "https://api.test/poll/token" },
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ count: 3 }),
		}));

		const result = await rinePoll.handler(ctx, {}) as { count: number };
		expect(result.count).toBe(3);
		expect(fetch).toHaveBeenCalledWith("https://api.test/poll/token", expect.anything());
	});

	it("throws when no poll token configured", async () => {
		const ctx = makeCtx();
		mockLoadCredentials.mockReturnValue({ default: { client_id: "x", client_secret: "y" } });
		await expect(rinePoll.handler(ctx, {})).rejects.toThrow("No poll token found");
	});

	it("throws on non-ok response", async () => {
		const ctx = makeCtx();
		mockLoadCredentials.mockReturnValue({
			default: { client_id: "x", client_secret: "y", poll_url: "https://api.test/poll/token" },
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
		}));

		await expect(rinePoll.handler(ctx, {})).rejects.toThrow("Poll failed: 401");
	});
});
