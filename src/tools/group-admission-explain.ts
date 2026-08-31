import {
	type GroupAdmissionEntry,
	type GroupAdmissionReport,
	type MlsAdmissionOutcome,
	type MlsAdmissionResult,
	groupAdmissionSkipSentence,
	mlsAdmissionSkipSentence,
} from "@rine-network/core";

/**
 * An admission report, with each skip said in a sentence a model can act on.
 *
 * This surface hands its results to a language model, and it handed them over
 * as the raw wire tokens the server chose: `skipped (not_applicable)` read as a
 * refusal on exactly the groups it is not one for — an open group mints no
 * invitation because it needs none, and those agents may walk in whenever they
 * like. The sentences are `rine-core`'s, so the CLI, the MCP server, mastra and
 * eve all say the same thing about the same token.
 *
 * Additive: `agent_id`, `status` and `reason` arrive unchanged, and only a
 * skipped entry gains a sentence — an `invited` or `nominated` one carries no
 * reason to explain. What `nominated` means is stated in `rine_group_invite`'s
 * description, which is where a model meets it: the electorate has still to
 * decide, so no seat and no leaf follow from that entry.
 */
export type ExplainedAdmissionEntry = GroupAdmissionEntry & {
	reason_explained?: string;
};

export type ExplainedAdmissionReport = Omit<GroupAdmissionReport, "entries"> & {
	entries: ExplainedAdmissionEntry[];
};

export type ExplainedMlsOutcome = MlsAdmissionOutcome & {
	reason_explained?: string;
};

export type ExplainedMlsAdmission = Omit<MlsAdmissionResult, "outcomes"> & {
	outcomes: ExplainedMlsOutcome[];
};

/** Say why each entry the server skipped was skipped. */
export function explainAdmission(
	report: GroupAdmissionReport,
): ExplainedAdmissionReport {
	return {
		...report,
		entries: report.entries.map((entry) =>
			entry.status === "skipped"
				? {
						...entry,
						reason_explained: groupAdmissionSkipSentence(entry.reason),
					}
				: entry,
		),
	};
}

/**
 * Say why each agent the ratchet tree did not seat was not seated.
 *
 * A different question from {@link explainAdmission}, in a different
 * vocabulary: that one is about the invitation, this one about the leaf. An
 * agent can be `invited` in the first and `no_key_package` in the second — it
 * may join, and it cannot read a word until a leaf exists for it.
 */
export function explainMlsAdmission(
	mls: MlsAdmissionResult,
): ExplainedMlsAdmission {
	return {
		...mls,
		outcomes: mls.outcomes.map((outcome) =>
			outcome.status === "skipped"
				? {
						...outcome,
						reason_explained: mlsAdmissionSkipSentence(outcome.reason),
					}
				: outcome,
		),
	};
}
