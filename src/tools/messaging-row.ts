/**
 * The SHAPE of a message row the tools hand back, and the one function that
 * builds it from a decrypt that returned.
 *
 * Split from `messaging-decrypt.ts`, which now owns only the two openers — the
 * same cut the CLI made between `messages-read.ts` and `messages-read-decrypt.ts`:
 * deciding an envelope's fate is one job, saying what a row looks like once
 * decided is another. Everything here is reachable without a client, a config
 * dir or a key, which is the test for whether a line belongs on this side of it.
 */

// One statement per module, with the kinds inline. `SENDER_KEY_UNAVAILABLE_CODE`
// is imported as a TYPE because this file only ever reads it through `typeof`
// (`decrypt_error_code` below) — the value is never evaluated here. Under
// `verbatimModuleSyntax` a value import would emit a runtime import nothing uses,
// and a later line that does want the value fails as a compile error naming this
// import, not as anything at a distance.
import {
	ENCRYPTION_VERSION_HYBRID_V2,
	a2aCleartextPayload,
	isA2aCleartext,
	isAuthenticityFailure,
	isGroupEncryptionVersion,
	isRefusedDecrypt,
	type MessageDecryptResult,
	markA2aCleartext,
	type A2aCleartextMark,
	type MessageRead,
	type SENDER_KEY_UNAVAILABLE_CODE,
	type VerificationStatus,
} from "@rine-network/core";

/** A message row the tools got a verdict on: that verdict, plus the body when trusted. */
export type DecryptedRow = MessageRead & Partial<A2aCleartextMark> & {
	/** Absent on a row that stayed sealed for the one explained cause. */
	verified?: boolean;
	verification_status?: VerificationStatus;
	decrypted?: unknown;
	/**
	 * Set only when this row is sealed under a sender key this agent holds no
	 * state for — the one refusal cause with a move for the reader to make.
	 * `openMessage` (one row asked for) sets this to the full four-clause
	 * sentence, earned because its one-shot recovery already ran and lost.
	 * `openInboxRow` (a page of rows) never affords that recovery, so it sets
	 * the honest un-earned sentence on the first row of the page carrying this
	 * cause and that sentence's own marker on every row after it — the same
	 * explain-once-then-mark render policy every other surface uses.
	 */
	decrypt_error?: string;
	/**
	 * The stable branch key beside {@link decrypt_error}: the imported
	 * {@link SENDER_KEY_UNAVAILABLE_CODE} when the one-shot recovery ran and
	 * confirmed the key is not coming, absent otherwise — including on
	 * `openInboxRow`'s un-earned sentence, which must never be mistaken for a
	 * verdict it did not check for.
	 *
	 * Typed as that constant rather than `string`, so the one value this field is
	 * allowed to carry is checked by the compiler instead of asserted in prose.
	 * A second cause earning a code widens this to a union, deliberately: every
	 * consumer branching on it is then told to consider the new arm.
	 */
	decrypt_error_code?: typeof SENDER_KEY_UNAVAILABLE_CODE;
};

/** A row the tools hand back: opened with a verdict, or still sealed. */
export type OpenedRow = MessageRead | DecryptedRow;

/** Whether a row's envelope is a 1:1 hybrid HPKE seal. */
export function isDirectEnvelope(msg: MessageRead): boolean {
	return msg.encryption_version === ENCRYPTION_VERSION_HYBRID_V2;
}

/** Whether a row's envelope is a group seal, either encryption. */
export function isGroupEnvelope(msg: MessageRead): boolean {
	return isGroupEncryptionVersion(msg.encryption_version);
}

/**
 * The row shape for a refusal that withholds its content: the verdict rides
 * back and `decrypted` is absent, so nothing the row's authenticated sender did
 * not sign can reach the model.
 *
 * Shared by the two paths that produce one, which do NOT look alike from the
 * caller's side: the 1:1 decrypt RETURNS a `RefusedDecrypt` ({@link
 * decryptedRow}'s refused arm), and the group decrypt THROWS, so each opener's
 * own `catch` builds the row. One function, because {@link
 * rowAuthenticityFailure} reads `verification_status` and a copy that forgot to
 * set it would leave a forged row looking merely unreadable.
 */
export function refusedRow(
	msg: MessageRead,
	status: VerificationStatus,
): DecryptedRow {
	return { ...msg, verified: false, verification_status: status };
}

/**
 * One row shape for an opened message and for a 1:1 refusal. An authenticity
 * failure withholds the text — the model is never handed content the row's
 * server-authenticated sender did not sign — so the verdict rides back in its
 * place and `decrypted` is absent.
 *
 * A group decrypt that throws never arrives here — the caller's own `catch`
 * handles it. Most thrown causes seal the row with no verdict field, unchanged.
 * The one exception is the caller's job too: `openMessage` and
 * `openInboxRow` each recognise the no-sender-key cause in their own catch and
 * set `decrypt_error`/`decrypt_error_code` there, at their own tier — this
 * function never sees it either way.
 */
export function decryptedRow(
	msg: MessageRead,
	result: MessageDecryptResult,
): DecryptedRow {
	if (isRefusedDecrypt(result)) {
		return refusedRow(msg, result.verificationStatus);
	}
	return {
		...msg,
		decrypted: JSON.parse(result.plaintext),
		verified: result.verified,
		verification_status: result.verificationStatus,
	};
}

/**
 * A row that was never ciphertext, handed back as it arrived. An A2A cleartext message
 * additionally carries its posted parts as `decrypted`, flagged and never verified, so a
 * model reads the same body the Python clients give as plaintext.
 */
export function arrivedRow(msg: MessageRead): OpenedRow {
	if (!isA2aCleartext(msg)) return msg;
	return {
		...markA2aCleartext(msg),
		decrypted: a2aCleartextPayload(msg),
		verified: false,
		verification_status: "unverifiable",
	};
}

/**
 * Whether this row actually opened — the one POSITIVE fact a decided row
 * carries, and the only sound way to ask the question on this surface.
 *
 * 🔴 `!row.decrypt_error` is a different question, which is why it is not the
 * one asked. `openInboxRow` hands a row back **unchanged** — no `decrypted`
 * AND no `decrypt_error` — in three separate classes: this agent holds no key
 * material, the envelope is neither a 1:1 nor a group seal, and a thrown cause
 * that is not the recognised missing-sender-key one. So the `!decrypt_error`
 * idiom other surfaces use answers "readable" for three kinds of row that never
 * opened. `decrypted` is set by exactly one line — {@link decryptedRow}'s
 * opened arm, after the authenticity check has already passed — so it cannot
 * answer true for a row that stayed sealed or for one whose author was refused.
 */
export function rowOpened(row: OpenedRow): boolean {
	return "decrypted" in row;
}

/**
 * Whether this row was refused because its author could not be trusted — the
 * one refusal that will NEVER heal, because a signature that does not check out
 * is a permanent property of the bytes.
 *
 * Separate from {@link rowOpened} because the two decide opposite things about
 * the same row: an unreadable row is worth preserving so a later look can open
 * it, and a forged one has nothing to preserve. Screened through `rine-core`'s
 * {@link isAuthenticityFailure} rather than compared against a member, so
 * `unverifiable` — a transient key-lookup outcome, not a verdict — is not swept
 * in with it.
 *
 * The cast reads an OPTIONAL field off the wider arm of {@link OpenedRow}: the
 * fields {@link DecryptedRow} adds are all optional, so this asserts nothing
 * about the row, and `undefined` is handled rather than passed on.
 */
export function rowAuthenticityFailure(row: OpenedRow): boolean {
	const status = (row as DecryptedRow).verification_status;
	return status !== undefined && isAuthenticityFailure(status);
}

/**
 * Whether this row was never ciphertext in the first place — so there is
 * nothing to open, nothing withheld, and nothing a later look could change.
 *
 * 🔴 This is `rine-core`'s `not-ciphertext` verdict asked of a row rather than
 * of a decrypt attempt, and it is a THIRD thing beside opened and refused.
 * `openInboxRow` hands such a row back unchanged, so without this question the
 * listing's ack filter decides its fate by falling off the end of two envelope
 * predicates — and the live instance of the shape is `encryption_version:
 * "none"`, which `_create_a2a_message` in `src/rine/api/a2a_messages.py` writes onto a real row for any agent
 * whose A2A card sets `a2a_accept_cleartext`. No key arrival, no sweep and no
 * later listing will ever make one open, so leaving it `new` pins it at the head
 * of every future listing for the life of the agent, growing by one per inbound
 * A2A message, with no verb on this surface that can clear it.
 *
 * 🔴 Core's `not-ciphertext` verdict has two further arms — no authenticated
 * sender, and an empty payload — and this deliberately asks NEITHER. Not for
 * tidiness: `messages.from_agent_id` is `nullable=False` on the server model
 * and `MessageRead.from_agent_id` is non-optional on the wire, so a listing
 * cannot produce the first, and the second reaches `openInboxRow`'s catch as an
 * unclassified throw, where "may heal, cause unknown" is the honest verdict.
 * Widening a permanent-class predicate past the shapes that actually occur is
 * how an ack filter starts consuming rows on a guess.
 *
 * What is left is a permanent property of the row that the server does write,
 * which is what makes acking sound here and unsound for the classes this
 * excludes (no local key material, or a throw nobody classified: both may heal).
 */
export function rowNeverCiphertext(row: OpenedRow): boolean {
	return !isDirectEnvelope(row) && !isGroupEnvelope(row);
}
