// MCP funnel management tools in `rine-mcp/src/tools/hooks.ts`:
//   rine_hook_create / rine_hook_list / rine_hook_delete  (thin wrappers cloned
//   from rine_groups for the X-Rine-Agent resolution pattern), plus the optional
//   read-only rine_funnel_status. The relay is NEVER an MCP tool (a never-
//   returning relay would hang the stdio transport).
//
// FROZEN-CONTRACT (a violation is a build defect):
//  - rine_hook_create generates the HMAC secret CLIENT-SIDE (randomBytes(32) hex)
//    and POSTs ONLY {hook_name, tier: null} — never a secret. It persists the
//    secret locally and the response states WHERE it was stored (so a relay on
//    another box can be pointed there). A failed create leaves the local secret
//    as it was. The secret appears in create output ONLY, never in list.
//  - No rine_relay / rine_funnel / rine_tunnel EXECUTION tool is registered.
//  - rine_funnel_status (if shipped) returns hostnames + active only (live flag
//    deferred per a ratified decision).
//  - HOOK_DNS_API_TOKEN never appears in this surface (server-side only).
//
// The @rine-network/core actor resolution is mocked; the secret store runs on a
// real temp config dir.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { funnelSecretDir, hookSecretPath } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveActor = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		resolveActor: (...args: unknown[]) => mockResolveActor(...args),
	};
});

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const HOSTNAME = "github.bot.hook.rine.network";

let CONFIG_DIR: string;

function hookCreated(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		hook_name: "github",
		hostname: HOSTNAME,
		termination: "zero_trust",
		active: true,
		created_at: "2026-06-13T00:00:00Z",
		agent_id: AGENT_ID,
		control_ws_url: "wss://funnel.rine.network/_funnel/v1",
		...over,
	};
}

function makeCtx(): ToolContext {
	return {
		client: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } as never,
		configDir: CONFIG_DIR,
		apiUrl: "https://api.test",
	};
}

const { hookTools } = await import("../../src/tools/hooks.js");

/** Locate a required tool by name (throws loudly if the surface dropped it). */
function requireTool(name: string): (typeof hookTools)[number] {
	const tool = hookTools.find((t) => t.name === name);
	if (!tool) throw new Error(`missing tool: ${name}`);
	return tool;
}

const create = requireTool("rine_hook_create");
const list = requireTool("rine_hook_list");
const del = requireTool("rine_hook_delete");

beforeEach(() => {
	CONFIG_DIR = fs.mkdtempSync(join(tmpdir(), "rine-mcp-hook-test-"));
	mockResolveActor.mockReset().mockResolvedValue({ agentId: AGENT_ID });
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

// ── rine_hook_create ────────────────────────────────────────────

describe("rine_hook_create", () => {
	// `tier: null` is the server's "omitted": `HookCreate.tier` defaults to None
	// and the org's trust tier picks the termination.
	it("POSTs ONLY {hook_name, tier: null} — no secret key in the request body", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue(
			hookCreated(),
		);

		await create.handler(ctx, { name: "github", agent: "bot" });

		const [, body] =
			(ctx.client.post as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
		expect(body).toEqual({ hook_name: "github", tier: null });
		expect(Object.keys(body as object)).not.toContain("secret");
		expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/);
	});

	it("returns a 64-hex secret + public_url + signature header and notes where the secret was stored", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue(
			hookCreated(),
		);

		const result = (await create.handler(ctx, { name: "github" })) as Record<
			string,
			unknown
		>;

		expect(String(result.secret)).toMatch(/^[0-9a-f]{64}$/);
		expect(result.public_url).toBe(`https://${HOSTNAME}/`);
		expect(result.signature_header).toBe("X-Hub-Signature-256");
		expect(result.content_type).toBe("application/json");
		// Edge case: the tool MUST tell the operator where it stored
		// the secret (MCP config dir may differ from the relay's box).
		expect(JSON.stringify(result)).toContain(CONFIG_DIR);
	});

	it("persists the secret to {configDir}/funnel/{agentId}/{name}.secret (0600)", async () => {
		const ctx = makeCtx();
		(ctx.client.post as ReturnType<typeof vi.fn>).mockResolvedValue(
			hookCreated(),
		);

		await create.handler(ctx, { name: "github" });

		const p = join(CONFIG_DIR, "funnel", AGENT_ID, "github.secret");
		expect(fs.existsSync(p)).toBe(true);
		expect(fs.statSync(p).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(p, "utf-8").trim()).toMatch(/^[0-9a-f]{64}$/);
	});

	it("leaves no orphan secret behind when the create POST fails for a new name", async () => {
		const ctx = makeCtx();
		const refusal = new Error("409 hook name taken");
		(ctx.client.post as ReturnType<typeof vi.fn>).mockRejectedValue(refusal);

		await expect(create.handler(ctx, { name: "github" })).rejects.toBe(
			refusal,
		);

		const p = hookSecretPath(CONFIG_DIR, AGENT_ID, "github");
		expect(fs.existsSync(p)).toBe(false);
	});

	it("keeps the prior secret of an existing hook when the create POST fails", async () => {
		const ctx = makeCtx();
		fs.mkdirSync(funnelSecretDir(CONFIG_DIR, AGENT_ID), {
			recursive: true,
			mode: 0o700,
		});
		const p = hookSecretPath(CONFIG_DIR, AGENT_ID, "github");
		const prior = "e".repeat(64);
		fs.writeFileSync(p, prior, { mode: 0o600 });
		(ctx.client.post as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("503"),
		);

		await expect(create.handler(ctx, { name: "github" })).rejects.toThrow(
			"503",
		);

		expect(fs.readFileSync(p, "utf-8").trim()).toBe(prior);
	});

	it("inputSchema accepts optional name and agent", () => {
		const props = (
			create.inputSchema as { properties: Record<string, unknown> }
		).properties;
		expect(props).toHaveProperty("name");
		expect(props).toHaveProperty("agent");
	});
});

// ── rine_hook_list (no secret) ──────────────────────────────────

describe("rine_hook_list", () => {
	it("GETs the funnel-hook list and the result carries no secret field", async () => {
		const ctx = makeCtx();
		// Pre-seed a local secret to prove list never reads/returns it.
		fs.mkdirSync(funnelSecretDir(CONFIG_DIR, AGENT_ID), {
			recursive: true,
			mode: 0o700,
		});
		const sentinel = "c".repeat(64);
		fs.writeFileSync(
			hookSecretPath(CONFIG_DIR, AGENT_ID, "github"),
			sentinel,
		);
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			items: [
				{
					hook_name: "github",
					hostname: HOSTNAME,
					active: true,
					created_at: "2026-06-13T00:00:00Z",
				},
			],
			total: 1,
		});

		const result = await list.handler(ctx, { agent: "bot" });

		expect(
			(ctx.client.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
		).toContain("/funnel/hooks");
		expect(JSON.stringify(result)).not.toContain(sentinel);
		expect(JSON.stringify(result).toLowerCase()).not.toContain("secret");
	});
});

// ── rine_hook_delete (purges local secret) ──────────────────────

describe("rine_hook_delete", () => {
	it("DELETEs the named hook, returns {ok:true}, and purges the local secret", async () => {
		const ctx = makeCtx();
		fs.mkdirSync(funnelSecretDir(CONFIG_DIR, AGENT_ID), {
			recursive: true,
			mode: 0o700,
		});
		const p = hookSecretPath(CONFIG_DIR, AGENT_ID, "github");
		fs.writeFileSync(p, "d".repeat(64));
		(ctx.client.delete as ReturnType<typeof vi.fn>).mockResolvedValue(
			undefined,
		);

		const result = (await del.handler(ctx, {
			name: "github",
			agent: "bot",
		})) as Record<string, unknown>;

		expect(
			(ctx.client.delete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
		).toContain("/funnel/hooks/github");
		expect(result).toEqual({ ok: true });
		expect(fs.existsSync(p)).toBe(false);
	});

	it("inputSchema requires name", () => {
		const schema = del.inputSchema as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		expect(schema.required).toContain("name");
	});
});

// ── NO relay execution tool; optional read-only status ──────────

describe("MCP funnel surface — no relay execution tool", () => {
	it("registers no rine_relay / rine_funnel / rine_tunnel execution tool", async () => {
		const { tools } = await import("../../src/tools/index.js");
		const names = tools.map((t) => t.name);
		expect(names).not.toContain("rine_relay");
		expect(names).not.toContain("rine_funnel");
		expect(names).not.toContain("rine_tunnel");
	});

	it("aggregates the three management tools into the global tools array", async () => {
		const { tools } = await import("../../src/tools/index.js");
		const names = tools.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"rine_hook_create",
				"rine_hook_list",
				"rine_hook_delete",
			]),
		);
	});

	it("if rine_funnel_status ships, it returns hostnames + active only (no live flag in v1)", async () => {
		const status = hookTools.find((t) => t.name === "rine_funnel_status");
		if (!status) return; // optional in v1
		const ctx = makeCtx();
		(ctx.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			items: [{ hook_name: "github", hostname: HOSTNAME, active: true }],
			total: 1,
		});
		const result = (await status.handler(ctx, { agent: "bot" })) as Record<
			string,
			unknown
		>;
		// Deferred: no per-hook "relay live" boolean in v1.
		expect(JSON.stringify(result)).not.toMatch(/"(live|tunnel_live)"\s*:/);
	});
});
