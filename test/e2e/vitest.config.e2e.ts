import { BaseSequencer } from "vitest/node";
import { defineConfig } from "vitest/config";

/**
 * Custom sequencer that sorts test files alphabetically by path.
 * Ensures 01-onboarding runs before 02-identity, etc.
 */
class AlphabeticalSequencer extends BaseSequencer {
	async sort(files: Array<{ moduleId: string } & Record<string, unknown>>) {
		return files.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
	}
}

export default defineConfig({
	test: {
		include: ["test/e2e/sections/**/*.test.ts"],
		globalSetup: ["test/e2e/setup.ts"],
		environment: "node",
		testTimeout: 30_000,
		hookTimeout: 180_000,
		// All test files in a single worker, sequentially
		pool: "forks",
		poolOptions: { forks: { singleFork: true } },
		fileParallelism: false,
		sequence: { sequencer: AlphabeticalSequencer },
		reporter: ["verbose"],
	},
});
