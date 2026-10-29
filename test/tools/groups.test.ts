import {
  ACTOR_SURFACES,
  GROUP_READERS_NOTICE,
  MlsEstablishStep,
  MlsMembershipOutcome,
  MlsWelcomeRefusedError,
  NOT_A_MEMBER_CLAUSE,
  RineApiError,
  SEATED_SIBLING_CLAUSE,
  handleCompletionNotes,
} from "@rine-network/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routedGet } from "./group-routes.js";
import type { ToolContext } from "../../src/tools/types.js";

const mockResolveToUuid = vi.fn();
const mockResolveActor = vi.fn();
const mockHoldsMlsState = vi.fn();
const mockEstablish = vi.fn();
const mockListMyInvites = vi.fn();
const mockSendGroupInviteNotification = vi.fn();
const mockInitMlsGroup = vi.fn();
const mockAddMlsGroupMember = vi.fn();
const mockResumeMlsGroupAdmission = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rine-network/core")>();
  return {
    ...orig,
    resolveToUuid: (...args: unknown[]) => mockResolveToUuid(...args),
    resolveActor: (...args: unknown[]) => mockResolveActor(...args),
    holdsMlsState: (...args: unknown[]) => mockHoldsMlsState(...args),
    establishMlsMembership: (...args: unknown[]) => mockEstablish(...args),
    listMyInvites: (...args: unknown[]) => mockListMyInvites(...args),
    initMlsGroup: (...args: unknown[]) => mockInitMlsGroup(...args),
    addMlsGroupMember: (...args: unknown[]) => mockAddMlsGroupMember(...args),
    resumeMlsGroupAdmission: (...args: unknown[]) =>
      mockResumeMlsGroupAdmission(...args),
    sendGroupInviteNotification: (...args: unknown[]) =>
      mockSendGroupInviteNotification(...args),
  };
});

const { groupTools: groupEntryTools } = await import(
  "../../src/tools/groups.js"
);
const { groupMemberTools } = await import("../../src/tools/groups-members.js");
const groupTools = [...groupEntryTools, ...groupMemberTools];
const { ACTING_AGENT_PARAM } = await import("../../src/tools/tool-actors.js");

const rineGroupCreate = groupTools.find((t) => t.name === "rine_group_create")!;
const rineGroupJoin = groupTools.find((t) => t.name === "rine_group_join")!;
const rineGroupRoster = groupTools.find(
  (t) => t.name === "rine_group_roster",
)!;
const rineGroupInvite = groupTools.find((t) => t.name === "rine_group_invite")!;
const rineGroups = groupTools.find((t) => t.name === "rine_groups")!;
const rineGroupInvites = groupTools.find(
  (t) => t.name === "rine_group_invites",
)!;

interface ToolSchema {
  properties: Record<string, { description: string; enum?: string[] }>;
  required?: string[];
}

const schemaOf = (name: string): ToolSchema =>
  groupTools.find((t) => t.name === name)!.inputSchema as unknown as ToolSchema;

const GROUP_ID = "11111111-1111-1111-1111-111111111111";

/**
 * The row `GET /groups/{id}` answers — a plain sender-key group.
 *
 * That route is the first read of every verb below that is handed a
 * UUID, so a test overriding `get` names this route explicitly (`routedGet`)
 * rather than answering its own payload to the resolver too.
 */
const GROUP_PATH = `/groups/${GROUP_ID}`;
const GROUP_ROW = { id: GROUP_ID, handle: "#team@acme" };

/**
 * A tool context whose GET answers a plain sender-key group by default, so a
 * test that is not about the group read does not have to stub one. Every test
 * that cares overrides it.
 */
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

const post = (ctx: ToolContext) => ctx.client.post as ReturnType<typeof vi.fn>;
const get = (ctx: ToolContext) => ctx.client.get as ReturnType<typeof vi.fn>;

/** The body of the nth POST this context made. */
const postedBody = (ctx: ToolContext, n = 0): Record<string, unknown> =>
  post(ctx).mock.calls[n]?.[1] as Record<string, unknown>;

describe("the MCP group tool inventory", () => {
  // The six verbs that establish membership. The verbs that act on an existing
  // membership — requests, vote, leave, remove, sync — are registered from
  // `groups-admin.ts` and asserted in that module's own suite, including the
  // fact that `index.ts` imports it (which is what makes them visible to the
  // shipped-surface gate at all).
  it("is exactly the six group tools that establish membership", () => {
    expect(groupTools.map((t) => t.name)).toEqual([
      "rine_groups",
      "rine_group_create",
      "rine_group_join",
      "rine_group_roster",
      "rine_group_invite",
      "rine_group_invites",
    ]);
  });
});

describe("the verbs that create and enter a group say who can read it", () => {
  it.each(["rine_group_create", "rine_group_join"])(
    "%s states the shared member-org disclosure",
    (name) => {
      const tool = groupTools.find((t) => t.name === name)!;
      expect(tool.description).toContain(GROUP_READERS_NOTICE);
    },
  );
});

describe("rine_group_create input schema", () => {
  it("marks visibility required, alongside name", () => {
    expect(schemaOf("rine_group_create").required).toEqual([
      "name",
      "visibility",
    ]);
  });

  it("offers exactly the two visibilities the server accepts", () => {
    expect(schemaOf("rine_group_create").properties.visibility?.enum).toEqual([
      "public",
      "private",
    ]);
  });

  // The model is told by the schema, not by a refusal, and what
  // it is told is enough to choose without reading docs — including the half
  // of the choice that is invisible today, that public turns the join signal
  // off.
  it("names both choices, the directory listing and the join-signal coupling", () => {
    const described =
      schemaOf("rine_group_create").properties.visibility?.description ?? "";
    expect(described).toContain("Required, no default");
    expect(described).toContain("dir.rine.network");
    expect(described).toMatch(/member-joined signal off/);
    expect(described).toMatch(/signalled when someone joins/);
  });

  it("offers a roster that invites rather than seats", () => {
    const described =
      schemaOf("rine_group_create").properties.members?.description ?? "";
    expect(described).toMatch(/invites; it never seats/);
  });

  it("does not imply the description field is private", () => {
    const described =
      schemaOf("rine_group_create").properties.description?.description ?? "";
    expect(described).toMatch(/server-side in the clear/);
    expect(described).toMatch(/not end-to-end encrypted/);
  });

  it("states the vote window's units and bounds and what it does", () => {
    const prop = schemaOf("rine_group_create").properties
      .vote_duration_hours as { description: string };
    expect(prop.description).toMatch(/hours/);
    expect(prop.description).toMatch(/1-72, default 72/);
    expect(prop.description).toMatch(/majority/);
    expect(prop.description).toMatch(/unanimity/);
  });
});

describe("rine_group_create", () => {
  beforeEach(() => {
    mockResolveActor.mockReset().mockResolvedValue({ agentId: "agent-123" });
    mockResolveToUuid.mockReset();
    mockInitMlsGroup
      .mockReset()
      .mockResolvedValue({ epoch: 1, commits: 1, added: 0, outcomes: [] });
  });

  it("founds MLS state for a closed group", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "closed" });

    await rineGroupCreate.handler(ctx, {
      name: "my-group",
      visibility: "private",
    });

    expect(mockInitMlsGroup).toHaveBeenCalledWith(
      "/tmp/test",
      "agent-123",
      "11111111-1111-1111-1111-111111111111",
      ctx.client,
      { "X-Rine-Agent": "agent-123" },
    );
  });

  it("does NOT attempt MLS for an open-enrollment group", async () => {
    // The server refuses MLS on open enrollment (403
    // mls_open_enrollment_disabled), so the attempt could only ever fail —
    // and the operator would see a warning about a group that is working as
    // intended. Same skip as the CLI, the TS SDK and the Python SDK.
    const ctx = makeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "open" });

    await rineGroupCreate.handler(ctx, {
      name: "open-group",
      enrollment: "open",
      visibility: "public",
    });

    expect(mockInitMlsGroup).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("passes the stated visibility through verbatim", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupCreate.handler(ctx, {
      name: "private-group",
      enrollment: "closed",
      visibility: "private",
    });

    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups",
      {
        name: "private-group",
        enrollment_policy: "closed",
        visibility: "private",
      },
      { "X-Rine-Agent": "agent-123" },
    );
  });

  // There is no smart default. An omitted visibility is NOT filled in
  // as public-for-open/private-otherwise — the request goes without one and
  // the server answers in rine's own words, naming both choices.
  it("derives no visibility for an open group when none was stated", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupCreate.handler(ctx, {
      name: "open-group",
      enrollment: "open",
    });

    expect(postedBody(ctx)).not.toHaveProperty("visibility");
  });

  it("derives no visibility for a closed group when none was stated", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupCreate.handler(ctx, { name: "my-group" });

    expect(postedBody(ctx)).not.toHaveProperty("visibility");
  });

  it("forwards a stated description and vote_duration_hours to the server", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupCreate.handler(ctx, {
      name: "voted-group",
      visibility: "private",
      description: "house rules go here",
      vote_duration_hours: 1,
    });

    expect(postedBody(ctx)).toMatchObject({
      description: "house rules go here",
      vote_duration_hours: 1,
    });
  });

  it("omits description and vote_duration_hours when neither was stated", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupCreate.handler(ctx, {
      name: "plain-group",
      visibility: "private",
    });

    expect(postedBody(ctx)).not.toHaveProperty("description");
    expect(postedBody(ctx)).not.toHaveProperty("vote_duration_hours");
  });

  it("resolves agent and sets X-Rine-Agent header when agent is provided", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "agent-456" });
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupCreate.handler(ctx, {
      name: "my-group",
      visibility: "private",
      agent: "mybot",
    });

    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups",
      { name: "my-group", visibility: "private" },
      { "X-Rine-Agent": "agent-456" },
    );
  });
});

describe("rine_group_create with a roster", () => {
  beforeEach(() => {
    mockResolveActor.mockReset().mockResolvedValue({ agentId: "founder" });
    mockResolveToUuid
      .mockReset()
      .mockImplementation(async (_url: string, value: string) =>
        value.replace("@acme", "-uuid"),
      );
    mockInitMlsGroup
      .mockReset()
      .mockResolvedValue({ epoch: 1, commits: 1, added: 2, outcomes: [] });
  });

  it("resolves handles to UUIDs and posts them as members, in request order", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({
      group: { id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "closed" },
      roster: { invited: 2, skipped: 0, entries: [] },
    });

    await rineGroupCreate.handler(ctx, {
      name: "team",
      visibility: "private",
      members: ["ana@acme", "ben@acme"],
    });

    expect(postedBody(ctx).members).toEqual(["ana-uuid", "ben-uuid"]);
  });

  // With a roster the create answer is {group, roster}. The MLS founding
  // has to key off the unwrapped group, or it founds nothing.
  it("unwraps {group, roster} before founding MLS", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({
      group: { id: "g9", enrollment_policy: "closed" },
      roster: { invited: 1, skipped: 0, entries: [] },
    });

    await rineGroupCreate.handler(ctx, {
      name: "team",
      visibility: "private",
      members: ["ana@acme"],
    });

    expect(mockInitMlsGroup).toHaveBeenCalledWith(
      "/tmp/test",
      "founder",
      "g9",
      ctx.client,
      { "X-Rine-Agent": "founder" },
    );
  });

  it("reports the group, the server's roster outcomes and the MLS admission", async () => {
    const ctx = makeCtx();
    const roster = {
      invited: 1,
      skipped: 1,
      entries: [
        { agent_id: "ana-uuid", status: "invited" },
        { agent_id: "ben-uuid", status: "skipped", reason: "already_a_member" },
      ],
    };
    post(ctx).mockResolvedValue({
      group: { id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "closed" },
      roster,
    });

    const result = await rineGroupCreate.handler(ctx, {
      name: "team",
      visibility: "private",
      members: ["ana@acme", "ben@acme"],
    });

    // A skip carries the sentence beside the wire token, never instead of
    // it — the model gets the fact and the machine-readable reason both.
    //
    // The completion notice rides in the same object, on this fixture's own
    // short spellings: the notice is DERIVED from `@rine-network/core`, never
    // retyped, so the full-shape pin cannot drift away from the sentence the
    // other three surfaces print. Its own arms are below.
    expect(result).toEqual({
      handle_completion: handleCompletionNotes(["ana@acme", "ben@acme"]),
      group: { id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "closed" },
      roster: {
        invited: 1,
        skipped: 1,
        entries: [
          { agent_id: "ana-uuid", status: "invited" },
          {
            agent_id: "ben-uuid",
            status: "skipped",
            reason: "already_a_member",
            reason_explained: "already a member of this group",
          },
        ],
      },
      mls: { epoch: 1, commits: 1, added: 2, outcomes: [] },
    });
  });

  // A founding roster is where a silent completion does the most
  // damage and hides the best — one rewritten name among twenty seats itself,
  // and every later read of the group agrees with the seat rather than with
  // what was typed.
  it("says nothing when every rostered spelling was already whole", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({
      group: { id: "g9", enrollment_policy: "closed" },
      roster: { invited: 2, skipped: 0, entries: [] },
    });

    const result = await rineGroupCreate.handler(ctx, {
      name: "team",
      visibility: "private",
      members: ["ana@acme.rine.network", "ben@acme.rine.network"],
    });

    expect(result).not.toHaveProperty("handle_completion");
  });

  // Only the rewritten ones, and the roster the server answered is untouched
  // beside it — the notice is a caveat about WHICH agents were admitted, never
  // a substitute for the admission report.
  it("names only the rostered spellings that were rewritten", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({
      group: { id: "g9", enrollment_policy: "closed" },
      roster: { invited: 2, skipped: 0, entries: [] },
    });

    const result = (await rineGroupCreate.handler(ctx, {
      name: "team",
      visibility: "private",
      members: ["ana@acme", "ben@acme.rine.network"],
    })) as Record<string, unknown>;

    expect(result.handle_completion).toBe(handleCompletionNotes(["ana@acme"]));
    expect(result.roster).toMatchObject({ invited: 2, skipped: 0 });
  });

  // The create response shape without a roster is byte-identical to what it
  // has always been, so every existing caller of this tool is unaffected.
  it("returns a bare group when no roster was named", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "closed" });

    const result = await rineGroupCreate.handler(ctx, {
      name: "team",
      visibility: "private",
    });

    expect(result).toEqual({ id: "11111111-1111-1111-1111-111111111111", enrollment_policy: "closed" });
    expect(postedBody(ctx)).not.toHaveProperty("members");
  });
});

describe("rine_group_join", () => {
  beforeEach(() => {
    mockResolveActor.mockReset().mockResolvedValue({ agentId: "joiner" });
    mockEstablish.mockReset().mockResolvedValue({ outcome: MlsMembershipOutcome.NotMls });
  });

  it("posts to correct group join path", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({});
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupJoin.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(ctx.client.post).toHaveBeenCalledWith("/groups/11111111-1111-1111-1111-111111111111/join", {}, {
      "X-Rine-Agent": "joiner",
    });
  });

  it("includes message when provided", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({});
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupJoin.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", message: "hello" });

    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/join",
      { message: "hello" },
      { "X-Rine-Agent": "joiner" },
    );
  });

  it("resolves agent and sets X-Rine-Agent header when agent is provided", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "agent-456" });
    post(ctx).mockResolvedValue({});
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });

    await rineGroupJoin.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", agent: "mybot" });

    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/join",
      {},
      { "X-Rine-Agent": "agent-456" },
    );
  });

  it("asks the shared establishment for the joiner's state, scoped to the named group", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "agent-self" });
    post(ctx).mockResolvedValue({ agent_id: "agent-self", role: "member" });
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", mls_group_id: "mls-latch" });

    await rineGroupJoin.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    // The group id the caller named, never one the server answered with: the
    // establishment scopes its Welcome pass to it.
    expect(mockEstablish).toHaveBeenCalledWith(
      "/tmp/test",
      "agent-self",
      "11111111-1111-1111-1111-111111111111",
      ctx.client,
      { "X-Rine-Agent": "agent-self" },
    );
  });

  it.each([
    MlsMembershipOutcome.Installed,
    MlsMembershipOutcome.Held,
    MlsMembershipOutcome.Reseated,
    MlsMembershipOutcome.ExternalJoined,
  ])(
    "runs the establishment once and returns the join answer when it ends %s",
    async (outcome) => {
      const ctx = makeCtx();
      const row = { agent_id: "agent-self", role: "member" };
      mockResolveActor.mockResolvedValue({ agentId: "agent-self" });
      post(ctx).mockResolvedValue(row);
      get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", mls_group_id: "mls-latch" });
      mockEstablish.mockResolvedValue({ outcome });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await rineGroupJoin.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

      expect(result).toEqual(row);
      expect(mockEstablish).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    },
  );

  it("leaves a non-MLS (sender-key) group with an establishment that reports not_mls and no warning", async () => {
    const ctx = makeCtx();
    const row = { agent_id: "agent-self", role: "member" };
    mockResolveActor.mockResolvedValue({ agentId: "agent-self" });
    post(ctx).mockResolvedValue(row);
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await rineGroupJoin.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(result).toEqual(row);
    expect(mockEstablish).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("swallows a failed establishment (best-effort) and still returns the join result", async () => {
    const ctx = makeCtx();
    const row = { agent_id: "agent-self", role: "member" };
    mockResolveActor.mockResolvedValue({ agentId: "agent-self" });
    post(ctx).mockResolvedValue(row);
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", mls_group_id: "mls-latch" });
    mockEstablish.mockResolvedValue({
      outcome: MlsMembershipOutcome.Failed,
      reason: "epoch conflict",
      failure: { step: MlsEstablishStep.ExternalJoin, error: new Error("epoch conflict") },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await rineGroupJoin.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(result).toEqual(row);
    expect(mockEstablish).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain("epoch conflict");
    warn.mockRestore();
  });

  /**
   * The establishment's scoped Welcome pass answers about the named group only
   * (tested against the real native core in rine-core), so a refusal it raises
   * for that group fails the call, with no self-join into whatever the server
   * would hand out next.
   */
  it("test_join_when_the_establishment_raises_this_groups_refusal_then_the_tool_call_fails_with_it", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "agent-self" });
    post(ctx).mockResolvedValue({ agent_id: "agent-self", role: "member" });
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", mls_group_id: "mls-latch" });
    mockEstablish.mockRejectedValue(
      new MlsWelcomeRefusedError(
        "11111111-1111-1111-1111-111111111111",
        "roster_uncorroborated",
        "Refusing the MLS welcome for group 11111111-1111-1111-1111-111111111111: the roster names nobody.",
      ),
    );

    await expect(
      rineGroupJoin.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toMatchObject({ code: "RINE_WELCOME_REFUSED", groupId: "11111111-1111-1111-1111-111111111111" });
    expect(mockEstablish).toHaveBeenCalledTimes(1);
  });
});

describe("rine_group_roster", () => {
  beforeEach(() => {
    mockResolveActor.mockReset().mockResolvedValue({ agentId: "reader" });
    mockHoldsMlsState.mockReset().mockReturnValue(false);
  });

  it("fetches members for group", async () => {
    const ctx = makeCtx();
    const members = [{ agent_id: "a1", role: "admin" }];
    // `GroupMemberListResponse` always carries `total`.
    get(ctx).mockImplementation(
      routedGet({ [GROUP_PATH]: GROUP_ROW }, { items: members, total: 1 }),
    );

    const result = await rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    expect(ctx.client.get).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/members",
      undefined,
      {},
    );
    expect(result).toEqual({ items: members, total: 1 });
  });

  // The tool advertised the acting agent and then read it only in the
  // catch, so a multi-agent org's roster read was answered for whichever agent
  // the server picked. The value the caller named now reaches the request.
  it("sends X-Rine-Agent for the agent the caller named", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "agent-456" });
    get(ctx).mockImplementation(
      routedGet({ [GROUP_PATH]: GROUP_ROW }, { items: [] }),
    );

    await rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", agent: "mybot" });

    // No `apiUrl`: the actor ladder resolves every spelling against the org's
    // own agent list, so it holds nothing it could reach WebFinger with.
    expect(mockResolveActor).toHaveBeenCalledWith(
      ctx.client,
      "mybot",
      undefined,
      ACTOR_SURFACES.mcp,
      // Where the value came from, carried down: the tool read it off the call,
      // so a one-agent fallback's warning names the parameter and not RINE_AGENT.
      "argument",
    );
    expect(ctx.client.get).toHaveBeenCalledWith("/groups/11111111-1111-1111-1111-111111111111/members", undefined, {
      "X-Rine-Agent": "agent-456",
    });
  });

  // An eviction moves the group's epoch past this agent's leaf.
  // Holding local MLS state for a group the server will not let it read means
  // it was in the group and is not now.
  //
  // `Access denied` is the sentence this route really sends: the roster is
  // gated by `has_read_access`, which is org-level and names nobody. It is
  // also the negative case — a refusal carrying no membership clause is still
  // read as an eviction, and only the clause-bearing arms below are not.
  it("tells an agent that holds MLS state it was removed, not that it is a stranger", async () => {
    const ctx = makeCtx();
    mockHoldsMlsState.mockReturnValue(true);
    // 🔴 The refusal is pinned to the MEMBERS route. The resolver reads
    // `/groups/{id}` first and folds a 403 there into its own roster refusal,
    // so a blanket rejection would assert the resolver's sentence while naming
    // this verb's.
    get(ctx).mockImplementation(
      routedGet({ [GROUP_PATH]: GROUP_ROW }, new RineApiError(403, "Access denied")),
    );

    await expect(
      rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/You were removed from group 11111111-1111-1111-1111-111111111111/);
  });

  it("names re-invitation as the way back and says delivered mail still opens", async () => {
    const ctx = makeCtx();
    mockHoldsMlsState.mockReturnValue(true);
    get(ctx).mockImplementation(
      routedGet({ [GROUP_PATH]: GROUP_ROW }, new RineApiError(403, "Access denied")),
    );

    await expect(
      rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/invite you again/);
    await expect(
      rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/already reached your inbox still open/);
  });

  it("leaves the server's own refusal alone for an agent that was never a member", async () => {
    const ctx = makeCtx();
    const refusal = new RineApiError(403, "Access denied");
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, refusal));

    await expect(
      rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toBe(refusal);
  });

  it("leaves a non-API failure alone", async () => {
    const ctx = makeCtx();
    const boom = new Error("socket hang up");
    mockHoldsMlsState.mockReturnValue(true);
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, boom));

    await expect(
      rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toBe(boom);
  });

  it("leaves a server error that is not an access refusal alone", async () => {
    const ctx = makeCtx();
    const boom = new RineApiError(500, "Internal error");
    mockHoldsMlsState.mockReturnValue(true);
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, boom));

    await expect(
      rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toBe(boom);
  });

  // The server's membership gate refuses a caller whose ACTING agent
  // holds no seat — which fires while a SIBLING agent of the same org is
  // sitting in the group. Nobody was evicted there and the remedy is one
  // `agent` argument, so claiming an eviction would be a lie in exactly the
  // case this arm exists to get right.
  it("does not call a sibling-seat refusal an eviction, even holding MLS state", async () => {
    const ctx = makeCtx();
    mockHoldsMlsState.mockReturnValue(true);
    const refusal = new RineApiError(
      403,
      `agent ops-bot ${NOT_A_MEMBER_CLAUSE}; your agent sales-bot is — ` +
        `${SEATED_SIBLING_CLAUSE}: sales@acme.rine.network`,
    );
    get(ctx).mockImplementation(routedGet({ [GROUP_PATH]: GROUP_ROW }, refusal));

    await expect(
      rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toBe(refusal);
  });

  it("marks this org's own members, and lists the whole roster regardless", async () => {
    const ctx = makeCtx();
    const page = {
      items: [
        { agent_id: "mine-1", role: "admin", is_own_org: true },
        { agent_id: "theirs-1", role: "member", is_own_org: false },
      ],
      total: 2,
    };
    // 🔴 Two reads, two routes. A blanket stub answered the members page to the
    // resolver's `GET /groups/{id}` as well, so the group row it read carried
    // no `id` — the shape `group-routes.ts` exists to prevent, and one no real
    // server can send (`GroupRead.id` is a required `uuid.UUID`). It passed
    // only because the same blanket answer also served
    // `/groups/undefined/members`, so this test never exercised the group read
    // at all.
    get(ctx).mockImplementation(
      routedGet({ [GROUP_PATH]: GROUP_ROW, [`${GROUP_PATH}/members`]: page }),
    );

    const result = await rineGroupRoster.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" });

    // A marker, never a filter: the row whose `is_own_org` is false is still
    // here, and `total` still counts it.
    expect(result).toEqual(page);
  });

  it("tells a model is_own_org marks rather than filters", () => {
    expect(rineGroupRoster.description).toContain("is_own_org");
    expect(rineGroupRoster.description).toMatch(/never a filter/);
  });
});

describe("rine_group_invite", () => {
  beforeEach(() => {
    mockResolveToUuid.mockReset();
    mockResolveActor.mockReset();
    mockAddMlsGroupMember.mockReset().mockResolvedValue({ epoch: 2 });
    mockResumeMlsGroupAdmission.mockReset();
    mockSendGroupInviteNotification.mockReset().mockResolvedValue(undefined);
  });

  it("resolves agent handle then posts invite", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("agent-uuid");
    post(ctx).mockResolvedValue({});

    await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitee: "bot@org.rine.network",
    });

    expect(mockResolveToUuid).toHaveBeenCalledWith(
      "https://api.test",
      "bot@org.rine.network",
    );
    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/invite",
      { agent_id: "agent-uuid" },
      {},
    );
  });

  it("includes message in invite", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("agent-uuid");
    post(ctx).mockResolvedValue({});

    await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitee: "agent-uuid",
      message: "join us",
    });

    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/invite",
      { agent_id: "agent-uuid", message: "join us" },
      {},
    );
  });

  it("resolves acting agent and sets X-Rine-Agent header when agent is provided", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("target-uuid");
    mockResolveActor.mockResolvedValue({ agentId: "actor-789" });
    post(ctx).mockResolvedValue({});

    await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitee: "target@org.rine.network",
      agent: "mybot",
    });

    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/invite",
      { agent_id: "target-uuid" },
      { "X-Rine-Agent": "actor-789" },
    );
  });

  it("best-effort sends the rine.v1.group_invite notification to the invitee", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("invitee-uuid");
    mockResolveActor.mockResolvedValue({ agentId: "inviter-uuid" });
    post(ctx).mockResolvedValue({});
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", handle: "#team@acme" });

    await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitee: "bot@acme",
      message: "join us",
    });

    expect(mockSendGroupInviteNotification).toHaveBeenCalledWith(
      ctx.client,
      "/tmp/test",
      "inviter-uuid",
      "invitee-uuid",
      { group_id: "11111111-1111-1111-1111-111111111111", group_handle: "#team@acme", message: "join us" },
    );
  });

  it("passes message:null to the notification when no message is given", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("invitee-uuid");
    mockResolveActor.mockResolvedValue({ agentId: "inviter-uuid" });
    post(ctx).mockResolvedValue({});
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", handle: "#team@acme" });

    await rineGroupInvite.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", invitee: "bot@acme" });

    expect(mockSendGroupInviteNotification).toHaveBeenCalledWith(
      ctx.client,
      "/tmp/test",
      "inviter-uuid",
      "invitee-uuid",
      { group_id: "11111111-1111-1111-1111-111111111111", group_handle: "#team@acme", message: null },
    );
  });

  it("swallows notification errors (best-effort) and still returns the invite voucher", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("invitee-uuid");
    mockResolveActor.mockResolvedValue({ agentId: "inviter-uuid" });
    post(ctx).mockResolvedValue({ id: "req-1" });
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", handle: "#team@acme" });
    mockSendGroupInviteNotification.mockRejectedValue(
      new Error("groups_only 403"),
    );

    // A WHOLE handle, so this stays a byte-exact pin on the voucher. The
    // completion notice is owed only where a spelling was rewritten, and this
    // arm is about the tail neither adding to the voucher nor taking it away —
    // with `bot@acme` it would also be asserting the notice, and a failure
    // could no longer tell the two properties apart. That the answer is
    // byte-identical when nothing was completed is itself the rule
    // `withHandleCompletionNote` is written to (it is why the notice stays off
    // every green path), so this arm covers it here too.
    const result = await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitee: "bot@acme.rine.network",
    });

    expect(result).toEqual({ id: "req-1" });
  });

  // 🔴 Re-scoped twice, and the second re-scoping is what the fold cost. The
  // resolver puts `/groups/{id}` in front of the reference, so a row this
  // caller cannot read refuses the invite before a voucher is ever written; the
  // arm that survived was a reference resolved through the org list with the
  // tail's own row read faulting behind it — and that read is now gone, because
  // the tail takes the row the resolve already paid for. What is left inside
  // the tail's `catch` is the acting agent, so that is what this faults, and
  // the property is unchanged: the server wrote the voucher, and nothing in the
  // best-effort tail may take it away.
  it("still returns the voucher when the tail faults (best-effort)", async () => {
    const ctx = makeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockResolveToUuid.mockResolvedValue("invitee-uuid");
    mockResolveActor.mockRejectedValue(new Error("no agent in this org"));
    post(ctx).mockResolvedValue({ id: "req-1" });
    // No fallback: the only read this arm makes is the reference resolving
    // through the org list, so `routedGet`'s own default stands guard — a second
    // route appearing here would name itself rather than be answered by a
    // "gateway timeout" this test never provoked and does not assert on. What
    // faults is the acting agent, above.
    get(ctx).mockImplementation(routedGet({ "/groups": { items: [GROUP_ROW] } }));

    // Whole handles on both, for the reason given on the arm above.
    const result = await rineGroupInvite.handler(ctx, {
      group: "#team@acme.rine.network",
      invitee: "bot@acme.rine.network",
    });

    expect(result).toEqual({ id: "req-1" });
    expect(mockSendGroupInviteNotification).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // 🔴 The fold, pinned by a count. The invite tail used to re-read
  // `GET /groups/{id}` after the POST to decide whether the row it had just
  // written confers a seat; it now asks the row the reference resolved through.
  // A second read would be the same group twice with the invite in between, and
  // the answer it acted on would be the one nothing else in the call had seen.
  it("asks the group's own route once, and not again after the invite", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("invitee-uuid");
    mockResolveActor.mockResolvedValue({ agentId: "inviter-uuid" });
    post(ctx).mockResolvedValue({ id: "req-1" });

    await rineGroupInvite.handler(ctx, { group: GROUP_ID, invitee: "bot@acme" });

    expect(get(ctx).mock.calls.map((c) => c[0] as string)).toEqual([GROUP_PATH]);
    expect(mockSendGroupInviteNotification).toHaveBeenCalledTimes(1);
  });

  // The completion notice on the singular arm. `resolveToUuid` is mocked to one
  // UUID for every spelling on purpose: what the notice reports is what the
  // CALLER typed, and it must not be derivable from the lookup's answer. The
  // sentence comes from `@rine-network/core` and is retyped nowhere.
  it("reports a completed invitee spelling beside the voucher", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("invitee-uuid");
    mockResolveActor.mockResolvedValue({ agentId: "inviter-uuid" });
    post(ctx).mockResolvedValue({ id: "req-1", status: "invited" });

    const result = await rineGroupInvite.handler(ctx, {
      group: GROUP_ID,
      invitee: "bot@acme",
    });

    expect(result).toEqual({
      id: "req-1",
      status: "invited",
      handle_completion: handleCompletionNotes(["bot@acme"]),
    });
  });

  it("uses the single-add MLS verb for one agent", async () => {
    const ctx = makeCtx();
    mockResolveToUuid.mockResolvedValue("invitee-uuid");
    mockResolveActor.mockResolvedValue({ agentId: "inviter-uuid" });
    post(ctx).mockResolvedValue({ id: "req-1" });
    get(ctx).mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
      handle: "#team@acme",
      mls_group_id: "latch",
    });

    await rineGroupInvite.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", invitee: "bot@acme" });

    expect(mockAddMlsGroupMember).toHaveBeenCalledWith(
      "/tmp/test",
      "inviter-uuid",
      "11111111-1111-1111-1111-111111111111",
      "invitee-uuid",
      ctx.client,
      { "X-Rine-Agent": "inviter-uuid" },
    );
    expect(mockResumeMlsGroupAdmission).not.toHaveBeenCalled();
  });
});

describe("rine_group_invite with a batch", () => {
  const report = {
    invited: 2,
    skipped: 1,
    entries: [
      { agent_id: "ana-uuid", status: "invited" },
      { agent_id: "ben-uuid", status: "invited" },
      { agent_id: "cleo-uuid", status: "skipped", reason: "already_a_member" },
    ],
  };

  beforeEach(() => {
    mockResolveToUuid
      .mockReset()
      .mockImplementation(async (_url: string, value: string) =>
        value.replace("@acme", "-uuid"),
      );
    mockResolveActor.mockReset().mockResolvedValue({ agentId: "inviter-uuid" });
    mockAddMlsGroupMember.mockReset();
    mockResumeMlsGroupAdmission.mockReset().mockResolvedValue({
      epoch: 7,
      commits: 1,
      added: 2,
      outcomes: [
        { agentId: "ana-uuid", status: "added" },
        { agentId: "ben-uuid", status: "added" },
      ],
    });
    mockSendGroupInviteNotification.mockReset().mockResolvedValue(undefined);
  });

  it("posts agent_ids and returns the server's per-member report", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue(report);
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", handle: "#team@acme" });

    const result = await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitees: ["ana@acme", "ben@acme", "cleo@acme"],
    });

    expect(ctx.client.post).toHaveBeenCalledWith(
      "/groups/11111111-1111-1111-1111-111111111111/invite",
      { agent_ids: ["ana-uuid", "ben-uuid", "cleo-uuid"] },
      {},
    );
    expect(result).toMatchObject({ invited: 2, skipped: 1 });
    // Every entry the server sent, in order, with a skip's reason also said in
    // a sentence — `not_applicable` printed raw read as a refusal on
    // exactly the groups it is not one for.
    expect((result as { entries: unknown[] }).entries).toEqual(
      report.entries.map((entry) =>
        entry.status === "skipped"
          ? { ...entry, reason_explained: expect.any(String) }
          : entry,
      ),
    );
  });

  // Resume IS the add path over the still-unseated invitees, so the
  // batch verb runs it. This is how a founding that stopped partway is
  // finished from MCP, without a tool name of its own.
  it("runs the resume verb for an MLS group and reports the admission", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue(report);
    get(ctx).mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
      handle: "#team@acme",
      mls_group_id: "latch",
    });

    const result = await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitees: ["ana@acme", "ben@acme", "cleo@acme"],
    });

    expect(mockResumeMlsGroupAdmission).toHaveBeenCalledWith(
      "/tmp/test",
      "inviter-uuid",
      "11111111-1111-1111-1111-111111111111",
      ctx.client,
      { "X-Rine-Agent": "inviter-uuid" },
    );
    expect(mockAddMlsGroupMember).not.toHaveBeenCalled();
    expect((result as { mls: { added: number } }).mls.added).toBe(2);
  });

  it("does not touch MLS for a sender-key group", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue(report);
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", handle: "#team@acme" });

    await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitees: ["ana@acme", "ben@acme"],
    });

    expect(mockResumeMlsGroupAdmission).not.toHaveBeenCalled();
  });

  it("notifies only the agents the server actually invited", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue(report);
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", handle: "#team@acme" });

    await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitees: ["ana@acme", "ben@acme", "cleo@acme"],
    });

    expect(mockSendGroupInviteNotification).toHaveBeenCalledTimes(2);
    expect(
      mockSendGroupInviteNotification.mock.calls.map((call) => call[3]),
    ).toEqual(["ana-uuid", "ben-uuid"]);
  });

  it("keeps notifying the rest when one invitee's notification fails", async () => {
    const ctx = makeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    post(ctx).mockResolvedValue(report);
    get(ctx).mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", handle: "#team@acme" });
    mockSendGroupInviteNotification
      .mockRejectedValueOnce(new Error("no keys"))
      .mockResolvedValue(undefined);

    await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitees: ["ana@acme", "ben@acme"],
    });

    expect(mockSendGroupInviteNotification).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("refuses a request that names both invitee and invitees", async () => {
    const ctx = makeCtx();

    await expect(
      rineGroupInvite.handler(ctx, {
        group: "11111111-1111-1111-1111-111111111111",
        invitee: "ana@acme",
        invitees: ["ben@acme"],
      }),
    ).rejects.toThrow(/exactly one of invitee .* or invitees/);
    expect(ctx.client.post).not.toHaveBeenCalled();
  });

  // `agent` named the invitee here until the rename, so the caller most
  // likely to hit this refusal is one carrying the retired shape. A bare
  // "missing required parameter" would leave it to guess which name moved.
  it("refuses a request that names neither, and says where the invitee went", async () => {
    const ctx = makeCtx();

    await expect(
      rineGroupInvite.handler(ctx, { group: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(
      "invitee is required, or invitees for a batch. Note agent now names " +
        "the acting agent on this tool; the agent being invited goes in " +
        "invitee.",
    );
    expect(ctx.client.post).not.toHaveBeenCalled();
  });

  // The refusal fires before anything resolves, selects or records an
  // acting agent. The stale shape below is the exact hazard — `agent` holds an
  // invitee id and would otherwise be read as a real, resolvable actor. Swap
  // the two statements in `inviteToGroup` and this test goes red on the
  // resolver spies, which is the point of asserting them rather than the throw.
  it("refuses before it resolves an acting agent, even when agent looks resolvable", async () => {
    const ctx = makeCtx();

    await expect(
      rineGroupInvite.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", agent: "ana@acme" }),
    ).rejects.toThrow(/invitee is required/);
    expect(mockResolveActor).not.toHaveBeenCalled();
    expect(mockResolveToUuid).not.toHaveBeenCalled();
    expect(ctx.client.post).not.toHaveBeenCalled();
  });

  it("refuses an empty batch, naming what the field should hold", async () => {
    const ctx = makeCtx();

    await expect(
      rineGroupInvite.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", invitees: [] }),
    ).rejects.toThrow(/invitees must be a non-empty list of agent handles/);
    expect(ctx.client.post).not.toHaveBeenCalled();
  });

  // The completion notice on the batch arm. `invitees` is the shape a model
  // reaches for when it has a list of names it half-remembers, so it is the
  // likeliest place for a completion to go unnoticed — and the server's
  // per-member report answers in UUIDs, which agree with the completion rather
  // than with the spelling.
  it("names each rewritten spelling in the batch, and no others", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue(report);
    get(ctx).mockResolvedValue({ id: GROUP_ID, handle: "#team@acme" });

    const result = (await rineGroupInvite.handler(ctx, {
      group: GROUP_ID,
      invitees: ["ana@acme", "ben@acme.rine.network", "cleo@acme"],
    })) as Record<string, unknown>;

    expect(result.handle_completion).toBe(
      handleCompletionNotes(["ana@acme", "cleo@acme"]),
    );
    expect(result.handle_completion).not.toContain("ben@");
    expect(result).toMatchObject({ invited: 2, skipped: 1 });
  });

  it("says nothing when every invitee spelling was already whole", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue(report);
    get(ctx).mockResolvedValue({ id: GROUP_ID, handle: "#team@acme" });

    const result = await rineGroupInvite.handler(ctx, {
      group: GROUP_ID,
      invitees: ["ana@acme.rine.network", "ben@acme.rine.network"],
    });

    expect(result).not.toHaveProperty("handle_completion");
  });

  // The invitee fields are named `invitee`/`invitees`, and `agent` — which used
  // to be the invitee — is the acting agent. Asserting only that `agent` exists
  // would stay green on the pre-rename shape, which is the whole trap here.
  it("offers the invitee fields in the input schema, and agent as the actor", () => {
    const schema = schemaOf("rine_group_invite");
    expect(schema.properties.invitees).toBeDefined();
    expect(schema.properties.invitee).toBeDefined();
    expect(schema.properties.agents).toBeUndefined();
    expect(schema.properties.agent.description).toBe(
      ACTING_AGENT_PARAM.description,
    );
    expect(schema.required).toEqual(["group"]);
  });
});

// An invite to a voting group NOMINATES, and a nomination
// posts no MLS commit. `invitedIds` counts `nominated` entries, so it answers
// "who was reached and is owed a notice" and not "who gets a leaf": handing it
// to an MLS verb without asking the group's policy first would Welcome an agent
// the electorate may still refuse. Both halves are asserted in every arm — no
// commit, and the notice still sent — and the `closed` arms are controls, so a
// pass is attributable to the policy rather than to a dead mock.

describe("rine_group_invite — a nomination posts no commit", () => {
  const nominations = {
    invited: 2,
    skipped: 0,
    entries: [
      { agent_id: "ana-uuid", status: "nominated" },
      { agent_id: "ben-uuid", status: "nominated" },
    ],
  };

  beforeEach(() => {
    mockResolveToUuid
      .mockReset()
      .mockImplementation(async (_url: string, value: string) =>
        value.replace("@acme", "-uuid"),
      );
    mockResolveActor.mockReset().mockResolvedValue({ agentId: "inviter-uuid" });
    mockAddMlsGroupMember.mockReset().mockResolvedValue({ epoch: 2 });
    mockResumeMlsGroupAdmission.mockReset().mockResolvedValue({
      epoch: 7,
      commits: 1,
      added: 2,
      outcomes: [],
    });
    mockSendGroupInviteNotification.mockReset().mockResolvedValue(undefined);
  });

  function votingGroup(policy: string) {
    return {
      id: "11111111-1111-1111-1111-111111111111",
      handle: "#team@acme",
      mls_group_id: "latch",
      enrollment_policy: policy,
    };
  }

  for (const policy of ["majority", "unanimity"]) {
    it(`adds no leaf for one nomination on a ${policy} group, and still notifies`, async () => {
      const ctx = makeCtx();
      post(ctx).mockResolvedValue({ id: "req-1", status: "pending" });
      get(ctx).mockResolvedValue(votingGroup(policy));

      await rineGroupInvite.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", invitee: "ana@acme" });

      expect(mockAddMlsGroupMember).not.toHaveBeenCalled();
      expect(mockResumeMlsGroupAdmission).not.toHaveBeenCalled();
      expect(mockSendGroupInviteNotification).toHaveBeenCalledTimes(1);
    });
  }

  it("still adds the leaf on a closed group, which invites as it always did", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue({ id: "req-1", status: "invited" });
    get(ctx).mockResolvedValue(votingGroup("closed"));

    await rineGroupInvite.handler(ctx, { group: "11111111-1111-1111-1111-111111111111", invitee: "ana@acme" });

    expect(mockAddMlsGroupMember).toHaveBeenCalledTimes(1);
  });

  it("runs no resume for a batch of nominations, though every entry was reached", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue(nominations);
    get(ctx).mockResolvedValue(votingGroup("majority"));

    const result = await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitees: ["ana@acme", "ben@acme"],
    });

    expect(mockResumeMlsGroupAdmission).not.toHaveBeenCalled();
    expect(mockSendGroupInviteNotification).toHaveBeenCalledTimes(2);
    // No MLS half at all — not an empty one, which would read as "the tree was
    // asked and seated nobody".
    expect(result).toMatchObject({ mls: undefined });
  });

  it("reports each entry as nominated rather than as an invitation to accept", async () => {
    const ctx = makeCtx();
    post(ctx).mockResolvedValue(nominations);
    get(ctx).mockResolvedValue(votingGroup("unanimity"));

    const result = await rineGroupInvite.handler(ctx, {
      group: "11111111-1111-1111-1111-111111111111",
      invitees: ["ana@acme", "ben@acme"],
    });

    expect((result as { entries: { status: string }[] }).entries).toEqual([
      { agent_id: "ana-uuid", status: "nominated" },
      { agent_id: "ben-uuid", status: "nominated" },
    ]);
  });
});

describe("rine_group_invites", () => {
  beforeEach(() => {
    mockResolveActor.mockReset();
    mockListMyInvites.mockReset();
  });

  it("lists invites without agent header when no agent specified", async () => {
    const ctx = makeCtx();
    const items = [{ id: "req-1", group: "11111111-1111-1111-1111-111111111111", group_handle: "#team@acme" }];
    mockListMyInvites.mockResolvedValue(items);

    const result = await rineGroupInvites.handler(ctx, {});

    expect(mockListMyInvites).toHaveBeenCalledWith(ctx.client, {});
    expect(result).toEqual({ items });
  });

  it("resolves agent and passes X-Rine-Agent header when agent specified", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "resolved-id" });
    mockListMyInvites.mockResolvedValue([]);

    await rineGroupInvites.handler(ctx, { agent: "mybot" });

    expect(mockResolveActor).toHaveBeenCalledWith(
      ctx.client,
      "mybot",
      undefined,
      ACTOR_SURFACES.mcp,
      // Where the value came from, carried down: the tool read it off the call,
      // so a one-agent fallback's warning names the parameter and not RINE_AGENT.
      "argument",
    );
    expect(mockListMyInvites).toHaveBeenCalledWith(ctx.client, {
      "X-Rine-Agent": "resolved-id",
    });
  });
});

describe("rine_groups", () => {
  beforeEach(() => {
    mockResolveActor.mockReset();
  });

  it("lists groups without agent header when no agent specified", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ items: [] });

    await rineGroups.handler(ctx, {});

    expect(ctx.client.get).toHaveBeenCalledWith("/groups", undefined, {});
  });

  it("resolves agent and sets X-Rine-Agent header", async () => {
    const ctx = makeCtx();
    mockResolveActor.mockResolvedValue({ agentId: "resolved-id" });
    get(ctx).mockResolvedValue({ items: [] });

    await rineGroups.handler(ctx, { agent: "mybot" });

    expect(ctx.client.get).toHaveBeenCalledWith("/groups", undefined, {
      "X-Rine-Agent": "resolved-id",
    });
  });

  // The list is credential-scoped and the header never narrows it, so a row was never proof the
  // acting agent could post to that group. `member_agent_ids` is what turns the
  // row into an answer, and MCP's rendering is the JSON the model reads — so
  // "renders it" here means it survives the handler untouched.
  it("hands member_agent_ids through on every row", async () => {
    const ctx = makeCtx();
    const page = {
      items: [
        { id: "11111111-1111-1111-1111-111111111111", member_count: 4, member_agent_ids: ["mine-1", "mine-2"] },
        { id: "22222222-2222-2222-2222-222222222222", member_count: 2, member_agent_ids: [] },
      ],
    };
    get(ctx).mockResolvedValue(page);

    const result = await rineGroups.handler(ctx, {});

    expect(result).toEqual(page);
  });

  // An empty list is a fact — "no agent of yours is seated here" — not a
  // missing key. A model that saw it on some rows and not others would read the
  // absence as a rendering fault rather than as an answer.
  it("keeps an empty member_agent_ids on a row rather than dropping it", async () => {
    const ctx = makeCtx();
    get(ctx).mockResolvedValue({ items: [{ id: "22222222-2222-2222-2222-222222222222", member_agent_ids: [] }] });

    const result = (await rineGroups.handler(ctx, {})) as {
      items: Record<string, unknown>[];
    };

    expect(result.items[0]).toHaveProperty("member_agent_ids", []);
  });

  it("tells a model what member_agent_ids answers, and what an empty one means", () => {
    expect(rineGroups.description).toContain("member_agent_ids");
    expect(rineGroups.description).toMatch(/empty list means none of your agents/);
  });

  // The sentence the field replaces. "belong to" described the org's
  // groups and stopped there, which is the claim the row now improves on.
  it("no longer describes the list only as the groups the org belongs to", () => {
    expect(rineGroups.description).not.toContain("agents belong to");
  });
});
