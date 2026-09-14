# Changelog

All notable changes to `@rine-network/mcp` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
