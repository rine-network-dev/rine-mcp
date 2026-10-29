/**
 * Owner dirs — each org's root key lives apart from its config dir.
 *
 * A harness gives every config dir its own sibling owner dir, so a run never writes a
 * root key into the developer's real ~/.config/rine-owner (where the second org's
 * onboarding would collide with the first). Dirs that outlive their harness (the
 * sections persist theirs across test files) are recorded here; global teardown erases
 * the org each one holds when the server is a remote one, then removes them, except a dir whose
 * org could not be erased: its root key is the only record that can still name the org.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const OWNERS_FILE = join(import.meta.dirname, ".e2e-owner-dirs");

/** The sibling `<config dir>.owner`, the same rule as scripts/lib/org-owner-path.sh. */
export function ownerDirFor(configDir: string): string {
	return `${configDir}.owner`;
}

export function recordOwnerDir(ownerDir: string): void {
	appendFileSync(OWNERS_FILE, `${ownerDir}\n`);
}

function recordedOwnerDirs(): string[] {
	if (!existsSync(OWNERS_FILE)) return [];
	const lines = readFileSync(OWNERS_FILE, "utf-8").split("\n");
	return [...new Set(lines.filter((l) => l !== ""))];
}

/** `rine --json <args>` as the org whose root sits in `ownerDir`; the org principal needs the root alone. */
function rineJson(
	ownerDir: string,
	apiUrl: string,
	scratch: string,
	args: string[],
): Record<string, string> {
	const env = {
		...process.env,
		RINE_CONFIG_DIR: scratch,
		RINE_OWNER_DIR: ownerDir,
		RINE_API_URL: apiUrl,
	};
	return JSON.parse(
		execFileSync(process.env.RINE_CLI ?? "rine", ["--json", ...args], {
			env,
		}).toString(),
	);
}

/** DELETE /orgs/{id} with the org's own token. True when the server erased it; any other outcome is residue, never a throw. */
async function eraseOrg(ownerDir: string, apiUrl: string): Promise<boolean> {
	const scratch = `${ownerDir}.erase`;
	try {
		const token = rineJson(ownerDir, apiUrl, scratch, ["auth", "token"]);
		const org = rineJson(ownerDir, apiUrl, scratch, ["org", "get"]);
		if (!token.access_token || !org.id) {
			throw new Error("no org token or id from the owner dir");
		}
		const res = await fetch(`${apiUrl}/orgs/${org.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token.access_token}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) {
			console.error(
				`[e2e] RESIDUE: org=${org.id} slug=${org.slug} owner dir ${ownerDir} — DELETE /orgs/${org.id} answered ${res.status}`,
			);
			return false;
		}
		console.error(`[e2e] erased org=${org.id} slug=${org.slug}`);
		return true;
	} catch (e) {
		console.error(
			`[e2e] RESIDUE: owner dir ${ownerDir} — erase failed: ${(e as Error).message}`,
		);
		return false;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Global teardown: erase (remote runs only), then remove every recorded owner dir and the record. */
export async function releaseOwnerDirs(remoteApiUrl?: string): Promise<void> {
	for (const dir of recordedOwnerDirs()) {
		if (
			remoteApiUrl &&
			existsSync(join(dir, "root.key")) &&
			!(await eraseOrg(dir, remoteApiUrl))
		) {
			console.error(`[e2e] kept ${dir}: its root key names an org still on the server`);
			continue;
		}
		rmSync(dir, { recursive: true, force: true });
	}
	rmSync(OWNERS_FILE, { force: true });
}
