import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockGetCredentialEntry = vi.fn();
const mockValidateSlug = vi.fn();
const mockPerformRegistration = vi.fn();
const mockPerformAgentCreation = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		getCredentialEntry: (...args: unknown[]) => mockGetCredentialEntry(...args),
		validateSlug: (...args: unknown[]) => mockValidateSlug(...args),
		performRegistration: (...args: unknown[]) => mockPerformRegistration(...args),
		performAgentCreation: (...args: unknown[]) => mockPerformAgentCreation(...args),
	};
});

const { onboardingTools } = await import("../../src/tools/onboarding.js");

const rineOnboard = onboardingTools.find((t) => t.name === "rine_onboard")!;
const rineAgentCreate = onboardingTools.find((t) => t.name === "rine_agent_create")!;

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn() } as never,
		configDir: "/tmp/test",
		apiUrl: "https://api.test",
	};
}

const validParams = { email: "a@b.com", org_name: "Acme", org_slug: "acme", agent_name: "bot" };

function resetAllMocks(): void {
	mockGetCredentialEntry.mockReset();
	mockValidateSlug.mockReset();
	mockPerformRegistration.mockReset();
	mockPerformAgentCreation.mockReset();
}

describe("rine_onboard", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		resetAllMocks();
	});

	it("returns already_registered when credentials exist", async () => {
		const ctx = makeCtx();
		mockGetCredentialEntry.mockReturnValue({ client_id: "id", client_secret: "secret" });
		mockValidateSlug.mockReturnValue(true);
		const org = { id: "org-1", name: "Acme", slug: "acme" };
		const agents = { items: [{ id: "a1", name: "bot" }], total: 1 };
		(ctx.client.get as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(org)
			.mockResolvedValueOnce(agents);

		const result = (await rineOnboard.handler(ctx, validParams)) as {
			status: string; config_dir: string; org: unknown;
		};

		expect(result.status).toBe("already_registered");
		expect(result.config_dir).toBe("/tmp/test");
		expect(result.org).toEqual(org);
		expect(mockPerformRegistration).not.toHaveBeenCalled();
	});

	it("rejects invalid slug before network call", async () => {
		const ctx = makeCtx();
		mockGetCredentialEntry.mockReturnValue(undefined);
		mockValidateSlug.mockReturnValue(false);

		await expect(rineOnboard.handler(ctx, {
			...validParams, org_slug: "Bad Slug!",
		})).rejects.toThrow("org_slug must be");

		expect(mockPerformRegistration).not.toHaveBeenCalled();
	});

	it("completes full registration flow", async () => {
		const ctx = makeCtx();
		mockGetCredentialEntry.mockReturnValue(undefined);
		mockValidateSlug.mockReturnValue(true);
		mockPerformRegistration.mockResolvedValue({ org_id: "org-1", client_id: "cid" });
		mockPerformAgentCreation.mockResolvedValue({
			id: "00000000-0000-0000-0000-000000000001",
			name: "bot",
			handle: "bot@acme.rine.network",
			verification_words: "alpha bravo",
			poll_url: "https://api.test/poll/tok",
		});

		const result = (await rineOnboard.handler(ctx, validParams)) as {
			status: string; agent: { handle: string }; poll_url: string;
		};

		expect(result.status).toBe("registered");
		expect(result.agent.handle).toBe("bot@acme.rine.network");
		expect(result.poll_url).toBe("https://api.test/poll/tok");

		// Core functions called with correct params
		expect(mockPerformRegistration).toHaveBeenCalledWith(
			"https://api.test", "/tmp/test", "default",
			{ email: "a@b.com", slug: "acme", name: "Acme" },
		);
		expect(mockPerformAgentCreation).toHaveBeenCalledWith(
			ctx.client, "/tmp/test", "default",
			{ name: "bot" },
		);
	});

	it("propagates registration errors", async () => {
		const ctx = makeCtx();
		mockGetCredentialEntry.mockReturnValue(undefined);
		mockValidateSlug.mockReturnValue(true);
		mockPerformRegistration.mockRejectedValue(new Error("Email or slug already registered"));

		await expect(rineOnboard.handler(ctx, validParams))
			.rejects.toThrow("Email or slug already registered");
	});

	it("propagates rate limit errors", async () => {
		const ctx = makeCtx();
		mockGetCredentialEntry.mockReturnValue(undefined);
		mockValidateSlug.mockReturnValue(true);
		mockPerformRegistration.mockRejectedValue(new Error("Rate limited — please wait"));

		await expect(rineOnboard.handler(ctx, validParams))
			.rejects.toThrow("Rate limited");
	});

	it("propagates challenge expired errors", async () => {
		const ctx = makeCtx();
		mockGetCredentialEntry.mockReturnValue(undefined);
		mockValidateSlug.mockReturnValue(true);
		mockPerformRegistration.mockRejectedValue(new Error("Challenge expired — please try again"));

		await expect(rineOnboard.handler(ctx, validParams))
			.rejects.toThrow("Challenge expired");
	});

	it("propagates unsupported algorithm errors", async () => {
		const ctx = makeCtx();
		mockGetCredentialEntry.mockReturnValue(undefined);
		mockValidateSlug.mockReturnValue(true);
		mockPerformRegistration.mockRejectedValue(
			new Error("Unsupported algorithm: unknown-v2. Please upgrade."),
		);

		await expect(rineOnboard.handler(ctx, validParams))
			.rejects.toThrow("Unsupported algorithm: unknown-v2");
	});
});

describe("rine_agent_create", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		resetAllMocks();
	});

	it("creates agent with poll_url", async () => {
		const ctx = makeCtx();
		mockPerformAgentCreation.mockResolvedValue({
			id: "00000000-0000-0000-0000-000000000002",
			name: "helper",
			handle: "helper@acme.rine.network",
			verification_words: "charlie delta",
			poll_url: "https://api.test/poll/tok2",
		});

		const result = (await rineAgentCreate.handler(ctx, { name: "helper" })) as {
			id: string; handle: string; poll_url: string;
		};

		expect(result.id).toBe("00000000-0000-0000-0000-000000000002");
		expect(result.handle).toBe("helper@acme.rine.network");
		expect(result.poll_url).toBe("https://api.test/poll/tok2");
		expect(mockPerformAgentCreation).toHaveBeenCalledWith(
			ctx.client, "/tmp/test", "default",
			{ name: "helper", humanOversight: undefined, unlisted: undefined },
		);
	});

	it("returns undefined poll_url when not returned", async () => {
		const ctx = makeCtx();
		mockPerformAgentCreation.mockResolvedValue({
			id: "00000000-0000-0000-0000-000000000003",
			name: "basic",
			handle: "basic@acme.rine.network",
		});

		const result = (await rineAgentCreate.handler(ctx, { name: "basic" })) as { poll_url: unknown };
		expect(result.poll_url).toBeUndefined();
	});

	it("passes optional human_oversight and unlisted", async () => {
		const ctx = makeCtx();
		mockPerformAgentCreation.mockResolvedValue({
			id: "00000000-0000-0000-0000-000000000004",
			name: "stealth",
			handle: "stealth@acme.rine.network",
		});

		await rineAgentCreate.handler(ctx, { name: "stealth", human_oversight: false, unlisted: true });

		expect(mockPerformAgentCreation).toHaveBeenCalledWith(
			ctx.client, "/tmp/test", "default",
			{ name: "stealth", humanOversight: false, unlisted: true },
		);
	});
});
