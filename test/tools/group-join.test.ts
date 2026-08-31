/**
 * `rine_group_join` and the one MLS failure it does NOT swallow.
 *
 * Every MLS side-effect on this tool runs after the join POST has already
 * returned 200, so it warns on stderr rather than failing the call. There is
 * exactly one exception: a Welcome the group substitution guard
 * REFUSED for the group being joined. That is a security verdict about who
 * minted the Welcome; a warning on stderr is a place no model ever reads, and
 * `rine.groups.join()` on the Python SDK already raises the same refusal.
 *
 * A refusal naming a DIFFERENT group is still only a warning: the batch
 * installs every Welcome it can before raising, and that group's verdict is
 * not this join's to report.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mockProcessMlsWelcomes = vi.fn();
const mockLoadMlsState = vi.fn();
const mockExternalJoinMlsGroup = vi.fn();
const mockResolveActor = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rine-network/core")>();
  return {
    ...orig,
    processMlsWelcomes: (...args: unknown[]) => mockProcessMlsWelcomes(...args),
    loadMlsState: (...args: unknown[]) => mockLoadMlsState(...args),
    externalJoinMlsGroup: (...args: unknown[]) =>
      mockExternalJoinMlsGroup(...args),
    resolveActor: (...args: unknown[]) => mockResolveActor(...args),
  };
});

const { MlsWelcomeRefusedError } = await import("@rine-network/core");
const { joinGroup } = await import("../../src/tools/group-join.js");

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const JOINER_ID = "joiner-1";
const OTHER_GROUP_ID = "22222222-2222-2222-2222-222222222222";

/** The refusal the guard mints, as `processMlsWelcomes` raises it. */
function refusal(groupId: string) {
  return new MlsWelcomeRefusedError(
    groupId,
    "roster_uncorroborated",
    `Refusing the MLS welcome for group ${groupId}: the group's roster names ` +
      "no member holding a leaf in the ratchet tree this welcome seats the " +
      "agent in.",
  );
}

function makeCtx(): ToolContext {
  return {
    client: {
      get: vi.fn().mockResolvedValue({ id: GROUP_ID, mls_group_id: "latch" }),
      post: vi.fn().mockResolvedValue({ role: "member" }),
    } as never,
    configDir: "/tmp/test",
    apiUrl: "https://api.test",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockLoadMlsState.mockReturnValue(null);
  mockExternalJoinMlsGroup.mockResolvedValue({ epoch: 2 });
  // The joiner, in the shape the resolver answers in: an id and, when the
  // org's only agent acted on a value that named nobody, the note about it.
  mockResolveActor.mockResolvedValue({ agentId: JOINER_ID });
});

describe("rine_group_join — a refused Welcome fails the tool call", () => {
  it("test_join_when_this_groups_welcome_is_refused_then_the_tool_call_fails", async () => {
    mockProcessMlsWelcomes.mockRejectedValue(refusal(GROUP_ID));
    const ctx = makeCtx();

    await expect(joinGroup(ctx, { group: GROUP_ID })).rejects.toMatchObject({
      code: "RINE_WELCOME_REFUSED",
      groupId: GROUP_ID,
    });
    // And the substitution is not papered over by a self-join into whatever
    // the server would hand out next.
    expect(mockExternalJoinMlsGroup).not.toHaveBeenCalled();
  });

  it("test_join_when_another_groups_welcome_is_refused_then_the_join_result_is_returned", async () => {
    mockProcessMlsWelcomes.mockRejectedValue(refusal(OTHER_GROUP_ID));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx();

    await expect(joinGroup(ctx, { group: GROUP_ID })).resolves.toEqual({
      role: "member",
    });
    expect(mockExternalJoinMlsGroup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("test_join_when_an_ordinary_mls_step_fails_then_it_still_only_warns", async () => {
    // The control arm: a transient failure must not start failing a tool call
    // whose server-side half has already succeeded.
    mockProcessMlsWelcomes.mockRejectedValue(new Error("socket hang up"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx();

    await expect(joinGroup(ctx, { group: GROUP_ID })).resolves.toEqual({
      role: "member",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
