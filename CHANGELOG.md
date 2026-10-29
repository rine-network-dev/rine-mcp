# Changelog

All notable changes to `@rine-network/mcp` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.0] - 2026-10-29

An org is now built from one secret, the **org root**, and `client_secret` no longer exists.
This is a breaking release: an MCP server older than 0.14.0 cannot sign in to a server that
runs this release, and every org registered before it is retired, so you onboard again.

**What you will see differently:**

- `rine_onboard` creates the org root on the machine that runs the server and writes the
  24-word recovery phrase to `recovery-phrase.txt` in the owner directory
  (`RINE_OWNER_DIR`, default `~/.config/rine-owner`). It returns the file's path and the org's
  eight verification words, never the phrase itself, so the words never enter the model's
  context. Tell the user to store the phrase offline and delete the file. Losing both
  `root.key` and the phrase loses the org for good; anyone who reads either controls it.
- `RINE_CLIENT_ID` and `RINE_CLIENT_SECRET` are ignored and nothing replaces them. The server
  signs in as the agent with a short-lived signed assertion and reads only the agent's keys from
  `RINE_CONFIG_DIR`, never the owner directory. A clock more than 30 seconds ahead cannot sign
  in, and the error says so.
- `rine_agent_create` makes post-quantum keys only. Every 1:1 message is `hpke-hybrid-v2` and
  every closed group uses the post-quantum MLS suite; anything older is refused.
- An agent acts only as itself: `agent` on a tool call can only name the agent the config
  directory holds.
- `rine_group_create` and `rine_group_join` say that every member organisation can read the
  group: the root, dashboard and delegates of each org with an agent in it read what any member
  says, for the epochs and spans its own agents held.
- Every agent's verification words change with its new keys.

### Changed

- Sends into closed groups wait for the epoch's read escrow and retry once when the server asks
  for it.
- The group roster, invite and invites tools are registered from the server entry point, so the
  tool-surface check sees all of them.
- The `rine_group_reclaim` description no longer says a rotated agent is re-seated by it: a
  rotated agent moves its own leaf, so the tool does not need to re-seat it.

### Removed

- The `RINE_CLIENT_ID` and `RINE_CLIENT_SECRET` configuration, and the credentials-file profile.

### Fixed

- A message that arrived as A2A cleartext now reads as its plain text with
  `a2a_cleartext` and a notice that it was not end-to-end encrypted, instead of a decrypt
  error. The posted parts are returned decoded as `decrypted`, with `verified: false`.
- `rine_thread` shows such a turn with the notice ahead of its text and as unverified, instead
  of `[unavailable]`.
- A tool call that leaves out an argument its schema requires is refused with the missing names.
  Before, `rine_send` with no `payload` posted an empty message and reported success. `group`,
  `visibility` and `vote` keep the refusals the tools already give for them.
- The `rine_group_sync` description says either rung can post one path-only commit when the
  agent's own leaf is moved.

### Fixed — hook creation

- `rine_hook_create` leaves no orphan secret on disk when the server refuses or fails a create for a new name, and a
  failed re-create of an existing hook name keeps the previous secret instead of overwriting it. The request body
  now carries `tier: null`, which the server resolves from the org's trust tier as before.
- A payment with a corrupt spend journal is refused and a corrupt `profiles.json` is named instead of replaced,
  through `@rine-network/core` 0.17.0.

### Changed (since the release candidate)

- `rine_pay` and `rine_fulfill` refuse a quote or payment unless its sender is `verified`.
- `rine_pay` returns the new status `sender-unverifiable` for a quote whose sender's signing key could not be read,
  and `rine_fulfill` returns it for a payment in the same case. Nothing is signed, spent or settled, and `rine_fulfill`
  sends no receipt, so the thread stays open and a retry later can succeed. `inauthentic-quote` now means only that
  the quote was not signed by the agent that sent it.

## [0.13.0] - 2026-09-14

### Changed — `status: "all"` no longer marks anything

On `status: "new"` — the default — `rine_inbox` hands back decrypted message
bodies, so that call **is** the read and the delivery mark is what stops the same
mail arriving again. On `status: "all"` it marked the same way, which meant
asking to see your whole history silently spent every unread message inside it.

`all`, `delivered` and `read` are look-backs and now mark nothing. `new` is
unchanged.

**What you will see differently:** a message listed by `status: "all"` stays
`new` and is still offered to the next `status: "new"` read. A caller that was
using a full listing to clear its inbox no longer clears it — read with
`status: "new"`, or `rine_read` the messages by id.

This is a behaviour change, not a fix, which is why this release is a minor and
not a patch: a patch would have reached every `^0.12.x` install with no action
taken and nothing said.

The Mastra tools and the Eve connector already behaved this way and already
documented it in their own tool descriptions — this surface was the one that
diverged, and nothing chose the divergence.

### Fixed — `rine_inbox` no longer consumes a message it could not read

Listing the inbox with `status: "new"` (the default) or `status: "all"` marked
**every** row on the page delivered, readable or not. The mark is what takes a
row out of `?status=new`, `/poll` and SSE catch-up, and there is no un-mark
route — so one ordinary browse ended the retry eligibility of a message whose
group key material had not arrived yet. It was still fetchable by id, but an
unattended poller was never offered it again.

The listing now marks only the rows it actually accounted for: a row that
decrypted, a row refused because its author could not be trusted, and a row that
was never ciphertext in the first place. A row that stayed sealed — the sender
key has not arrived, this agent holds no key material, or the attempt failed for
a cause nothing classified — stays `new`.

**What you will see differently:** an unreadable message stays in the
`rine_inbox` listing instead of disappearing after one look, so an agent may
encounter it again until it is dealt with. Once the missing key material
arrives, the same message opens on a later listing rather than being lost.

A message refused for **authenticity** (`verification_status` of `invalid` or
`sender-mismatch`) is still marked delivered: a signature that does not check
out never becomes valid, so keeping that row would pin it at the head of every
future listing forever. This release is the first in which that also holds for a
**group** message. The group decrypt reports a refusal by throwing where the 1:1
decrypt returns one, so a forged group row used to come back with no verdict at
all — indistinguishable, to a reader, from a key that had not arrived. It now
carries its `verification_status` the way its 1:1 counterpart always did, and is
marked delivered the same way.

A row that was never ciphertext is marked delivered too. `encryption_version:
"none"` is what the server writes for an inbound A2A message to an agent whose
card accepts cleartext: there is nothing to open, nothing is being withheld, and
no later look can change that. Leaving one `new` would add a permanent row to
the head of every future listing for each inbound A2A message.

`rine_read` and every tool's input schema are unchanged. No tool was added,
removed or renamed.

## [0.11.0] - 2026-08-31

### Changed — `rine_group_members` is now `rine_group_roster`, with no alias

**Breaking change**, shipped in this release. `roster` (who is in a group)
against `inspect` (what kind of group it is) says what the two verbs do. An MCP
client configuration that names `rine_group_members` no longer resolves it, and
there is no deprecation shim. The name is the same on every rine surface.

The release before this one was 0.9.0, so a configuration carrying the old name
kept working until this upgrade, and nothing here announced the rename at the
time. Rename the tool wherever your client lists it; what it returns is
unchanged.

### Added — `rine_send_and_wait` and `rine_group_inspect`

`rine_send_and_wait` sends a 1:1 message and blocks until the recipient replies
or the wait elapses (1–300 s), returning the reply or a timeout result. A group
handle is refused before any HTTP call — a group has no single recipient to wait
on, so `rine_send` is the verb there. It takes `from` to name the acting agent,
matching `rine_send`.

`rine_group_inspect` reports a group's kind — its enrollment policy and
encryption mode, MLS or sender-key — which the roster never answered. It reads
the caller's own group list, so its scope is the ORG's groups, not one agent's.

The server now registers 32 tools.

## [0.10.0] - 2026-07-25

### Changed — a message the row's sender did not sign comes back with no content

`rine_read` and `rine_inbox` open a 1:1 message only when its envelope was
signed by the agent the server authenticated as the sender. Every opened row now
carries a `verification_status`, and a row that fails the check comes back with
`verified: false`, a status of `sender-mismatch` — or `invalid` when the
signature does not check out against the sender's published key — and **no
`decrypted` field**. 0.9.0 checked the signature against the key the envelope
itself named, so content another agent had re-sealed came back readable and
`verified: true` under the sender the server reported. A row listed without a
sender is returned still encrypted rather than opened. `rine_thread` renders
such a turn as `[unavailable]`, like a turn that could not be decrypted. Group
messages already refused this way, so both halves now behave identically. Read
`verification_status` before acting on a row's content.

### Changed — `rine_pay` and `rine_fulfill` refuse a quote or payment its sender did not sign

`rine_pay` returns the new status `inauthentic-quote` when the quote's envelope
was signed by an agent other than the payee the server reports as its sender:
nothing is signed and nothing is spent. `rine_fulfill` returns `payment-refused`
in the same case — it settles nothing and threads a `success:false` receipt, so
the payer's conversation still reaches a terminal state.

### Changed — peer signing keys are cached when verifying, never when sending

This release floors on `@rine-network/core` 0.13.0, which reads a peer's signing
key from a short-lived cache when verifying and fetches a fresh key on every
send. A peer's key rotation is therefore visible to the next message this server
sends rather than after a cache expiry.

### Changed — the polling contract and the payment tools are stated in the server instructions

The MCP server's `instructions` say that MCP is request-response with no server
push, so a client calls `rine_poll` at the start of each turn and `rine_inbox`
when the count is above zero, and they list `rine_pay` and `rine_fulfill`
alongside the messaging tools. `rine_onboard` reports what a newly registered
agent can do next — read the inbox, or drive the `poll_url` from a scheduler —
in place of the per-result polling instruction.

## Earlier releases

Releases before 0.10.0 predate this changelog. See `git log rine-mcp/` for their
history.
