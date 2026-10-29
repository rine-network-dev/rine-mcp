/**
 * `rine_group_join` and the one MLS failure it does NOT swallow.
 *
 * The MLS setup runs through rine-core's `establishMlsMembership` after the
 * join POST answers 200 (or 409 `already_a_member` for an agent with no local
 * state), so it warns on stderr rather than failing the call. A 202 runs no MLS
 * step. There is exactly one exception: a Welcome the group substitution guard
 * REFUSED for the group being joined. That is a security verdict about who
 * minted the Welcome; a warning on stderr is a place no model ever reads, and
 * `rine.groups.join()` on the Python SDK already raises the same refusal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockEstablish = vi.fn();
const mockSeated = vi.fn();
const mockResolveActor = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rine-network/core")>();
  return {
    ...orig,
    establishMlsMembership: (...args: unknown[]) => mockEstablish(...args),
    seatedMemberAfterConflict: (...args: unknown[]) => mockSeated(...args),
    resolveActor: (...args: unknown[]) => mockResolveActor(...args),
  };
});

const { MlsEstablishStep, MlsWelcomeRefusedError, MlsMembershipOutcome } = await import(
  "@rine-network/core"
);
const { joinGroup } = await import("../../src/tools/group-join.js");

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const JOINER_ID = "joiner-1";
const OTHER_GROUP_ID = "22222222-2222-2222-2222-222222222222";
const MEMBER_ROW = { agent_id: JOINER_ID, role: "member" };

/** The refusal the guard mints, as the establishment raises it. */
function refusal(groupId: string) {
  return new MlsWelcomeRefusedError(
    groupId,
    "roster_uncorroborated",
    `Refusing the MLS welcome for group ${groupId}: the group's roster names no member holding a leaf in the ratchet tree this welcome seats the agent in.`,
  );
}

/** The 409 the server answers an agent that is already a member. */
function alreadyAMember() {
  return Object.assign(new Error("already a member"), {
    status: 409,
    code: "already_a_member",
  });
}

function outcome(
  o: string,
  extra: Record<string, unknown> = {},
): { outcome: string } {
  return { outcome: o, ...extra };
}

function makeCtx(
  post: () => Promise<unknown> = async () => MEMBER_ROW,
): ToolContext {
  return {
    client: {
      get: vi.fn().mockResolvedValue({ items: [MEMBER_ROW] }),
      post: vi.fn().mockImplementation(post),
    } as never,
    configDir: "/tmp/test",
    apiUrl: "https://api.test",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockSeated.mockResolvedValue(null);
  mockEstablish.mockResolvedValue(outcome(MlsMembershipOutcome.Installed));
  mockResolveActor.mockResolvedValue({ agentId: JOINER_ID });
});

describe("rine_group_join — the establishment is rine-core's", () => {
  it("test_join_when_the_server_answers_200_then_the_shared_establishment_runs_for_the_group", async () => {
    const ctx = makeCtx();

    await expect(joinGroup(ctx, { group: GROUP_ID })).resolves.toEqual(
      MEMBER_ROW,
    );
    expect(mockEstablish).toHaveBeenCalledTimes(1);
    expect(mockEstablish).toHaveBeenCalledWith(
      "/tmp/test",
      JOINER_ID,
      GROUP_ID,
      ctx.client,
      { "X-Rine-Agent": JOINER_ID },
    );
  });

  it("test_join_when_the_server_answers_202_then_no_mls_step_runs", async () => {
    const pending = { status: "pending", request_id: "r1" };
    const ctx = makeCtx(async () => pending);

    await expect(joinGroup(ctx, { group: GROUP_ID })).resolves.toEqual(pending);
    expect(mockEstablish).not.toHaveBeenCalled();
  });
});

describe("rine_group_join — a refused Welcome fails the tool call", () => {
  it("test_join_when_this_groups_welcome_is_refused_then_the_tool_call_fails", async () => {
    mockEstablish.mockRejectedValue(refusal(GROUP_ID));

    await expect(
      joinGroup(makeCtx(), { group: GROUP_ID }),
    ).rejects.toMatchObject({
      code: "RINE_WELCOME_REFUSED",
      groupId: GROUP_ID,
    });
  });

  it("test_join_when_an_ordinary_mls_step_fails_then_it_still_only_warns", async () => {
    // The control arm: a transient failure must not start failing a tool call
    // whose server-side half has already succeeded.
    mockEstablish.mockResolvedValue(
      outcome(MlsMembershipOutcome.Failed, {
        reason: "socket hang up",
        failure: {
          step: MlsEstablishStep.WelcomeInstall,
          error: new Error("socket hang up"),
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(joinGroup(makeCtx(), { group: GROUP_ID })).resolves.toEqual(
      MEMBER_ROW,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("rine_group_join — a member with no local state is brought back", () => {
  // The 409 path is rine-core's `seatedMemberAfterConflict` (its own contract,
  // the members read included, is tested there); this tool fakes that one call
  // and owns the acting agent it hands over and the rendering.
  it("test_join_when_409_already_a_member_and_the_seat_is_restored_then_the_member_row_is_returned_without_a_second_establishment", async () => {
    mockSeated.mockResolvedValue(MEMBER_ROW);
    const conflict = alreadyAMember();
    const ctx = makeCtx(async () => {
      throw conflict;
    });

    await expect(joinGroup(ctx, { group: GROUP_ID })).resolves.toEqual(
      MEMBER_ROW,
    );
    expect(mockSeated).toHaveBeenCalledWith(
      conflict,
      expect.objectContaining({
        configDir: "/tmp/test",
        groupId: GROUP_ID,
        client: ctx.client,
      }),
      expect.any(Function),
    );
    const [, join] = mockSeated.mock.calls[0] ?? [];
    await expect(join.actingAgent()).resolves.toBe(JOINER_ID);
    // The helper is the one establishment on this path; the tool does not
    // run the ladder a second time for the row it returns.
    expect(mockEstablish).not.toHaveBeenCalled();
  });

  it("test_join_when_409_already_a_member_and_the_helper_declines_then_the_409_stands", async () => {
    mockSeated.mockResolvedValue(null);
    const ctx = makeCtx(async () => {
      throw alreadyAMember();
    });

    await expect(joinGroup(ctx, { group: GROUP_ID })).rejects.toMatchObject({
      status: 409,
      code: "already_a_member",
    });
    expect(mockEstablish).not.toHaveBeenCalled();
  });

  it("test_join_when_409_already_a_member_and_the_setup_fails_then_it_warns_once_and_the_409_stands", async () => {
    mockSeated.mockImplementation(async (_c, _j, onFailed) => {
      onFailed(
        outcome(MlsMembershipOutcome.Failed, {
          reason: "socket hang up",
          failure: {
            step: MlsEstablishStep.ExternalJoin,
            error: new Error("socket hang up"),
          },
        }),
      );
      return null;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx(async () => {
      throw alreadyAMember();
    });

    await expect(joinGroup(ctx, { group: GROUP_ID })).rejects.toMatchObject({
      status: 409,
      code: "already_a_member",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain("socket hang up");
    warn.mockRestore();
  });

  it("test_join_when_409_already_a_member_and_this_groups_welcome_is_refused_then_the_tool_call_fails", async () => {
    mockSeated.mockRejectedValue(refusal(GROUP_ID));
    const ctx = makeCtx(async () => {
      throw alreadyAMember();
    });

    await expect(joinGroup(ctx, { group: GROUP_ID })).rejects.toMatchObject({
      code: "RINE_WELCOME_REFUSED",
    });
  });

  it("test_join_when_the_409_has_another_code_then_it_is_raised_unchanged", async () => {
    const other = Object.assign(new Error("x"), {
      status: 409,
      code: "revoked_seat_unreclaimed",
    });
    const ctx = makeCtx(async () => {
      throw other;
    });

    await expect(joinGroup(ctx, { group: GROUP_ID })).rejects.toBe(other);
    expect(mockEstablish).not.toHaveBeenCalled();
  });
});
