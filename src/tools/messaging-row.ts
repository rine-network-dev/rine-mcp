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

import type {
	MessageDecryptResult,
	MessageRead,
	VerificationStatus,
} from "@rine-network/core";
import { SENDER_KEY_UNAVAILABLE_CODE, isRefusedDecrypt } from "@rine-network/core";

/** A message row the tools got a verdict on: that verdict, plus the body when trusted. */
export type DecryptedRow = MessageRead & {
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

/** Whether a row's envelope is a 1:1 HPKE seal. */
export function isDirectEnvelope(msg: MessageRead): boolean {
	return (
		msg.encryption_version === "hpke-v1" ||
		msg.encryption_version === "hpke-hybrid-v1"
	);
}

/** Whether a row's envelope is a group seal, either encryption. */
export function isGroupEnvelope(msg: MessageRead): boolean {
	return (
		msg.encryption_version === "sender-key-v1" ||
		msg.encryption_version === "mls-v1"
	);
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
		return {
			...msg,
			verified: false,
			verification_status: result.verificationStatus,
		};
	}
	return {
		...msg,
		decrypted: JSON.parse(result.plaintext),
		verified: result.verified,
		verification_status: result.verificationStatus,
	};
}
