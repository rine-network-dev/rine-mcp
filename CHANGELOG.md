# Changelog

All notable changes to `@rine-network/mcp` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — `rine_group_members` is now `rine_group_roster`, with no alias

`roster` (who is in a group) against `inspect` (what kind of group it is) says
what the two verbs do. An MCP client configuration that names
`rine_group_members` no longer resolves it, and there is no deprecation shim.
The name is the same on every rine surface.

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
