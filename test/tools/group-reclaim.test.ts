import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveActor = vi.fn();
const mockResumeMlsGroupAdmission = vi.fn();
const mockReclaimOrphanLeaves = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rine-network/core")>();
  return {
    ...orig,
    resolveActor: (...args: unknown[]) => mockResolveActor(...args),
    resumeMlsGroupAdmission: (...args: unknown[]) =>
      mockResumeMlsGroupAdmission(...args),
    reclaimOrphanLeaves: (...args: unknown[]) =>
      mockReclaimOrphanLeaves(...args),
  };
});

const { groupRecoveryTools } =
  await import("../../src/tools/groups-recovery.js");

const rineGroupReclaim = groupRecoveryTools.find(
  (t) => t.name === "rine_group_reclaim",
)!;

/** A latched MLS group; every test that cares overrides the read. */
function makeCtx(): ToolContext {
  return {
    client: {
      get: vi.fn().mockResolvedValue({
        id: "11111111-1111-1111-1111-111111111111",
        enrollment_policy: "closed",
        mls_group_id: "latch",
      }),
      post: vi.fn(),
    } as never,
    configDir: "/tmp/test",
    apiUrl: "https://api.test",
  };
}

const get = (ctx: ToolContext) => ctx.client.get as ReturnType<typeof vi.fn>;

/** What the resume verb answers when its reclamation pass ran. */
function admission(reclamation: unknown) {
  return { epoch: 9, commits: 2, added: 0, outcomes: [], reclamation };
}

beforeEach(() => {
  mockResolveActor.mockReset().mockResolvedValue({ agentId: "actor-1" });
  mockReclaimOrphanLeaves.mockReset();
  mockResumeMlsGroupAdmission
    .mockReset()
    .mockResolvedValue(
      admission({ found: 3, reclaimed: 2, commits: 2, epoch: 9 }),
    );
});

describe("rine_group_reclaim", () => {
  // 🔴 ONCE is the assertion, not merely "at all". This verb used to read
  // `GET /groups/{id}` twice — the resolve paid for the row and the
  // handler read it again one request later — and the second answer was the one
  // both refusals below were decided on, so a server that answered the two
  // reads differently would refuse or admit on a row the resolve never saw.
  it("reads the group it was asked about once, before touching any key material", async () => {
    const ctx = makeCtx();

    await rineGroupReclaim.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(get(ctx).mock.calls.map((call) => call[0])).toEqual([
      "/groups/11111111-1111-1111-1111-111111111111",
    ]);
  });

  it("runs the resume verb with reclamation asked for, as the acting agent", async () => {
    const ctx = makeCtx();

    await rineGroupReclaim.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", agent: "bot@acme" });

    expect(mockResumeMlsGroupAdmission).toHaveBeenCalledWith(
      "/tmp/test",
      "actor-1",
      "11111111-1111-1111-1111-111111111111",
      ctx.client,
      { "X-Rine-Agent": "actor-1" },
      { reclaim: true },
    );
  });

  // The bare pass declines with `identity_unseated` whenever a member
  // holds no leaf, and this surface has no resume verb to offer as the remedy —
  // so it would decline here permanently. Routing through resume also means the
  // live-invitee half of the entitled set comes from
  // `GET /groups/{id}/requests?outstanding=live`, which is what
  // `fetchGroupTree` reads and nothing else does; that read is pinned on the
  // real code by `rine-core/test/mls-admission.test.ts` ("seats every
  // outstanding invitation"), and its consequence — an invitee who has not
  // accepted is never an orphan — by `rine-core/test/mls-orphans.test.ts`
  // ("does not classify a live invitee as an orphan").
  it("never calls the reclamation pass on its own", async () => {
    const ctx = makeCtx();

    await rineGroupReclaim.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(mockReclaimOrphanLeaves).not.toHaveBeenCalled();
  });

  it("says what it retired and who is billed for it", async () => {
    const ctx = makeCtx();

    const result = (await rineGroupReclaim.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(String(result.message)).toBe(
      "Reclaimed 2 of 3 orphaned leaves in 2 commit(s), now at epoch 9;" +
        " each Remove commit is O(N) and is billed to every member.",
    );
  });

  it("says so when every leaf is accounted for", async () => {
    const ctx = makeCtx();
    mockResumeMlsGroupAdmission.mockResolvedValue(
      admission({ found: 0, reclaimed: 0, commits: 0, epoch: 4 }),
    );

    const result = (await rineGroupReclaim.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(String(result.message)).toBe(
      "Every leaf belongs to a member or to an unanswered invitation.",
    );
  });

  it("returns the pass's own words when it declines to act", async () => {
    const ctx = makeCtx();
    mockResumeMlsGroupAdmission.mockResolvedValue(
      admission({
        found: 0,
        reclaimed: 0,
        commits: 0,
        epoch: 4,
        declined: {
          reason: "identity_unseated",
          detail: "Reclaimed nothing: 1 member(s) of this group publish a key.",
        },
      }),
    );

    const result = (await rineGroupReclaim.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    expect(String(result.message)).toBe(
      "Reclaimed nothing: 1 member(s) of this group publish a key.",
    );
  });

  it("returns what the resume verb seated as well as its sentence", async () => {
    const ctx = makeCtx();

    const result = (await rineGroupReclaim.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
    })) as Record<string, unknown>;

    // The counts ride in the structured fields rather than the sentence, so a
    // caller sees an agent seated on the way through.
    expect(result).toMatchObject({ epoch: 9, commits: 2, added: 0 });
    expect(result.reclamation).toMatchObject({ found: 3, reclaimed: 2 });
  });

  it("refuses an open group and says why, without calling the core", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "open" });

    await expect(
      rineGroupReclaim.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/no ratchet tree and no leaves to reclaim/);
    expect(mockResumeMlsGroupAdmission).not.toHaveBeenCalled();
  });

  it("refuses a group whose tree was never founded, without calling the core", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
      enrollment_policy: "closed",
      mls_group_id: null,
    });

    await expect(
      rineGroupReclaim.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/no ratchet tree yet/);
    expect(mockResumeMlsGroupAdmission).not.toHaveBeenCalled();
  });

  it("offers the tool as one any member may run, at a cost it states", async () => {
    // The deterrent is the O(N) cost billed to every member, not a
    // permission check, and no surface may call this admin-gated.
    const said = rineGroupReclaim.description;
    expect(said).toMatch(/any member may/);
    expect(said).toMatch(/O\(N\)/);
    expect(said).toMatch(/billed to every member/);
    expect(said).not.toMatch(/admin-initiated|admin-gated/);
  });
});
