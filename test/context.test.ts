import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PrincipalKind,
	deriveOrg,
	pinsFor,
	principalString,
	saveProfiles,
	saveRoot,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_ROOT, seedAgentKeys } from "@rine-network/core/testing";

const mockStartupEscrowSweep = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		startupEscrowSweep: (...args: unknown[]) => mockStartupEscrowSweep(...args),
	};
});

const { createServerContext } = await import("../src/context.js");

const AGENT_ID = "11111111-2222-3333-4444-555555555555";
const SECOND_AGENT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";

const ORG_ID = deriveOrg(FIXTURE_ROOT).orgId;

let configDir: string;
let ownerDir: string;
let savedConfigDir: string | undefined;
let savedOwnerDir: string | undefined;
let savedToken: string | undefined;

/** A fresh temp dir; the owner dir must stay outside any git checkout, tmpdir is fine. */
function freshDir(prefix: string): string {
	return fs.mkdtempSync(join(tmpdir(), prefix));
}

/** Seed the owner dir with the fixture org root and its `default` org profile. */
function seedOwner(): void {
	saveRoot(ownerDir, FIXTURE_ROOT);
	saveProfiles(ownerDir, {
		default: {
			org_id: ORG_ID,
			principal: principalString({ kind: PrincipalKind.Org, orgId: ORG_ID }),
		},
	});
}

/** Let the deferred `sweepEscrowAtStart` body run. */
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(() => {
	configDir = freshDir("rine-mcp-ctx-config-");
	ownerDir = freshDir("rine-mcp-ctx-owner-");
	savedConfigDir = process.env.RINE_CONFIG_DIR;
	savedOwnerDir = process.env.RINE_OWNER_DIR;
	savedToken = process.env.RINE_TOKEN;
	process.env.RINE_CONFIG_DIR = configDir;
	process.env.RINE_OWNER_DIR = ownerDir;
	delete process.env.RINE_TOKEN;
	mockStartupEscrowSweep.mockReset();
});

afterEach(() => {
	fs.rmSync(configDir, { recursive: true, force: true });
	fs.rmSync(ownerDir, { recursive: true, force: true });
	restoreEnv("RINE_CONFIG_DIR", savedConfigDir);
	restoreEnv("RINE_OWNER_DIR", savedOwnerDir);
	restoreEnv("RINE_TOKEN", savedToken);
});

describe("createServerContext own-identity pins", () => {
	it("pins the own org and every local agent, and re-pins after refreshIdentity", () => {
		seedOwner();
		seedAgentKeys(configDir, AGENT_ID);

		const { ctx } = createServerContext();
		const pins = pinsFor(ctx.client);

		expect(pins.ownOrgId).toBe(ORG_ID);
		expect(pins.ownAgentIds.has(AGENT_ID)).toBe(true);

		seedAgentKeys(configDir, SECOND_AGENT_ID);
		expect(pins.ownAgentIds.has(SECOND_AGENT_ID)).toBe(false);

		ctx.refreshIdentity();
		expect(pins.ownAgentIds.has(SECOND_AGENT_ID)).toBe(true);
	});
});

describe("createServerContext without an identity", () => {
	it("pins no org and refuses a request with Not registered", async () => {
		const { ctx } = createServerContext();

		expect(pinsFor(ctx.client).ownOrgId).toBeUndefined();
		await expect(ctx.client.get("/org")).rejects.toThrow("Not registered");
	});
});

describe("createServerContext when another process onboards later", () => {
	it("stops refusing with Not registered once the owner dir holds an org", async () => {
		const { ctx } = createServerContext();
		await expect(ctx.client.get("/org")).rejects.toThrow("Not registered");

		seedOwner();
		seedAgentKeys(configDir, AGENT_ID);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		try {
			await expect(ctx.client.get("/org")).rejects.toThrow(/offline|fetch/);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("sweepEscrowAtStart", () => {
	it("sweeps once per call with no agent id for an org principal", async () => {
		seedOwner();
		const { ctx, sweepEscrowAtStart } = createServerContext();

		sweepEscrowAtStart();
		await flushMicrotasks();
		expect(mockStartupEscrowSweep).toHaveBeenCalledTimes(1);
		expect(mockStartupEscrowSweep).toHaveBeenCalledWith(
			ctx.client,
			configDir,
			undefined,
		);

		sweepEscrowAtStart();
		await flushMicrotasks();
		expect(mockStartupEscrowSweep).toHaveBeenCalledTimes(2);
	});

	it("never throws when the sweep rejects", async () => {
		seedOwner();
		mockStartupEscrowSweep.mockRejectedValue(new Error("sweep failed"));
		const { sweepEscrowAtStart } = createServerContext();

		expect(() => sweepEscrowAtStart()).not.toThrow();
		await flushMicrotasks();
		expect(mockStartupEscrowSweep).toHaveBeenCalledTimes(1);
	});
});
