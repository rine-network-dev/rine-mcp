import { mkdtempSync, mkdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDir, runCli } from "../src/cli.js";

// runCli always appends "--json" to args. We use "bash" as a fake CLI
// since bash -c ignores unknown trailing args gracefully.

function withBin(
	bin: string,
	fn: () => Promise<void>,
): () => Promise<void> {
	return async () => {
		const original = process.env.RINE_CLI_PATH;
		process.env.RINE_CLI_PATH = bin;
		try {
			await fn();
		} finally {
			if (original) process.env.RINE_CLI_PATH = original;
			else delete process.env.RINE_CLI_PATH;
		}
	};
}

function withEnv(
	vars: Record<string, string | undefined>,
	fn: () => void,
): () => void {
	return () => {
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(vars)) {
			saved[key] = process.env[key];
			if (vars[key] === undefined) delete process.env[key];
			else process.env[key] = vars[key];
		}
		try {
			fn();
		} finally {
			for (const key of Object.keys(saved)) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	};
}

describe("configDir", () => {
	it("uses RINE_CONFIG_DIR when set", withEnv(
		{ RINE_CONFIG_DIR: "/custom/path" },
		() => {
			expect(configDir()).toBe("/custom/path");
		},
	));

	it("uses cwd/.rine when it exists", withEnv(
		{ RINE_CONFIG_DIR: undefined },
		() => {
			// cwd is the rine-mcp/ dir which has no .rine/, but we can test
			// the fallback chain by checking it doesn't return cwd/.rine
			// when that dir doesn't exist
			const result = configDir();
			expect(result).not.toBe(join(process.cwd(), ".rine"));
			expect(result).toBe(join(homedir(), ".config", "rine"));
		},
	));

	it("falls back to ~/.config/rine when no local .rine exists", withEnv(
		{ RINE_CONFIG_DIR: undefined },
		() => {
			const result = configDir();
			expect(result).toBe(join(homedir(), ".config", "rine"));
		},
	));

	it("prefers local .rine over ~/.config/rine", () => {
		// Create a temp dir with a .rine inside, chdir there
		const tmp = mkdtempSync(join("/tmp", "rine-test-"));
		const dotRine = join(tmp, ".rine");
		mkdirSync(dotRine);
		const originalCwd = process.cwd();
		const originalEnv = process.env.RINE_CONFIG_DIR;
		delete process.env.RINE_CONFIG_DIR;
		process.chdir(tmp);
		try {
			expect(configDir()).toBe(dotRine);
		} finally {
			process.chdir(originalCwd);
			if (originalEnv) process.env.RINE_CONFIG_DIR = originalEnv;
			rmdirSync(dotRine);
			rmdirSync(tmp);
		}
	});
});

describe("runCli", () => {
	it("throws on missing binary", withBin("/nonexistent/xyz", async () => {
		await expect(runCli(["whoami"])).rejects.toThrow(/rine CLI not found/);
	}));

	it("throws on non-zero exit code with stderr", withBin("bash", async () => {
		await expect(
			runCli(["-c", "echo bad >&2; exit 1"]),
		).rejects.toThrow("bad");
	}));

	it("throws on invalid JSON output", withBin("bash", async () => {
		await expect(
			runCli(["-c", "echo not-json"]),
		).rejects.toThrow(/Failed to parse CLI output/);
	}));

	it("parses valid JSON from successful command", withBin("bash", async () => {
		const result = await runCli(["-c", 'echo \'{"ok":true}\''  ]);
		expect(result).toEqual({ ok: true });
	}));

	it("writes stdin data to child process", withBin("bash", async () => {
		const result = await runCli(
			["-c", "cat"],
			{ stdin: '{"hello":"world"}' },
		);
		expect(result).toEqual({ hello: "world" });
	}));

	it("respects timeout", async () => {
		const original = process.env.RINE_CLI_PATH;
		const originalTimeout = process.env.RINE_MCP_TIMEOUT;
		process.env.RINE_CLI_PATH = "bash";
		process.env.RINE_MCP_TIMEOUT = "500";
		try {
			await expect(
				runCli(["-c", "sleep 10"]),
			).rejects.toThrow(/Timeout/);
		} finally {
			if (original) process.env.RINE_CLI_PATH = original;
			else delete process.env.RINE_CLI_PATH;
			if (originalTimeout) process.env.RINE_MCP_TIMEOUT = originalTimeout;
			else delete process.env.RINE_MCP_TIMEOUT;
		}
	});
});
