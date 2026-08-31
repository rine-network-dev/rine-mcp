/**
 * A `client.get` stub that answers per ROUTE, for the group-verb suites.
 *
 * 🔴 **Why the group suites need one.** The resolver puts
 * `GET /groups/{id}` in front of every group verb handed a UUID: the seated-id
 * rung reads the group's own row instead of searching the org's list, and pays
 * `GET /groups` only to compose a refusal. A stub that answers one shape for
 * every path therefore hands the resolver the verb's OWN payload — a members
 * page, a requests page — reads no `id` off it, and the verb goes on to ask
 * `/groups/undefined/members`. Saying which route answers what is the only
 * thing that tells the two reads apart.
 *
 * It also makes a refusal test sharper than a blanket `mockRejectedValue` was:
 * a 403 from THIS route says the verb's own read was refused, where a 403 from
 * every route could equally be the resolver's, and the two are different
 * defects.
 *
 * An `Error` is thrown rather than returned, on either arm — refusing is
 * something a route does, so a test that wants a refusal from one route says so
 * there.
 *
 * 🔴 **An unsupplied `fallback` throws, and that is the difference between a
 * refusal test and a decoration.** It used to default to `{}`, which is TRUTHY
 * — so a test that forgot to register `/groups/{id}` did not exercise the
 * refusal it was written for: `readableGroupById` reads any non-throwing answer
 * as the group's row, so the verb reported a crypto regime for a group the stub
 * had never heard of, and the assertion passed. The default is a bare `Error`
 * rather than a `RineApiError(404)` on purpose: a 404 is a REFUSAL, which the
 * resolver is entitled to swallow into "no such group", and swallowing is
 * exactly what would hide the missing route again. A statusless throw escapes
 * every arm and names itself.
 *
 * `test/` is in no `tsconfig` here (`include: ["src"]`), so a required
 * parameter would be enforced by nothing — the omission has to fail at run
 * time or it does not fail at all.
 */
export function routedGet(
  routes: Record<string, unknown>,
  fallback: unknown = new Error(
    "routedGet: this path has no route and the caller named no fallback",
  ),
): (path: string) => Promise<unknown> {
  return async (path: string) =>
    answer(path in routes ? routes[path] : fallback);
}

function answer(value: unknown): unknown {
  if (value instanceof Error) throw value;
  return value;
}
