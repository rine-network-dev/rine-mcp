import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT = 30_000;

/** Resolve the rine CLI binary path. */
function rinePath(): string {
	return process.env.RINE_CLI_PATH ?? "rine";
}

/**
 * Resolve the rine config directory.
 * Priority: $RINE_CONFIG_DIR > cwd/.rine (if exists) > ~/.config/rine
 */
export function configDir(): string {
	if (process.env.RINE_CONFIG_DIR) return process.env.RINE_CONFIG_DIR;
	const local = join(process.cwd(), ".rine");
	if (existsSync(local)) return local;
	return join(homedir(), ".config", "rine");
}

/** Max execution time for CLI commands. */
function timeout(): number {
	const val = process.env.RINE_MCP_TIMEOUT;
	return val ? Number.parseInt(val, 10) : DEFAULT_TIMEOUT;
}

/**
 * Execute a rine CLI command with --json and return parsed output.
 *
 * @param args - CLI arguments (--json is appended automatically)
 * @param opts.stdin - Optional data to write to stdin (for --payload-file -)
 */
export async function runCli(
	args: string[],
	opts?: { stdin?: string },
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const bin = rinePath();
		const proc = spawn(bin, [...args, "--json"], {
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			reject(new Error(`Timeout after ${timeout()}ms: rine ${args.join(" ")}`));
		}, timeout());

		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		proc.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (err.code === "ENOENT") {
				reject(
					new Error(
						`rine CLI not found at "${bin}". Install: npm i -g @rine-network/cli`,
					),
				);
			} else {
				reject(err);
			}
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(stderr.trim() || `rine exited with code ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(
					new Error(
						`Failed to parse CLI output as JSON.\nstdout: ${stdout}\nstderr: ${stderr}`,
					),
				);
			}
		});

		// Swallow EPIPE — the close handler will surface the real error
		proc.stdin.on("error", () => {});

		if (opts?.stdin) {
			proc.stdin.write(opts.stdin);
			proc.stdin.end();
		} else {
			proc.stdin.end();
		}
	});
}

/**
 * Read the poll_url from credentials.json for the given profile.
 * Returns null if not found.
 */
export async function readPollUrl(
	profile = "default",
): Promise<string | null> {
	try {
		const path = join(configDir(), "credentials.json");
		const data = JSON.parse(await readFile(path, "utf-8"));
		return data?.[profile]?.poll_url ?? null;
	} catch {
		return null;
	}
}

/**
 * Lightweight unauthenticated inbox count check via poll_url.
 * Generates a poll token if none exists.
 */
export async function poll(agent?: string): Promise<{ count: number }> {
	let url = await readPollUrl();

	if (!url) {
		try {
			const args = ["poll-token"];
			if (agent) args.push("--as", agent);
			const result = (await runCli(args)) as { poll_url: string };
			url = result.poll_url;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`No poll token found. Run "rine poll-token" after registering an agent. (${msg})`,
			);
		}
	}

	const res = await fetch(url, { signal: AbortSignal.timeout(timeout()) });
	if (!res.ok) {
		throw new Error(`Poll request failed: ${res.status} ${res.statusText}`);
	}
	const body = (await res.json()) as Record<string, unknown>;
	if (typeof body.count !== "number") {
		throw new Error(`Unexpected poll response: ${JSON.stringify(body)}`);
	}
	return { count: body.count };
}
