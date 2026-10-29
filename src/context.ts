import {
	HttpClient,
	type CustodyDirs,
	type ResolvedAuth,
	type TokenFn,
	getOrRefreshToken,
	inBackground,
	jitteredRefreshMargin,
	pinOwnIdentity,
	resolveApiUrl,
	resolveAuth,
	resolveConfigDir,
	resolveOwnerDir,
	startupEscrowSweep,
} from "@rine-network/core";
import type { ToolContext } from "./tools/types.js";

export interface ServerContext {
	ctx: ToolContext;
	/**
	 * Clear the escrow files a previous process left behind, once per server
	 * process, for the one agent this principal can act as (every local agent
	 * for an org principal). Never throws; the library's own gate keeps a second
	 * call inside the heartbeat interval from repeating the pass.
	 */
	sweepEscrowAtStart(): void;
}

/**
 * Build the HTTP client and tool context for this process.
 *
 * The principal is resolved from the owner and config dirs, never from a
 * credentials file, and re-resolved when {@link ToolContext.refreshIdentity}
 * runs. The client's key-chain pins are seeded with the caller's own org and
 * agent ids, the way the SDK's client does, so a peer-key response that places
 * one of our agents under another org is refused instead of trusted on first use.
 *
 * The CLI's `createClient` (`rine-cli/src/action.ts`) wires the same core calls
 * for one command. The two stay separate on purpose: this one lives as long as
 * the server, so it resolves the principal lazily and re-resolves it on demand.
 */
export function createServerContext(): ServerContext {
	const dirs: CustodyDirs = {
		configDir: resolveConfigDir(),
		ownerDir: resolveOwnerDir(),
	};
	const apiUrl = resolveApiUrl();
	const envToken = process.env.RINE_TOKEN;
	// Drawn once for this long-lived process so co-located agents desynchronize their
	// refreshes instead of clustering into the same minute.
	const refreshMargin = jitteredRefreshMargin();

	// Only a FOUND identity is kept (as in rine-openclaw's client): a server started
	// before this owner dir held an org looks again on the next mint, so an onboarding
	// in another process comes live without a restart.
	let auth: ResolvedAuth | undefined;
	const currentAuth = (): ResolvedAuth | undefined => (auth ??= resolveAuth(dirs));

	const tokenFn: TokenFn = async (force = false) => {
		const current = currentAuth();
		if (!current && !envToken)
			throw new Error("Not registered — call rine_onboard first");
		return getOrRefreshToken(
			current?.cacheDir ?? dirs.configDir,
			apiUrl,
			current?.signer,
			{ force, envToken, refreshMargin },
		);
	};
	const client = new HttpClient({ tokenFn, apiUrl, canRefresh: !envToken });

	const refreshIdentity = (): void => {
		auth = undefined;
		pinOwnIdentity(client, dirs.configDir, currentAuth);
	};
	refreshIdentity();

	return {
		ctx: { client, ...dirs, apiUrl, refreshIdentity },
		sweepEscrowAtStart() {
			inBackground(() =>
				startupEscrowSweep(client, dirs.configDir, currentAuth()?.agentId),
			);
		},
	};
}
