/**
 * InfraManager — spin up isolated postgres + uvicorn for E2E tests.
 *
 * Mirrors the logic of scripts/e2e-lib.sh but in Node.js so tests
 * stay in a single language with proper async error handling.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { projectRoot } from "./helpers.js";

// Same constants as e2e-lib.sh — must match exactly
const SERVER_ENC_KEY =
	"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const POW_RSA_MODULUS =
	"b478d0cecc88e31c55705ee5d4bf618ebbd36a3a831f353542c75a1b4f98e98de6115d94c73eaa55a955ada8ef6d9ce6e76883f80dd04d3e81d589796c0bd540b3ce2119376937e4dd15f4f3299220eca7562e8832dfaa329616260be1e445ce90c1affbd24476e3ad70c6bff8483d528ba7553ba69fd188a5975e0ec9f03358ac85f02cab679e9cfec3f279672400b9d02579852409ac0d99f9a02d8a0899af6992268b25ad178ea25a1e2c9f8135e404dbed0f5c0921c4156f6756978dd40f588114d3327d2d79457e5ea4c533e9571031420302963762241ea7e6f16391b8849ecced5b5d249ad93e76696a005943369cfdc914f662637bc09615371c16c1";

const POW_RSA_PHI =
	"b478d0cecc88e31c55705ee5d4bf618ebbd36a3a831f353542c75a1b4f98e98de6115d94c73eaa55a955ada8ef6d9ce6e76883f80dd04d3e81d589796c0bd540b3ce2119376937e4dd15f4f3299220eca7562e8832dfaa329616260be1e445ce90c1affbd24476e3ad70c6bff8483d528ba7553ba69fd188a5975e0ec9f03356fe0b6b1ddf6d17272c90fb390fe3022d6557ad52d0d13117edbbee427d5f29a421ab55de8283dbcc7178945f7183c9fc431164054bcfd81a76737e99c7f4460426d8b1697201a8f9bd89d74693f5fd949e48288113ec2659752a89c9ceb13f0affd342658fa59b8c2b78141e946aab30b3d0247010a1531a3bdf57f3a7b1d7d4";

const PG_PASSWORD = "e2e_test_pw";

export interface InfraHandles {
	apiUrl: string;
	cleanup: () => Promise<void>;
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (!addr || typeof addr === "string") {
				srv.close();
				reject(new Error("Could not get port"));
				return;
			}
			const port = addr.port;
			srv.close(() => resolve(port));
		});
	});
}

function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const check = async () => {
			try {
				const res = await fetch(`${url}/health`, {
					signal: AbortSignal.timeout(2000),
				});
				if (res.ok) return resolve();
			} catch {
				// not ready yet
			}
			if (Date.now() - start > timeoutMs) {
				return reject(new Error(`Server at ${url} not healthy after ${timeoutMs}ms`));
			}
			setTimeout(check, 500);
		};
		check();
	});
}

function waitForDocker(container: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const check = () => {
			try {
				const status = execSync(
					`docker inspect --format='{{.State.Health.Status}}' ${container}`,
					{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
				).trim();
				if (status === "'healthy'" || status === "healthy") return resolve();
			} catch {
				// not ready
			}
			if (Date.now() - start > timeoutMs) {
				return reject(new Error(`Docker ${container} not healthy after ${timeoutMs}ms`));
			}
			setTimeout(check, 1000);
		};
		check();
	});
}

export async function startInfra(name = "mcp"): Promise<InfraHandles> {
	const pgPort = await findFreePort();
	const apiPort = await findFreePort();
	const container = `rine-e2e-${name}-pg-${process.pid}`;
	const dbUrl = `postgresql+asyncpg://rine:${PG_PASSWORD}@localhost:${pgPort}/rine`;
	const apiUrl = `http://localhost:${apiPort}`;
	const root = projectRoot();
	let uvicornProc: ChildProcess | undefined;

	const cleanup = async () => {
		if (uvicornProc) {
			uvicornProc.kill();
			uvicornProc = undefined;
		}
		if (process.env.RINE_E2E_KEEP === "true") {
			console.error(`[e2e] --keep: leaving ${container} on port ${pgPort}`);
		} else {
			try {
				execSync(`docker rm -f ${container}`, {
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch {
				// already removed
			}
		}
	};

	// Start postgres
	console.error(`[e2e] Starting postgres ${container} on port ${pgPort}...`);
	execSync(
		[
			"docker run -d",
			`--name ${container}`,
			`-e POSTGRES_DB=rine`,
			`-e POSTGRES_USER=rine`,
			`-e POSTGRES_PASSWORD=${PG_PASSWORD}`,
			`-p ${pgPort}:5432`,
			'--health-cmd "pg_isready -U rine"',
			"--health-interval 2s",
			"--health-timeout 3s",
			"--health-retries 15",
			"pgvector/pgvector:pg17",
		].join(" "),
		{ cwd: root, stdio: ["pipe", "pipe", "pipe"] },
	);

	await waitForDocker(container);
	console.error("[e2e] Postgres ready.");

	// Alembic migrations
	console.error("[e2e] Running alembic migrations...");
	execSync("uv run python -m alembic upgrade head", {
		cwd: root,
		env: {
			...process.env,
			DATABASE_URL: dbUrl,
			SERVER_ENCRYPTION_KEY: SERVER_ENC_KEY,
			PYTHONPATH: "src",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	console.error("[e2e] Migrations complete.");

	// Start uvicorn
	console.error(`[e2e] Starting uvicorn on port ${apiPort}...`);
	uvicornProc = spawn(
		"uv",
		[
			"run",
			"uvicorn",
			"rine.api.app:app",
			"--host",
			"127.0.0.1",
			"--port",
			String(apiPort),
			"--log-level",
			"warning",
		],
		{
			cwd: root,
			env: {
				...process.env,
				DATABASE_URL: dbUrl,
				SERVER_ENCRYPTION_KEY: SERVER_ENC_KEY,
				BASE_URL: apiUrl,
				ENVIRONMENT: "dev",
				POW_DIFFICULTY: "100",
				POW_RSA_MODULUS,
				POW_RSA_PHI,
				PYTHONPATH: "src",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	// Don't let uvicorn errors crash the test runner
	uvicornProc.on("error", (err) => {
		console.error("[e2e] uvicorn error:", err.message);
	});

	await waitForHealth(apiUrl);
	console.error("[e2e] Server ready.");

	return { apiUrl, cleanup };
}
