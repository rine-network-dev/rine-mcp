import {
  NOT_A_MEMBER_CLAUSE,
  RineApiError,
  SEATED_SIBLING_CLAUSE,
  VOTE_ELECTORATE_RULE,
  handleCompletionNotes,
  mlsNeverFoundedSync,
} from "@rine-network/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routedGet } from "./group-routes.js";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveActor = vi.fn();
const mockResolveToUuid = vi.fn();
const mockHoldsMlsState = vi.fn();
const mockLoadMlsState = vi.fn();
const mockAddMlsGroupMember = vi.fn();
const mockDeleteGroupMember = vi.fn();
const mockRetireLocalGroupState = vi.fn();
const mockRecoverGroup = vi.fn();
const mockIsMlsResyncUnavailable = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rine-network/core")>();
  return {
    ...orig,
    resolveActor: (...args: unknown[]) => mockResolveActor(...args),
    resolveToUuid: (...args: unknown[]) => mockResolveToUuid(...args),
    holdsMlsState: (...args: unknown[]) => mockHoldsMlsState(...args),
    loadMlsState: (...args: unknown[]) => mockLoadMlsState(...args),
    addMlsGroupMember: (...args: unknown[]) => mockAddMlsGroupMember(...args),
    deleteGroupMember: (...args: unknown[]) => mockDeleteGroupMember(...args),
    retireLocalGroupState: (...args: unknown[]) =>
      mockRetireLocalGroupState(...args),
    recoverGroup: (...args: unknown[]) => mockRecoverGroup(...args),
    isMlsResyncUnavailable: (...args: unknown[]) =>
      mockIsMlsResyncUnavailable(...args),
  };
});

const { groupAdminTools } = await import("../../src/tools/groups-admin.js");
const { groupRecoveryTools } =
  await import("../../src/tools/groups-recovery.js");
const { tools } = await import("../../src/tools/index.js");

const toolNamed = (name: string) =>
  [...groupAdminTools, ...groupRecoveryTools].find((t) => t.name === name)!;

const rineGroupRequests = toolNamed("rine_group_requests");
const rineGroupVote = toolNamed("rine_group_vote");
const rineGroupLeave = toolNamed("rine_group_leave");
const rineGroupRemove = toolNamed("rine_group_remove");
const rineGroupSync = toolNamed("rine_group_sync");

interface ToolSchema {
  properties: Record<string, { description?: string; enum?: string[] }>;
  required?: string[];
}

const schemaOf = (name: string): ToolSchema =>
  toolNamed(name).inputSchema as unknown as ToolSchema;

const GROUP_ID = "11111111-1111-1111-1111-111111111111";

/**
 * The row `GET /groups/{id}` answers — a plain MLS group.
 *
 * That route is the first read of every verb below, so a test that
 * overrides `get` names this route explicitly (`routedGet`) rather than
 * answering its own payload to the resolver as well.
 */
const GROUP_PATH = `/groups/${GROUP_ID}`;
const GROUP_ROW = { id: GROUP_ID, mls_group_id: "latch" };

/** A context whose GET answers a plain MLS group; every test that cares overrides it. */
function makeCtx(): ToolContext {
  return {
    client: {
      get: vi.fn().mockResolvedValue(GROUP_ROW),
      post: vi.fn(),
    } as never,
    configDir: "/tmp/test",
    apiUrl: "https://api.test",
  };
}

const get = (ctx: ToolContext) => ctx.client.get as ReturnType<typeof vi.fn>;
const post = (ctx: ToolContext) => ctx.client.post as ReturnType<typeof vi.fn>;

/** The routes one call asked for, in order. */
const paths = (ctx: ToolContext): string[] =>
  get(ctx).mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  mockResolveActor.mockReset().mockResolvedValue({ agentId: "actor-1" });
  mockResolveToUuid.mockReset().mockResolvedValue("target-uuid");
  mockHoldsMlsState.mockReset().mockReturnValue(false);
  mockLoadMlsState.mockReset().mockReturnValue(null);
  mockAddMlsGroupMember.mockReset().mockResolvedValue({ epoch: 4 });
  mockDeleteGroupMember.mockReset().mockResolvedValue(null);
  mockRetireLocalGroupState.mockReset().mockReturnValue({ retired: true });
  mockRecoverGroup.mockReset();
  mockIsMlsResyncUnavailable.mockReset().mockReturnValue(false);
});

describe("the MCP group admin tool inventory", () => {
  it("registers the four verbs that act on an existing membership", () => {
    expect(groupAdminTools.map((t) => t.name)).toEqual([
      "rine_group_requests",
      "rine_group_vote",
      "rine_group_leave",
      "rine_group_remove",
    ]);
  });

  it("registers the two verbs that repair the ratchet tree", () => {
    expect(groupRecoveryTools.map((t) => t.name)).toEqual([
      "rine_group_sync",
      "rine_group_reclaim",
    ]);
  });

  // The shipped-surface gate reads the modules `index.ts` imports, not
  // their transitive imports. A registry reached only through `groups.ts` would
  // leave every doc naming these six claiming a tool the host does not expose —
  // and nothing else would notice.
  it("exposes all six from the server's own tool list", () => {
    const names = tools.map((t) => t.name);
    for (const verb of [...groupAdminTools, ...groupRecoveryTools]) {
      expect(names).toContain(verb.name);
    }
  });

  it("names no tool the OpenClaw host does not also expose", () => {
    // OpenClaw re-registers these ToolDefs verbatim, so a description may
    // only point at tools in its own post-build set.
    const openclawSet = new Set([
      "rine_discover_groups",
      "rine_groups",
      "rine_group_create",
      "rine_group_join",
      "rine_group_roster",
      "rine_group_invite",
      "rine_group_invites",
      "rine_group_requests",
      "rine_group_vote",
      "rine_group_leave",
      "rine_group_remove",
      "rine_group_sync",
    ]);
    for (const verb of [...groupAdminTools, ...groupRecoveryTools]) {
      for (const named of verb.description.match(/rine_[a-z_]+/g) ?? []) {
        expect(openclawSet).toContain(named);
      }
    }
  });

  // The electorate rule is pinned verbatim and every surface
  // renders the same sentence. It lived here as a hand-copied literal, which is
  // how a re-pin of the Python constant left five TypeScript surfaces stating
  // the old rule with nothing to catch it. This asserts the constant reaches
  // the model, so a future re-pin cannot half-ship.
  it("states the pinned electorate rule verbatim in the vote tool", () => {
    expect(rineGroupVote.description).toContain(VOTE_ELECTORATE_RULE);
  });

  // MCP returns the server's raw JSON, so this description is the only place a
  // model learns a field exists at all.
  it("names both bars in the requests tool, so a model knows to read them", () => {
    for (const field of [
      "electorate_size",
      "approvals",
      "approvals_needed",
      "denials",
      "denials_needed",
    ]) {
      expect(rineGroupRequests.description).toContain(field);
    }
  });
});

describe("rine_group_requests", () => {
  it("sends the outstanding filter explicitly, defaulting to the vote queue", async () => {
    const ctx = makeCtx();
    get(ctx).mockImplementation(
      routedGet({ [GROUP_PATH]: GROUP_ROW }, { items: [], total: 0 }),
    );

    await rineGroupRequests.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(ctx.client.get).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/requests",
      { outstanding: "pending" },
      {},
    );
  });

  it("passes the named population through and returns the server's shape", async () => {
    const ctx = makeCtx();
    const page = { items: [{ id: "r1", agent_id: "a1" }], total: 1 };
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, page));

    const result = await rineGroupRequests.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      outstanding: "live",
    });

    expect(ctx.client.get).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/requests",
      { outstanding: "live" },
      {},
    );
    expect(result).toEqual(page);
  });

  it("offers exactly the three populations the server accepts", () => {
    expect(
      schemaOf("rine_group_requests").properties.outstanding?.enum,
    ).toEqual(["pending", "invited", "live"]);
  });

  // The same re-wording every other group read gets. Without it an
  // evicted agent is told what a stranger is told.
  //
  // 🔴 The detail is the arm the server REALLY sends here, not a stand-in.
  // This route's only gate is `get_acting_group_member`, so every 403 it can
  // produce is one of `not_a_member_detail`'s three arms — and the no-sibling
  // arm below is exactly what a sole agent that was evicted reads. A fixture
  // like the old `"Not a member"` carries neither clause, so it took a branch
  // the server cannot reach and kept this test green over a dead path.
  it("tells an agent that holds MLS state it was removed", async () => {
    const ctx = makeCtx();
    mockHoldsMlsState.mockReturnValue(true);
    // The refusal is pinned to the QUEUE route, not to every route: the
    // seated-id rung reads `/groups/{id}` first and swallows a 403 into its own
    // roster refusal, so a blanket rejection would test the resolver's sentence
    // while claiming to test this verb's.
    get(ctx).mockImplementation(
      routedGet(
        { [GROUP_PATH]: GROUP_ROW },
        new RineApiError(
          403,
          `agent ops-bot ${NOT_A_MEMBER_CLAUSE}, and no agent of your org is — a ` +
            "member must invite one of your agents before this org can act in it",
        ),
      ),
    );

    await expect(
      rineGroupRequests.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/You were removed from group 11111111-1111-1111-1111-111111111111/);
  });

  // The same arm, from an agent that holds no local MLS state: nothing here
  // was evicted, so the server's own sentence is the answer and the eviction
  // wording must not appear.
  it("leaves the no-sibling refusal alone when no MLS state is held", async () => {
    const ctx = makeCtx();
    mockHoldsMlsState.mockReturnValue(false);
    const refusal = new RineApiError(
      403,
      `agent ops-bot ${NOT_A_MEMBER_CLAUSE}, and no agent of your org is — a ` +
        "member must invite one of your agents before this org can act in it",
    );
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, refusal));

    await expect(
      rineGroupRequests.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toBe(refusal);
  });

  // This is the route it matters on: `GET /groups/{id}/requests`
  // goes through `get_acting_group_member`, so it is where the server's new
  // membership refusal actually reaches an MCP caller. An org whose SIBLING
  // holds the seat was never evicted, and the remedy it needs is the server's
  // own sentence — which names the sibling and the header to retry with.
  it("hands back the sibling-seat refusal instead of claiming an eviction", async () => {
    const ctx = makeCtx();
    mockHoldsMlsState.mockReturnValue(true);
    const refusal = new RineApiError(
      403,
      `agent ops-bot ${NOT_A_MEMBER_CLAUSE}; your agent sales-bot is — ` +
        `${SEATED_SIBLING_CLAUSE}: sales@acme.rine.network`,
    );
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, refusal));

    await expect(
      rineGroupRequests.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toBe(refusal);
  });

  // The plural arm carries the same clause on a multi-line detail, so the
  // check cannot depend on the sentence's shape past the clause itself.
  it("recognises the multi-agent arm of the same refusal", async () => {
    const ctx = makeCtx();
    mockHoldsMlsState.mockReturnValue(true);
    const refusal = new RineApiError(
      403,
      `agent ops-bot ${NOT_A_MEMBER_CLAUSE}; these agents of yours are — ` +
        `${SEATED_SIBLING_CLAUSE} set to one of them:\n  - sales-bot (sales@acme)`,
    );
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, refusal));

    await expect(
      rineGroupRequests.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toBe(refusal);
  });
});

describe("rine_group_vote", () => {
  /** What `GET /groups/{id}/requests?outstanding=pending` answers. */
  const PENDING_QUEUE = { items: [{ id: "r1", agent_id: "a1" }] };

  // Once a vote crosses the threshold the request leaves the pending list
  // and the vote response does not carry the agent it admitted, so an applicant
  // read afterwards is unreadable and nobody is ever seated.
  it("captures the applicant BEFORE casting an approve, and seats them", async () => {
    const ctx = makeCtx();
    const order: string[] = [];
    get(ctx).mockImplementation(async (path: string) => {
      // The resolver's own read is not part of the ordering this test is about;
      // `reads the applicant off the pending queue for this group` below pins it.
      if (path === GROUP_PATH) return GROUP_ROW;
      order.push("get-requests");
      return { items: [{ id: "r1", agent_id: "applicant-1" }] };
    });
    post(ctx).mockImplementation(async () => {
      order.push("post-vote");
      return { request_id: "r1", your_vote: "approve", status: "approved" };
    });

    const result = await rineGroupVote.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      request_id: "r1",
      vote: "approve",
    });

    expect(order).toEqual(["get-requests", "post-vote"]);
    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/requests/r1/vote",
      { vote: "approve" },
      {},
    );
    expect(mockAddMlsGroupMember).toHaveBeenCalledWith(
      "/tmp/test",
      "actor-1",
      "11111111-1111-1111-1111-111111111111",
      "applicant-1",
      ctx.client,
      { "X-Rine-Agent": "actor-1" },
    );
    expect(result).toMatchObject({ status: "approved", mls_seated: true });
  });

  it("reads the applicant off the pending queue for this group", async () => {
    const ctx = makeCtx();
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, PENDING_QUEUE));
    post(ctx).mockResolvedValue({ status: "approved" });

    await rineGroupVote.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      request_id: "r1",
      vote: "approve",
    });

    expect(ctx.client.get).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/requests",
      { outstanding: "pending" },
      {},
    );
  });

  it("seats nobody when the approve did not resolve the request", async () => {
    const ctx = makeCtx();
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, PENDING_QUEUE));
    post(ctx).mockResolvedValue({ status: "pending" });

    const result = await rineGroupVote.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      request_id: "r1",
      vote: "approve",
    });

    expect(mockAddMlsGroupMember).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mls_seated: false });
  });

  // The fourth answer. A carried vote on a request a member filed for
  // an agent that has not answered yet resolves to `invited`, a spendable
  // voucher and not a membership. Widening the seat branch to "anything that is
  // not denied" would Welcome an agent that never consented, and every suite
  // would stay green.
  it("seats nobody when a carried nomination resolves to an invitation", async () => {
    const ctx = makeCtx();
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, PENDING_QUEUE));
    post(ctx).mockResolvedValue({ status: "invited" });

    const result = await rineGroupVote.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      request_id: "r1",
      vote: "approve",
    });

    expect(mockAddMlsGroupMember).not.toHaveBeenCalled();
    // The wire status reaches the caller unchanged, so the model reads which of
    // the four answers it got rather than inferring one from `mls_seated`.
    expect(result).toMatchObject({ status: "invited", mls_seated: false });
  });

  it("does not read the queue at all for a deny", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ status: "denied" });

    await rineGroupVote.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      request_id: "r1",
      vote: "deny",
    });

    // 🔴 Asserted as "no QUEUE read", not as "no read at all". Every
    // UUID-addressed verb has one indexed `GET /groups/{id}` in front of it, so
    // the blanket `not.toHaveBeenCalled()` this used to carry now states the old
    // contract rather than this test's property — which is that a deny captures
    // no applicant, because there is nobody to seat.
    expect(paths(ctx)).toEqual([GROUP_PATH]);
    expect(mockAddMlsGroupMember).not.toHaveBeenCalled();
  });

  // The membership the server wrote stands whether or not a leaf could be
  // minted, and the resume verb seats whoever the add could not reach — so the
  // seat is reported, never thrown.
  it("reports a failed seating instead of failing the vote", async () => {
    const ctx = makeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, PENDING_QUEUE));
    post(ctx).mockResolvedValue({ status: "approved" });
    mockAddMlsGroupMember.mockRejectedValue(new Error("no MLS state"));

    const result = await rineGroupVote.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      request_id: "r1",
      vote: "approve",
    });

    expect(result).toMatchObject({ status: "approved", mls_seated: false });
    warn.mockRestore();
  });

  it("casts the vote even when the pre-vote queue read fails", async () => {
    // The capture belongs to the best-effort seat, not to the vote. Unguarded,
    // a transient 5xx or a group rate limit aborts the whole approve before it
    // is cast, and the caller cannot tell that from a refused vote.
    const ctx = makeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The QUEUE read is what fails. A blanket rejection would fail the
    // resolver's own read instead, and the resolver rethrows anything that is
    // not a 404/403 — so the test would be asserting that a group nobody could
    // resolve still votes, which is not the property.
    get(ctx).mockImplementation(
      routedGet({ [GROUP_PATH]: GROUP_ROW }, new Error("503 unavailable")),
    );
    post(ctx).mockResolvedValue({ status: "approved" });

    const result = await rineGroupVote.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      request_id: "r1",
      vote: "approve",
    });

    expect(ctx.client.post).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "approved", mls_seated: false });
    expect(mockAddMlsGroupMember).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses a vote that is neither approve nor deny, before posting", async () => {
    const ctx = makeCtx();

    await expect(
      rineGroupVote.handler(ctx, {
        group: "11111111-1111-1111-1111-111111111111",
        request_id: "r1",
        vote: "maybe",
      }),
    ).rejects.toThrow(/approve.*deny/);
    expect(ctx.client.post).not.toHaveBeenCalled();
  });

  it("acts as the named agent on both calls", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "voter-9" });
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, PENDING_QUEUE));
    post(ctx).mockResolvedValue({ status: "approved" });

    await rineGroupVote.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      request_id: "r1",
      vote: "approve",
      agent: "mybot",
    });

    expect(ctx.client.get).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/requests",
      { outstanding: "pending" },
      { "X-Rine-Agent": "voter-9" },
    );
    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/requests/r1/vote",
      { vote: "approve" },
      { "X-Rine-Agent": "voter-9" },
    );
  });
});

describe("rine_group_leave", () => {
  // 🔴 The server tells a leave from a kick by X-Rine-Agent alone and fails
  // closed. The TS SDK shipped this DELETE without the header and left an
  // unpinned multi-agent org unable to leave or kick at all.
  it("names the acting agent on the DELETE and asks for no Remove commit", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "self-7" });

    await rineGroupLeave.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(mockDeleteGroupMember).toHaveBeenCalledWith(
      ctx.client,
      "/tmp/test",
      "11111111-1111-1111-1111-111111111111",
      "self-7",
      undefined,
      { "X-Rine-Agent": "self-7" },
    );
  });

  it("retires local key material only after the server accepted the leave", async () => {
    const ctx = makeCtx();
    const order: string[] = [];
    mockDeleteGroupMember.mockImplementation(async () => {
      order.push("delete");
      return null;
    });
    mockRetireLocalGroupState.mockImplementation(() => {
      order.push("wipe");
      return { retired: true };
    });

    await rineGroupLeave.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(order).toEqual(["delete", "wipe"]);
  });

  it("does not wipe when the server refused the leave", async () => {
    const ctx = makeCtx();
    mockDeleteGroupMember.mockRejectedValue(new RineApiError(403, "nope"));

    await expect(
      rineGroupLeave.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow();
    expect(mockRetireLocalGroupState).not.toHaveBeenCalled();
  });

  it("says what happened to the keys of an MLS group", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
      enrollment_policy: "closed",
      mls_group_id: "latch",
    });

    const result = (await rineGroupLeave.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(result.left).toBe(true);
    expect(result.local_state_retired).toBe(true);
    expect(String(result.message)).toMatch(/Local MLS state for this group/);
  });

  // An open group has no cryptographic eviction, and a leave from one
  // must not be described as if it did.
  it("says a leave from an open group bounds nobody's reach by itself", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "open" });

    const result = (await rineGroupLeave.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(String(result.message)).toMatch(/not a cryptographic eviction/);
    expect(String(result.message)).toMatch(/rotating on their next send/);
  });

  // Reporting that key material is gone while it is still on disk is
  // the defect this field exists to stop.
  it("reports a wipe that did not happen", async () => {
    const ctx = makeCtx();
    mockRetireLocalGroupState.mockReturnValue({
      retired: false,
      error: "Warning: local group key material was NOT removed: EACCES",
    });

    const result = (await rineGroupLeave.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(result.local_state_retired).toBe(false);
    expect(String(result.local_state_error)).toMatch(/NOT removed/);
  });
});

describe("rine_group_remove", () => {
  it("resolves a handle and passes the acting agent lazily", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("ben-uuid");

    await rineGroupRemove.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      agent_id: "ben@acme",
    });

    expect(mockResolveToUuid).toHaveBeenCalledWith(
      "https://api.test",
      "ben@acme",
    );
    const call = mockDeleteGroupMember.mock.calls[0]!;
    expect(call.slice(0, 4)).toEqual([
      ctx.client,
      "/tmp/test",
      "11111111-1111-1111-1111-111111111111",
      "ben-uuid",
    ]);
    // A resolver, not a resolved id: a kick that needs no commit must not fail
    // in a multi-agent org that named no acting agent.
    expect(typeof call[4]).toBe("function");
    expect(mockResolveActor).not.toHaveBeenCalled();
  });

  it("reports the Remove commit the server asked for", async () => {
    const ctx = makeCtx();
    mockDeleteGroupMember.mockResolvedValue({ epoch: 12, removedLeaf: true });

    const result = (await rineGroupRemove.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      agent_id: "ben@acme",
    })) as Record<string, unknown>;

    expect(result.mls_removal_epoch).toBe(12);
    expect(result.mls_removed_leaf).toBe(true);
    expect(String(result.message)).toMatch(/Remove commit at epoch 12/);
  });

  // A commit that landed is not the same fact as a leaf that was taken: the
  // rescue posts a path-only commit when the target holds no leaf.
  it("does not claim a leaf was taken when none was", async () => {
    const ctx = makeCtx();
    mockDeleteGroupMember.mockResolvedValue({ epoch: 12, removedLeaf: false });

    const result = (await rineGroupRemove.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      agent_id: "ben@acme",
    })) as Record<string, unknown>;

    expect(result.mls_removed_leaf).toBe(false);
    expect(String(result.message)).toMatch(/nothing was taken out of it/);
  });

  // 🔴 This verb is where a silent completion is least recoverable: a
  // removal takes nothing back. `removed` echoes the caller's
  // own spelling, which is exactly WHY the notice is owed — without it the
  // answer agrees with what was typed while the eviction landed on the
  // completed handle, and the only other field naming the target is a UUID.
  // Both are asserted together, because the notice's job is to close the gap
  // between them.
  it("reports a completed target beside the spelling it echoes back", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("ben-uuid");
    mockDeleteGroupMember.mockResolvedValue({ epoch: 12, removedLeaf: true });

    const result = (await rineGroupRemove.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      agent_id: "ben@acme",
    })) as Record<string, unknown>;

    expect(result.removed).toBe("ben@acme");
    expect(result.agent_id).toBe("ben-uuid");
    expect(result.handle_completion).toBe(handleCompletionNotes(["ben@acme"]));
  });

  it("says nothing when the target's spelling was already whole", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("ben-uuid");
    mockDeleteGroupMember.mockResolvedValue({ epoch: 12, removedLeaf: true });

    const result = await rineGroupRemove.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      agent_id: "ben@acme.rine.network",
    });

    expect(result).not.toHaveProperty("handle_completion");
  });

  it("describes an open group's removal as a delivery-filter removal", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "open" });

    const result = (await rineGroupRemove.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      agent_id: "ben@acme",
    })) as Record<string, unknown>;

    expect(result.mls_removal_epoch).toBeNull();
    expect(String(result.message)).toMatch(/no cryptographic eviction/);
  });

  // 🔴 Re-scoped by the resolver, and the re-scoping is a product fact rather
  // than a test detail. The row read in `readGroup` is best-effort — only the
  // closing sentence depends on it — but a UUID reference now RESOLVES through
  // that same `/groups/{id}` route, so a row this caller cannot read refuses
  // the verb outright instead of removing quietly. What survives is a reference
  // resolved some other way with the row read failing behind it: the group was
  // listed, then vanished before the tail asked for it.
  it("still answers when the group row cannot be read", async () => {
    const ctx = makeCtx();
    get(ctx).mockImplementation(
      routedGet(
        {
          "/groups": {
            items: [{ id: GROUP_ID, handle: "#team@acme.rine.network" }],
          },
        },
        new RineApiError(404, "gone"),
      ),
    );

    const result = (await rineGroupRemove.handler(ctx, {
      group: "#team@acme.rine.network",
      agent_id: "ben@acme",
    })) as Record<string, unknown>;

    expect(result.removed).toBe("ben@acme");
    expect(result.message).toBe("");
  });
});

describe("rine_group_sync", () => {
  it("replays and reports what the recovery cost", async () => {
    const ctx = makeCtx();
    mockRecoverGroup.mockResolvedValue({
      regime: "mls",
      rung: "replay",
      fromEpoch: 1,
      epoch: 4,
      behind: 3,
      processed: 3,
      evicted: false,
    });

    const result = (await rineGroupSync.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    // The already-fetched group ROW is what is handed on, never the bare id:
    // `GET /groups/{id}` is what says the group exists, that this agent is
    // seated in it, and which encryption it runs, and a surface that could pass
    // an id would be able to skip it.
    expect(mockRecoverGroup).toHaveBeenCalledWith(
      "/tmp/test",
      "actor-1",
      { id: "11111111-1111-1111-1111-111111111111", mls_group_id: "latch" },
      ctx.client,
      { "X-Rine-Agent": "actor-1" },
    );
    expect(result.regime).toBe("mls");
    expect(result.rung).toBe("replay");
    expect(String(result.message)).toMatch(/Nothing was committed/);
  });

  // 🔴 ONCE, and the count is the property. This verb used to pay
  // `GET /groups/{id}` twice — the resolve read the row and the handler
  // read it again one request later — and it was the SECOND answer that reached
  // `recoverGroup`, so a server that answered the two differently would replay
  // one group's epoch ladder against another group's row.
  it("reads the group's row once, from the resolve that found it", async () => {
    const ctx = makeCtx();
    mockRecoverGroup.mockResolvedValue({
      regime: "mls",
      rung: "replay",
      fromEpoch: 1,
      epoch: 4,
      behind: 3,
      processed: 3,
      evicted: false,
    });

    await rineGroupSync.handler(ctx, { group: GROUP_ID });

    expect(paths(ctx)).toEqual([GROUP_PATH]);
  });

  it("says out loud that the resync rung bills every member", async () => {
    const ctx = makeCtx();
    mockRecoverGroup.mockResolvedValue({
      regime: "mls",
      rung: "resync",
      fromEpoch: 2,
      epoch: 30,
      behind: 28,
      processed: 0,
      evicted: false,
    });

    const result = (await rineGroupSync.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(String(result.message)).toMatch(/O\(N\)/);
    expect(String(result.message)).toMatch(/every member of the group/);
  });

  it("reports an eviction it discovered while replaying", async () => {
    const ctx = makeCtx();
    mockRecoverGroup.mockResolvedValue({
      regime: "mls",
      rung: "replay",
      fromEpoch: 1,
      epoch: 9,
      behind: 8,
      processed: 8,
      evicted: true,
    });

    const result = (await rineGroupSync.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(String(result.message)).toMatch(/was removed from the group/);
  });

  it("recovers a sender-key group by installing the keys that were waiting", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "open" });
    mockRecoverGroup.mockResolvedValue({
      regime: "sender-key",
      ingested: 2,
      retired: false,
    });

    const result = (await rineGroupSync.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    // The whole answer rides on `regime`, and the fields it carries are the
    // ones this group's encryption actually has — no epoch, no rung, no leaf.
    expect(result.regime).toBe("sender-key");
    expect(result.ingested).toBe(2);
    expect(result.retired).toBe(false);
    expect(result.rung).toBeUndefined();
    expect(String(result.message)).toMatch(/installed 2 sender key\(s\)/);
    expect(String(result.message)).not.toMatch(/removed from the group/);
    // A sender-key recovery posts nothing: no commit, no re-key, no fan-out.
    expect(post(ctx)).not.toHaveBeenCalled();
  });

  it("says an agent that retired this group's keys needs an invitation", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "open" });
    mockRecoverGroup.mockResolvedValue({
      regime: "sender-key",
      ingested: 0,
      retired: true,
    });

    const result = (await rineGroupSync.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(result.retired).toBe(true);
    expect(String(result.message)).toMatch(/needs an invitation/);
    // The gate fails closed, so `retired` also covers a membership read that
    // never got an answer: the sentence offers the retry first and escalates
    // second, and states no verdict the client never obtained.
    expect(String(result.message)).toMatch(/run the sync again/);
  });

  // 🔴 The group whose tree was never founded is not a refusal here: it
  // really does have sender keys waiting, so the install happens and the
  // warning rides on the answer that reports it.
  it("installs what was waiting on a never-founded group, then warns", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", mls_enabled: true });
    mockRecoverGroup.mockResolvedValue({
      regime: "sender-key",
      ingested: 3,
      retired: false,
      mlsNeverFoundedNote: mlsNeverFoundedSync(),
    });

    const result = (await rineGroupSync.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(result.regime).toBe("sender-key");
    expect(result.ingested).toBe(3);
    // The field survives `withActorNote`, which composes onto the same object.
    expect(String(result.mlsNeverFoundedNote)).toMatch(/never founded/);
    // 🔴 Not under the key `warning`: `withActorNote` owns `note`, and a second
    // composer writing a shared key is how one of the two answers vanishes.
    expect(result.warning).toBeUndefined();
    const message = String(result.message);
    // Both halves, in that order: what was installed, then what is missing.
    expect(message).toMatch(/installed 3 sender key\(s\)/);
    expect(message).toMatch(/never founded/);
    // 🔴 This surface has no verb that founds a group, so it offers none.
    expect(message).toMatch(/No verb on this surface founds it/);
    expect(message).not.toMatch(/rine_group_reclaim|resume-admission/);
    // And it posts nothing: no commit, no re-key, no fan-out.
    expect(post(ctx)).not.toHaveBeenCalled();
  });

  it("says nothing extra on a group that runs sender keys by design", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "open" });
    mockRecoverGroup.mockResolvedValue({
      regime: "sender-key",
      ingested: 1,
      retired: false,
    });

    const result = (await rineGroupSync.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(result.mlsNeverFoundedNote).toBeUndefined();
    expect(String(result.message)).not.toMatch(/never founded/);
  });

  // A tool call has no exit code, so the classification a CLI puts in one has
  // to ride in the thrown message or it is lost.
  it("keeps an unrecoverable refusal's own words", async () => {
    const ctx = makeCtx();
    mockRecoverGroup.mockRejectedValue(
      new Error(
        "The group has published no GroupInfo, so no resync is possible.",
      ),
    );
    mockIsMlsResyncUnavailable.mockReturnValue(true);

    await expect(
      rineGroupSync.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/no GroupInfo/);
  });
});
