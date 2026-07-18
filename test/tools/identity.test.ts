import { SpiffeVerificationError } from "@rine-network/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockAgentKeysExist = vi.fn();
const mockLoadCredentials = vi.fn();
const mockWalletKeyExists = vi.fn();
const mockGetWalletAddress = vi.fn();
const mockLoadPolicy = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		agentKeysExist: (...args: unknown[]) => mockAgentKeysExist(...args),
		loadCredentials: (...args: unknown[]) => mockLoadCredentials(...args),
		walletKeyExists: (...args: unknown[]) => mockWalletKeyExists(...args),
		getWalletAddress: (...args: unknown[]) => mockGetWalletAddress(...args),
		loadPolicy: (...args: unknown[]) => mockLoadPolicy(...args),
	};
});

const { identityTools } = await import("../../src/tools/identity.js");

const rineWhoami = identityTools.find((t) => t.name === "rine_whoami")!;
const rinePoll = identityTools.find((t) => t.name === "rine_poll")!;
const rineVerifyIdentity = identityTools.find(
	(t) => t.name === "rine_verify_identity",
)!;

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: "/tmp/test",
		apiUrl: "https://api.test",
	};
}

describe("rine_whoami", () => {
	beforeEach(() => {
		mockAgentKeysExist.mockReset();
		mockWalletKeyExists.mockReset().mockReturnValue(false);
		mockGetWalletAddress.mockReset();
		mockLoadPolicy.mockReset().mockReturnValue(null);
	});

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
		mockAgentKeysExist.mockImplementation(
			(_dir: string, id: string) => id === "a1",
		);

		const result = (await rineWhoami.handler(ctx, {})) as {
			org: unknown;
			agents: Array<{ has_keys: boolean }>;
		};
		expect(result.org).toEqual(org);
		expect(result.agents).toHaveLength(2);
		expect(result.agents[0]!.has_keys).toBe(true);
		expect(result.agents[1]!.has_keys).toBe(false);
	});

	it("surfaces the wallet address + policy-present flag, never key material", async () => {
		const ctx = makeCtx();
		const org = { id: "org-1", name: "Acme", slug: "acme", trust_tier: 2 };
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
		mockAgentKeysExist.mockReturnValue(true);
		// a1 has a wallet + policy; a2 has neither.
		mockWalletKeyExists.mockImplementation(
			(_dir: string, id: string) => id === "a1",
		);
		mockGetWalletAddress.mockReturnValue(
			"0xAbC0000000000000000000000000000000000001",
		);
		mockLoadPolicy.mockImplementation((_dir: string, id: string) =>
			id === "a1" ? { perTxCap: "1.00" } : null,
		);

		const result = (await rineWhoami.handler(ctx, {})) as {
			agents: Array<{
				wallet_address: string | null;
				has_payment_policy: boolean;
			}>;
		};

		expect(result.agents[0]!.wallet_address).toBe(
			"0xAbC0000000000000000000000000000000000001",
		);
		expect(result.agents[0]!.has_payment_policy).toBe(true);
		expect(result.agents[1]!.wallet_address).toBeNull();
		expect(result.agents[1]!.has_payment_policy).toBe(false);
		// The private key is never derived/returned; only the public address.
		expect(JSON.stringify(result).toLowerCase()).not.toContain("private");
		expect(mockGetWalletAddress).toHaveBeenCalledTimes(1); // only for the wallet agent
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
			default: {
				client_id: "x",
				client_secret: "y",
				poll_url: "https://api.test/poll/token",
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ count: 3 }),
			}),
		);

		const result = (await rinePoll.handler(ctx, {})) as { count: number };
		expect(result.count).toBe(3);
		expect(fetch).toHaveBeenCalledWith(
			"https://api.test/poll/token",
			expect.anything(),
		);
	});

	it("throws when no poll token configured", async () => {
		const ctx = makeCtx();
		mockLoadCredentials.mockReturnValue({
			default: { client_id: "x", client_secret: "y" },
		});
		await expect(rinePoll.handler(ctx, {})).rejects.toThrow(
			"No poll token found",
		);
	});

	it("throws on non-ok response", async () => {
		const ctx = makeCtx();
		mockLoadCredentials.mockReturnValue({
			default: {
				client_id: "x",
				client_secret: "y",
				poll_url: "https://api.test/poll/token",
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
			}),
		);

		await expect(rinePoll.handler(ctx, {})).rejects.toThrow("Poll failed: 401");
	});
});

describe("rine_verify_identity", () => {
	beforeEach(() => {
		// Falsy value → hasSpiffeEndpoint() is false, exercising the no-endpoint path.
		vi.stubEnv("SPIFFE_ENDPOINT_SOCKET", "");
	});

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it("posts a challenge then verify with the supplied svid and returns the result", async () => {
		const ctx = makeCtx();
		const verified = {
			agent_id: "a1",
			spiffe_id: "spiffe://acme.example/workload",
			trust_domain: "acme.example",
			trust_tier: 2,
			verified_at: "2026-07-10T00:00:00Z",
		};
		(ctx.client.post as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				audience: "spiffe://challenge.rine.network/tok",
				expires_in: 300,
			})
			.mockResolvedValueOnce(verified);

		const result = await rineVerifyIdentity.handler(ctx, {
			agent_id: "a1",
			svid: "jwt.svid.here",
		});

		expect(result).toEqual(verified);
		const post = ctx.client.post as ReturnType<typeof vi.fn>;
		expect(post).toHaveBeenNthCalledWith(1, "/agents/a1/verify-svid/challenge");
		expect(post).toHaveBeenNthCalledWith(2, "/agents/a1/verify-svid", {
			svid: "jwt.svid.here",
		});
	});

	it("throws (never a silent no-op) when no svid and no SPIFFE endpoint", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			audience: "spiffe://challenge.rine.network/tok",
			expires_in: 300,
		});

		await expect(
			rineVerifyIdentity.handler(ctx, { agent_id: "a1" }),
		).rejects.toThrow(SpiffeVerificationError);
		expect(ctx.client.post).toHaveBeenCalledTimes(1);
	});
});
