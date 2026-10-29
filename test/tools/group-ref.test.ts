/**
 * Every group verb on this surface takes a group REFERENCE.
 *
 * Two properties, and they fail differently, so they are tested differently.
 * The SHAPE — every group tool advertises `group`, none advertises `group_id`,
 * and the two rule sentences are the shared ones — is asserted over the
 * registries, so a tenth tool cannot be added with the old parameter. The
 * BEHAVIOUR — that a bare name, a partial handle and a handle with the wrong
 * org half all reach the route as a UUID — is asserted through the tools
 * themselves, against a mock that filters `?handle=` the way the server does.
 *
 * 🔴 The filtering mock is the whole test. An unconditional page answers every
 * `?handle=` with whatever row it holds, which makes a handle resolve for the
 * wrong reason and turns every assertion below into a tautology.
 */

import { JOIN_REFERENCE_RULE, RineApiError } from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import { groupInspectTools } from "../../src/tools/groups-inspect.js";
import { groupAdminTools } from "../../src/tools/groups-admin.js";
import { groupMemberTools } from "../../src/tools/groups-members.js";
import { groupRecoveryTools } from "../../src/tools/groups-recovery.js";
import { groupTools } from "../../src/tools/groups.js";
import {
  GROUP_REF_PARAM,
  groupRefArgument,
  groupTarget,
  joinGroupTarget,
} from "../../src/tools/group-ref.js";
import type { ToolContext, ToolDef } from "../../src/tools/types.js";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

interface Row {
  id: string;
  name: string;
  handle: string;
}

const LOGISTICS: Row = {
  id: GROUP_ID,
  name: "logistics",
  handle: "#logistics@acme.rine.network",
};

/** `GET /groups/{id}` — the one route the seated-id rung reads. */
const BY_ID = /^\/groups\/([0-9a-fA-F-]{36})$/;

/**
 * A client whose `GET /groups` filters by handle exactly as the route does, and
 * that records the filter each call carried — `undefined` for the unfiltered
 * list rung.
 *
 * 🔴 It answers the group's OWN route too, and refuses an id it does not hold
 * with a 404. That arm is what sits in front of every UUID: a
 * resolved id costs one indexed row, and the unpaginated list is paid only to
 * name the caller's groups in a refusal. The 404 and the 403 the real route can
 * send are the same answer here for the same reason they are the same answer
 * there — whether a stranger's id exists is not this caller's business.
 */
function clientHolding(rows: Row[]) {
  const filters: (string | undefined)[] = [];
  const get = vi.fn(
    async (path: string, params?: Record<string, unknown>) => {
      const id = BY_ID.exec(path)?.[1];
      if (id !== undefined) {
        const row = rows.find((r) => r.id === id);
        if (!row) throw new RineApiError(404, "Group not found");
        return row;
      }
      if (path !== "/groups") return {};
      const handle = params?.handle as string | undefined;
      filters.push(handle);
      return { items: handle ? rows.filter((r) => r.handle === handle) : rows };
    },
  );
  return { get, filters };
}

/** The routes one call asked for, in order. */
const asked = (get: ReturnType<typeof vi.fn>): string[] =>
  get.mock.calls.map((c) => c[0] as string);

function ctxHolding(rows: Row[]) {
  const { get, filters } = clientHolding(rows);
  const ctx = {
    client: { get, post: vi.fn() },
    configDir: "/tmp/test",
    apiUrl: "https://api.test",
  } as unknown as ToolContext;
  return { ctx, get, filters };
}

/** Every group tool this surface registers, from the registries `index.ts` imports. */
const GROUP_TOOLS: ToolDef[] = [
  ...groupTools,
  ...groupMemberTools,
  ...groupAdminTools,
  ...groupRecoveryTools,
  ...groupInspectTools,
];

/** The ones that take a group; `rine_groups`/`rine_group_invites` take none. */
const REFERENCE_TAKING = GROUP_TOOLS.filter((t) => {
  const schema = t.inputSchema as { properties?: Record<string, unknown> };
  return schema.properties?.group !== undefined;
});

describe("the group parameter, across every group tool", () => {
  it("is advertised on ten tools — create and the two listings take none", () => {
    expect(REFERENCE_TAKING.map((t) => t.name).sort()).toEqual([
      "rine_group_inspect",
      "rine_group_invite",
      "rine_group_join",
      "rine_group_leave",
      "rine_group_reclaim",
      "rine_group_remove",
      "rine_group_requests",
      "rine_group_roster",
      "rine_group_sync",
      "rine_group_vote",
    ]);
  });

  // The name is half of what the reference shape fixes: `group_id` tells a
  // model the value it needs is an id, which is what sent three measured runs
  // looking for one and composing one when the lookup was skipped.
  it("advertises `group` and never `group_id`, on every one of them", () => {
    for (const tool of GROUP_TOOLS) {
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(schema.properties ?? {})).not.toContain("group_id");
      expect(schema.required ?? []).not.toContain("group_id");
    }
  });

  it("requires it on all ten", () => {
    for (const tool of REFERENCE_TAKING) {
      const schema = tool.inputSchema as { required?: string[] };
      expect(schema.required ?? []).toContain("group");
    }
  });

  // One sentence, or nine chances for one of them to advertise a spelling the
  // ladder refuses.
  it("gives the nine non-join verbs the same description, naming all three spellings", () => {
    const nonJoin = REFERENCE_TAKING.filter((t) => t.name !== "rine_group_join");
    for (const tool of nonJoin) {
      const schema = tool.inputSchema as {
        properties: Record<string, { description?: string }>;
      };
      expect(schema.properties.group).toBe(GROUP_REF_PARAM);
    }
    expect(GROUP_REF_PARAM.description).toContain("its handle");
    expect(GROUP_REF_PARAM.description).toContain("its name");
    expect(GROUP_REF_PARAM.description).toContain("its UUID");
  });

  // Join's ladder is a different ladder, and its sentence is the one the Python
  // SDK and mastra print — restated here would be a copy that can go stale.
  it("gives rine_group_join the shared join rule instead", () => {
    const join = REFERENCE_TAKING.find((t) => t.name === "rine_group_join")!;
    const schema = join.inputSchema as {
      properties: Record<string, { description: string }>;
    };
    expect(schema.properties.group.description).toContain(JOIN_REFERENCE_RULE);
    expect(schema.properties.group).not.toBe(GROUP_REF_PARAM);
  });
});

describe("groupRefArgument", () => {
  it("reads the advertised `group`", () => {
    expect(groupRefArgument({ group: "logistics" })).toBe("logistics");
  });

  // Read and never advertised: a caller holding the older shape keeps
  // working, and the model is not shown the word that primed it for an id.
  it("still reads the retired `group_id`", () => {
    expect(groupRefArgument({ group_id: GROUP_ID })).toBe(GROUP_ID);
  });

  it("trims, so a pasted reference with a trailing space resolves", () => {
    expect(groupRefArgument({ group: "  logistics " })).toBe("logistics");
  });

  it("refuses a call that named neither, spelling all three forms", () => {
    expect(() => groupRefArgument({ agent: "kofi" })).toThrow(
      /group is required.*whole handle.*a leading hash.*group name.*UUID/s,
    );
  });

  // 🔴 The ban on worked examples, on the one refusal every group verb on this
  // surface passes through — and the ONLY thing holding it. The golden refusal
  // fixture imports from `rine-core/src` and `rine-sdk/src/rine` and can never
  // see a sentence a surface composes itself; `check-model-facing-examples.mjs`
  // reads description-valued literals and never a `throw`. So this assertion is
  // the gate: any `@` in the sentence is a domain a model can paste, which is
  // the failure, and a `<slot>` around one is the `template-org` failure that
  // produced `agent:"null"`.
  //
  // 🔴 THREE copies of this predicate ship, not two, and they are not one
  // gate. Counted at source rather than remembered:
  //
  //   rine-mcp/test/tools/group-ref.test.ts   (here)   /example|<|>|\{[a-zA-Z_]/
  //   rine-core/test/handle-words.test.ts:20           /example|<|>|\{[a-zA-Z_]/
  //   rine-mcp/test/tools/messaging.test.ts:1181       /example|<|>/
  //
  // The wide spelling is `messaging.test.ts`'s rung-2 one WIDENED — not copied
  // — and it is the WHOLE of what stands in for
  // `check-model-facing-examples.mjs`'s three `PLACEHOLDER_RULES` here. The
  // narrow one lacks `|\{[a-zA-Z_]`, so a BRACE slot (`{group}`, `{org}`) fails
  // here and in `handle-words.test.ts` and would not fail there. The wide form
  // itself replaced `/[<{]\s*org/i`, which caught only a slot literally spelled
  // `<org`/`{org` while claiming to cover all three: appending *"Write it as
  // <group-name>."* to the refusal left this file green at 22/22.
  //
  // 🔴 Harmonisation is UPWARD, to the strictest form, and it is all three
  // or none: widen `messaging.test.ts:1181` to `/example|<|>|\{[a-zA-Z_]/` and
  // leave the two wide copies as they are. Never narrow a wide copy to match
  // the narrow one. All three guard sentences built from ONE constant
  // (`GROUP_HANDLE_PARTS`, `rine-core/src/handle-words.ts`), so a copy left on
  // the weaker spelling is a hole in the gate for the very sentence the other
  // two pin — and the brace arm is the only thing that died on the mutation the
  // weaker regex survived.
  it("names no handle a model could paste back, and no slot to fill", () => {
    let said = "";
    try {
      groupRefArgument({});
    } catch (err) {
      said = String(err);
    }

    expect(said).toContain("group is required");
    expect(said).not.toContain("@");
    expect(said).not.toMatch(/example|<|>|\{[a-zA-Z_]/);
  });

  it("refuses a blank reference rather than searching for one", () => {
    expect(() => groupRefArgument({ group: "   " })).toThrow(/group is required/);
  });
});

describe("groupTarget", () => {
  // 🔴 This test used to be named *passes a UUID through, and buys no round
  // trip to do it*, which is the shipped behaviour stated backwards. The
  // passthrough is closed — an id nobody checked was answered here while
  // `resolveGroup` refused the same unknown id with the caller's roster, so one
  // reference got two answers — and the replacement is priced: the group's own
  // indexed row on the success path, the unpaginated list on the refusal path
  // and nowhere else.
  it("reads a UUID off the group's own row, and buys no roster to do it", async () => {
    const { ctx, get, filters } = ctxHolding([LOGISTICS]);

    // 🔴 The whole record, and the `row` half is the widened seam: the group
    // this resolve already paid `GET /groups/{id}` for is handed on, so a verb
    // that needs the row does not read the same group a second time and get an
    // answer that can disagree with the one the reference resolved through.
    await expect(groupTarget(ctx, { group: GROUP_ID })).resolves.toEqual({
      id: GROUP_ID,
      handle: LOGISTICS.handle,
      spelling: GROUP_ID,
      row: LOGISTICS,
    });
    expect(asked(get)).toEqual([`/groups/${GROUP_ID}`]);
    // `filters` records every `GET /groups`, filtered or not: the list rung is
    // not reached at all.
    expect(filters).toEqual([]);
  });

  // The other half of that price, and the reason for it: an id
  // this caller cannot read is answered with the groups it CAN, rather than
  // with the server's bare 404 — measured at a 0/6 recovery rate. The roster is
  // the second read, never the first.
  it("answers an id it cannot read with the caller's own groups, and only then", async () => {
    const { ctx, get } = ctxHolding([LOGISTICS]);

    await expect(groupTarget(ctx, { group: OTHER_ID })).rejects.toThrow(
      new RegExp(
        `Group not found: ${OTHER_ID}\\.[\\s\\S]*#logistics@acme\\.rine\\.network`,
      ),
    );
    expect(asked(get)).toEqual([`/groups/${OTHER_ID}`, "/groups"]);
  });

  it("resolves a bare name through the ladder", async () => {
    const { ctx, filters } = ctxHolding([LOGISTICS]);

    const target = await groupTarget(ctx, { group: "logistics" });

    expect(target.id).toBe(GROUP_ID);
    // The unfiltered list rung only: a bare name matches no `?handle=` value.
    expect(filters).toEqual([undefined]);
  });

  // Tier 4: one generic classifier noun peeled off the tail.
  it("resolves the way a model says it out loud", async () => {
    const { ctx } = ctxHolding([LOGISTICS]);

    await expect(
      groupTarget(ctx, { group: "the logistics group" }),
    ).resolves.toMatchObject({ id: GROUP_ID });
  });

  // The fabricated org half is the exact shape
  // three live-model runs produced.
  it("resolves a handle whose org half was invented", async () => {
    const { ctx, filters } = ctxHolding([LOGISTICS]);

    const target = await groupTarget(ctx, {
      group: "#logistics@example.rine.network",
    });

    expect(target.id).toBe(GROUP_ID);
    // The exact lookup first — it is what answers every correctly-spelt handle
    // in one round trip — then the local part through the ladder.
    expect(filters).toEqual(["#logistics@example.rine.network", undefined]);
  });

  it("hands back what the caller wrote, never the id it resolved to", async () => {
    const { ctx } = ctxHolding([LOGISTICS]);

    const target = await groupTarget(ctx, { group: "logistics" });

    expect(target.spelling).toBe("logistics");
  });

  it("refuses an ambiguous reference, naming the candidates", async () => {
    const { ctx } = ctxHolding([
      LOGISTICS,
      { id: OTHER_ID, name: "logistics", handle: "#logistics@other.rine.network" },
    ]);

    await expect(groupTarget(ctx, { group: "logistics" })).rejects.toThrow(
      /ambiguous[\s\S]*#logistics@acme\.rine\.network[\s\S]*#logistics@other\.rine\.network/,
    );
  });

  it("refuses a reference no group answers to, naming the ones that exist", async () => {
    const { ctx } = ctxHolding([LOGISTICS]);

    await expect(groupTarget(ctx, { group: "payroll" })).rejects.toThrow(
      /Group not found: payroll\.[\s\S]*#logistics@acme\.rine\.network/,
    );
  });
});

/** A client seated in nothing, holding `rows` as pending invitations instead. */
function ctxInvitedTo(rows: Row[]): ToolContext {
  const get = vi.fn(async (path: string) => {
    if (path === "/groups/invites") {
      return {
        items: rows.map((r) => ({ group_id: r.id, group_handle: r.handle })),
      };
    }
    return { items: [] };
  });
  return {
    client: { get, post: vi.fn() },
    configDir: "/tmp/test",
    apiUrl: "https://api.test",
  } as unknown as ToolContext;
}

describe("joinGroupTarget", () => {
  // Join's target is a group this org is NOT in, so the seat list
  // `groupTarget` searches is the one set that cannot hold it. Same reference,
  // two ladders, and only one of them can answer this — which is why join takes
  // its own helper rather than the one the other nine verbs share.
  it("resolves a handle off this agent's invitations, where the seat list cannot", async () => {
    await expect(
      joinGroupTarget(ctxInvitedTo([LOGISTICS]), {
        group: "#logistics@acme.rine.network",
      }),
    ).resolves.toEqual({
      id: GROUP_ID,
      handle: undefined,
      spelling: "#logistics@acme.rine.network",
      row: undefined,
    });

    const { ctx: seatedInNothing } = ctxHolding([]);
    await expect(
      groupTarget(seatedInNothing, { group: "#logistics@acme.rine.network" }),
    ).rejects.toThrow(/Group not found/);
  });

  it("resolves a bare name off an invitation too", async () => {
    await expect(
      joinGroupTarget(ctxInvitedTo([LOGISTICS]), { group: "logistics" }),
    ).resolves.toMatchObject({ id: GROUP_ID });
  });

  // 🔴 Where the two ladders now part. `groupTarget` reads a UUID off
  // `GET /groups/{id}`; join's UUID rung is deliberately still a
  // passthrough, because a join targets a group this org neither owns nor holds
  // a seat in, and that route answers for neither. The old name — *as the other
  // ladder does* — became false the moment the passthrough closed.
  it("passes a UUID through, where the seated ladder now reads the row", async () => {
    const ctx = ctxInvitedTo([]);

    await expect(
      joinGroupTarget(ctx, { group: GROUP_ID }),
    ).resolves.toEqual({
      id: GROUP_ID,
      handle: undefined,
      // 🔴 The join seam's own signal, now stated rather than merely absent:
      // an answer with no row came off the join ladder, and
      // the directory rung has no row to give.
      spelling: GROUP_ID,
      row: undefined,
    });
    expect(ctx.client.get).not.toHaveBeenCalled();
  });

  // 🔴 The acting-agent header decides WHOSE invitations `/groups/invites`
  // lists, so dropping it does not fail — it answers for the wrong agent, and
  // in a single-agent org the two are indistinguishable. Nothing pinned it
  // until now: a refactor delegated this function to `rine-core`'s
  // `resolveGroupForJoin`, and a mutation that deleted the forwarded headers
  // left all of this package's tests green.
  it("forwards the caller's headers, which is what scopes the invite listing", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const get = vi.fn(
      async (path: string, _params?: unknown, headers?: Record<string, string>) => {
        seen.push(headers);
        return path === "/groups/invites"
          ? { items: [{ group_id: GROUP_ID, group_handle: LOGISTICS.handle }] }
          : { items: [] };
      },
    );
    const ctx = {
      client: { get, post: vi.fn() },
      configDir: "/tmp/test",
      apiUrl: "https://api.test",
    } as unknown as ToolContext;

    await expect(
      joinGroupTarget(ctx, { group: "logistics" }, { "x-acting": "agent-7" }),
    ).resolves.toMatchObject({ id: GROUP_ID });

    expect(seen).not.toHaveLength(0);
    for (const headers of seen) {
      expect(headers).toMatchObject({ "x-acting": "agent-7" });
    }
  });
});
