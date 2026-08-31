import { beforeEach, describe, expect, it, vi } from "vitest";
import { groupInspectTools } from "../../src/tools/groups-inspect.js";
import { routedGet } from "./group-routes.js";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveActor = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rine-network/core")>();
  return {
    ...orig,
    resolveActor: (...args: unknown[]) => mockResolveActor(...args),
  };
});

const rineGroupInspect = groupInspectTools.find(
  (t) => t.name === "rine_group_inspect",
)!;

function makeCtx(): ToolContext {
  return {
    client: { get: vi.fn(), post: vi.fn() } as never,
    configDir: "/tmp/test",
    apiUrl: "https://api.test",
  };
}

const get = (ctx: ToolContext) => ctx.client.get as ReturnType<typeof vi.fn>;

const GROUP_ID = "11111111-1111-1111-1111-111111111111";

/**
 * A group as `GET /groups/{id}` and `GET /groups` both render it.
 *
 * One factory for both routes because the server builds both from
 * `_build_group_read` (`src/rine/api/groups.py`) — including
 * `member_agent_ids`, which is why the seated-id rung sits on the indexed
 * route with no field this tool reads going missing.
 */
function makeGroup(over: Record<string, unknown> = {}) {
  return {
    id: GROUP_ID,
    name: "team",
    handle: "#team@acme.rine.network",
    description: null,
    enrollment_policy: "closed",
    visibility: "private",
    isolated: false,
    vote_duration_hours: 48,
    member_count: 3,
    member_agent_ids: ["mine-1"],
    created_at: "2026-08-01T00:00:00Z",
    mls_group_id: "latched",
    mls_cipher_suite: 0xf057,
    ...over,
  };
}

/**
 * A client that answers `row` on the group's OWN route and `{ items: [row] }`
 * on the org list.
 *
 * 🔴 The resolver's ladder is split across those two reads: a UUID is read
 * from `GET /groups/{id}`, a handle or a bare name still through the list. A
 * stub that answered `{ items: [row] }` to both handed the resolver a page
 * where a row belongs, so every UUID-addressed test here inspected an object
 * with no `id`, no policy and no MLS fields — and four of them asserted
 * `sender-key` and got it, from a group that was not there at all.
 */
function answering(ctx: ToolContext, row: ReturnType<typeof makeGroup>): void {
  get(ctx).mockImplementation(
    routedGet({ [`/groups/${row.id}`]: row }, { items: [row] }),
  );
}

describe("rine_group_inspect", () => {
  beforeEach(() => {
    mockResolveActor.mockReset().mockResolvedValue({ agentId: "reader" });
  });

  it("reports the policy and the post-quantum MLS a closed group runs", async () => {
    const ctx = makeCtx();
    answering(ctx, makeGroup());

    const result = (await rineGroupInspect.handler(ctx, {
      group: "#team@acme.rine.network",
    })) as {
      enrollment_policy: string;
      encryption: { regime: string; post_quantum: boolean; pending: boolean };
    };

    expect(result.enrollment_policy).toBe("closed");
    expect(result.encryption.regime).toBe("mls");
    expect(result.encryption.post_quantum).toBe(true);
    expect(result.encryption.pending).toBe(false);
  });

  it("reports an open group as sender-key, and says it is not post-quantum", async () => {
    const ctx = makeCtx();
    answering(
      ctx,
      makeGroup({
        enrollment_policy: "open",
        mls_group_id: null,
        mls_cipher_suite: null,
      }),
    );

    const result = (await rineGroupInspect.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" })) as {
      encryption: { regime: string; post_quantum: boolean; summary: string };
    };

    expect(result.encryption.regime).toBe("sender-key");
    expect(result.encryption.post_quantum).toBe(false);
    expect(result.encryption.summary).toMatch(/Sender Keys/);
  });

  it("says an MLS group whose tree is not founded yet is still pending", async () => {
    const ctx = makeCtx();
    answering(ctx, makeGroup({ mls_group_id: null, mls_pending: true }));

    const result = (await rineGroupInspect.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" })) as {
      encryption: { regime: string; pending: boolean };
    };

    expect(result.encryption.regime).toBe("mls");
    expect(result.encryption.pending).toBe(true);
  });

  // 🔴 The state this tool once described wrongly: created to run MLS,
  // tree never founded, init window long closed. It carries `sender-key-v1`
  // traffic and the server accepts a send into it, so every field here is the
  // sender keys it runs — and `mls_never_founded` is the half `regime` cannot
  // carry. A model reading `regime` alone still gets a true answer; one reading
  // the whole object learns the group has not got the MLS it was created for.
  it("says a group whose tree was never founded runs sender keys, and names what it has not got", async () => {
    const ctx = makeCtx();
    answering(
      ctx,
      makeGroup({
        mls_enabled: true,
        mls_group_id: null,
        mls_pending: false,
        mls_cipher_suite: null,
      }),
    );

    const result = (await rineGroupInspect.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" })) as {
      encryption: {
        regime: string;
        version: string;
        post_quantum: boolean;
        pending: boolean;
        mls_never_founded: boolean;
        summary: string;
      };
    };

    expect(result.encryption.regime).toBe("sender-key");
    expect(result.encryption.version).toBe("sender-key-v1");
    expect(result.encryption.post_quantum).toBe(false);
    expect(result.encryption.pending).toBe(false);
    expect(result.encryption.mls_never_founded).toBe(true);
    expect(result.encryption.summary).toContain("never founded");
    // Never the words that would send a caller looking for an outage: the
    // group is not frozen, and it carries messages.
    expect(result.encryption.summary).not.toMatch(
      /broken|frozen|failed|cannot carry|holds no keys/i,
    );
  });

  it("leaves the flag off a group that runs sender keys by design", async () => {
    const ctx = makeCtx();
    answering(
      ctx,
      makeGroup({
        enrollment_policy: "open",
        mls_enabled: true,
        mls_group_id: null,
        mls_pending: false,
        mls_cipher_suite: null,
      }),
    );

    const result = (await rineGroupInspect.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" })) as {
      encryption: { mls_never_founded: boolean; summary: string };
    };

    expect(result.encryption.mls_never_founded).toBe(false);
    expect(result.encryption.summary).not.toContain("never founded");
  });

  it("finds the group by a short handle, the way an operator types it", async () => {
    const ctx = makeCtx();
    answering(ctx, makeGroup());

    const result = (await rineGroupInspect.handler(ctx, {
      group: "#team@acme",
    })) as { id: string };

    expect(result.id).toBe("11111111-1111-1111-1111-111111111111");
  });

  // The scope is the ORG, not the acting agent: `GET /groups` selects every
  // group any agent of the calling org belongs to and takes no acting-agent
  // narrowing, so the refusal may not claim otherwise.
  //
  // The mock FILTERS, as the server does. An unconditional page would resolve
  // `#other@acme` to whatever row it holds and this test would assert nothing:
  // `?handle=` is an equality test, and it is the one thing a handle-shaped
  // reference depends on.
  it("refuses a group this org is not in, naming what it looked for", async () => {
    const ctx = makeCtx();
    get(ctx).mockImplementation(
      async (_path: string, params?: Record<string, unknown>) => {
        const items = [makeGroup()];
        if (params?.handle === undefined) return { items };
        return { items: items.filter((g) => g.handle === params.handle) };
      },
    );

    await expect(
      rineGroupInspect.handler(ctx, { group: "#other@acme.rine.network" }),
    ).rejects.toThrow(
      /Group not found: #other@acme\.rine\.network\.[\s\S]*#team@acme\.rine\.network/,
    );
  });

  it("acts as the agent an explicit `agent` names", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "agent-2" });
    answering(ctx, makeGroup());

    await rineGroupInspect.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", agent: "second" });

    // 🔴 The route is `/groups/{id}`, not `/groups`. The seated-id rung reads
    // the group's own row; what this test is about — that the header
    // the caller's `agent` resolved to rides on the read — is unchanged, and
    // asserting the old path would state a read this tool no longer makes.
    expect(get(ctx)).toHaveBeenCalledWith(`/groups/${GROUP_ID}`, undefined, {
      "X-Rine-Agent": "agent-2",
    });
  });

  it("sends no acting header when the caller names no agent", async () => {
    const ctx = makeCtx();
    answering(ctx, makeGroup());

    await rineGroupInspect.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(get(ctx)).toHaveBeenCalledWith(`/groups/${GROUP_ID}`, undefined, {});
    expect(mockResolveActor).not.toHaveBeenCalled();
  });

  it("points at the roster tool rather than listing members itself", async () => {
    expect(rineGroupInspect.description).toContain("rine_group_roster");
  });

  // This tool finds its group in an ORG-scoped list, so being found here
  // never meant the acting agent could post. `member_agent_ids` is the field
  // that answers that, and it must survive the spread that adds `encryption`.
  it("passes member_agent_ids through, so the kind and the seat arrive together", async () => {
    const ctx = makeCtx();
    answering(ctx, makeGroup({ member_agent_ids: ["mine-1", "mine-2"] }));

    const result = (await rineGroupInspect.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" })) as {
      member_agent_ids: string[];
      member_count: number;
    };

    expect(result.member_agent_ids).toEqual(["mine-1", "mine-2"]);
    // Additive, not a replacement: the whole roster is still counted.
    expect(result.member_count).toBe(3);
  });

  it("keeps an empty member_agent_ids rather than dropping the key", async () => {
    const ctx = makeCtx();
    answering(ctx, makeGroup({ member_agent_ids: [] }));

    const result = (await rineGroupInspect.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" })) as
      Record<string, unknown>;

    expect(result).toHaveProperty("member_agent_ids", []);
  });

  it("names member_agent_ids in its description, so a model knows to read it", () => {
    expect(rineGroupInspect.description).toContain("member_agent_ids");
  });
});
