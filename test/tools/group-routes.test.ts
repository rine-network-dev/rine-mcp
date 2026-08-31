import { describe, expect, it } from "vitest";
import { routedGet } from "./group-routes.js";

/**
 * The stub's own guard.
 *
 * 🔴 A test helper that answers a path nobody registered is how a refusal test
 * becomes decoration, and nothing else in this package can see it happen. The
 * previous default was `{}` — truthy — so a group verb handed a UUID with no
 * `/groups/{id}` route registered took the empty object as the group's row and
 * reported on a group the stub had never held. The assertion under it passed.
 *
 * Two properties, and the second is the one that rots: an unregistered path
 * must fail, and it must fail in a way the resolver cannot SWALLOW. A 404 or a
 * 403 is a refusal `readableGroupById` is entitled to turn into "no such
 * group", which puts the missing route straight back out of sight.
 */
describe("routedGet", () => {
  const GROUP_ID = "11111111-1111-1111-1111-111111111111";

  it("answers the route a caller registered", async () => {
    const get = routedGet({ [`/groups/${GROUP_ID}`]: { id: GROUP_ID } }, null);

    await expect(get(`/groups/${GROUP_ID}`)).resolves.toEqual({ id: GROUP_ID });
  });

  it("throws for a path with no route and no fallback, rather than answering", async () => {
    const get = routedGet({ [`/groups/${GROUP_ID}`]: { id: GROUP_ID } });

    await expect(get("/groups")).rejects.toThrow("no route");
  });

  it("throws something statusless, so no resolver arm can swallow it", async () => {
    const get = routedGet({});

    const thrown = await get("/groups/anything").catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    // `RineApiError` carries `status`; this deliberately does not, because a
    // status is what earns a swallow.
    expect((thrown as { status?: unknown }).status).toBeUndefined();
  });

  it("still lets a test say what a route refuses with", async () => {
    const refusal = new Error("403 Access denied");
    const get = routedGet({ "/groups": refusal }, { items: [] });

    await expect(get("/groups")).rejects.toThrow("403 Access denied");
    await expect(get("/groups/other")).resolves.toEqual({ items: [] });
  });
});
