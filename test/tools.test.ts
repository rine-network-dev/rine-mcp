import { describe, expect, it } from "vitest";
import { tools } from "../src/tools.js";

describe("tool definitions", () => {
	it("exports 14 tools", () => {
		expect(tools).toHaveLength(14);
	});

	it("all tools have unique names", () => {
		const names = tools.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("all tool names use rine_ prefix", () => {
		for (const t of tools) {
			expect(t.name).toMatch(/^rine_/);
		}
	});

	it("all tools have description and inputSchema", () => {
		for (const t of tools) {
			expect(t.description).toBeTruthy();
			expect(t.inputSchema).toBeDefined();
			expect(t.inputSchema.type).toBe("object");
		}
	});
});

describe("rine_send buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_send")!;

	it("builds args with required params", () => {
		const { args, stdin } = tool.buildArgs({
			to: "bot@acme.rine.network",
			payload: { task: "hello" },
		});
		expect(args).toEqual([
			"send", "--to", "bot@acme.rine.network", "--payload-file", "-",
		]);
		expect(stdin).toBe('{"task":"hello"}');
	});

	it("includes optional type and agent", () => {
		const { args } = tool.buildArgs({
			to: "bot@acme.rine.network",
			payload: { x: 1 },
			type: "rine.v1.task_request",
			agent: "my-agent",
		});
		expect(args).toContain("--type");
		expect(args).toContain("rine.v1.task_request");
		expect(args).toContain("--as");
		expect(args).toContain("my-agent");
	});
});

describe("rine_inbox buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_inbox")!;

	it("builds minimal args", () => {
		const { args } = tool.buildArgs({});
		expect(args).toEqual(["inbox"]);
	});

	it("includes limit and cursor", () => {
		const { args } = tool.buildArgs({ limit: 5, cursor: "abc123" });
		expect(args).toContain("--limit");
		expect(args).toContain("5");
		expect(args).toContain("--cursor");
		expect(args).toContain("abc123");
	});
});

describe("rine_read buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_read")!;

	it("passes message_id as positional arg", () => {
		const { args } = tool.buildArgs({ message_id: "uuid-123" });
		expect(args).toEqual(["read", "uuid-123"]);
	});
});

describe("rine_reply buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_reply")!;

	it("uses stdin for payload", () => {
		const { args, stdin } = tool.buildArgs({
			message_id: "uuid-456",
			payload: { result: "done" },
		});
		expect(args).toEqual([
			"reply", "uuid-456", "--payload-file", "-",
		]);
		expect(stdin).toBe('{"result":"done"}');
	});
});

describe("rine_discover buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_discover")!;

	it("builds empty args when no filters", () => {
		const { args } = tool.buildArgs({});
		expect(args).toEqual(["discover", "agents"]);
	});

	it("adds query and filters", () => {
		const { args } = tool.buildArgs({
			query: "invoice",
			category: "finance",
			verified: true,
		});
		expect(args).toContain("-q");
		expect(args).toContain("invoice");
		expect(args).toContain("--category");
		expect(args).toContain("finance");
		expect(args).toContain("--verified");
	});

	it("omits false booleans", () => {
		const { args } = tool.buildArgs({ verified: false });
		expect(args).not.toContain("--verified");
	});
});

describe("rine_inspect buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_inspect")!;

	it("passes agent as positional arg", () => {
		const { args } = tool.buildArgs({ agent: "bot@acme.rine.network" });
		expect(args).toEqual(["discover", "inspect", "bot@acme.rine.network"]);
	});
});

describe("rine_group_create buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_group_create")!;

	it("builds with required name", () => {
		const { args } = tool.buildArgs({ name: "my-group" });
		expect(args).toEqual(["group", "create", "--name", "my-group"]);
	});

	it("adds enrollment and visibility", () => {
		const { args } = tool.buildArgs({
			name: "secret",
			enrollment: "majority",
			visibility: "private",
		});
		expect(args).toContain("--enrollment");
		expect(args).toContain("majority");
		expect(args).toContain("--visibility");
		expect(args).toContain("private");
	});
});

describe("rine_group_invite buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_group_invite")!;

	it("builds with group_id and agent", () => {
		const { args } = tool.buildArgs({
			group_id: "grp-uuid",
			agent: "bot@acme.rine.network",
		});
		expect(args).toEqual([
			"group", "invite", "grp-uuid",
			"--agent", "bot@acme.rine.network",
		]);
	});

	it("includes optional message", () => {
		const { args } = tool.buildArgs({
			group_id: "grp-uuid",
			agent: "bot-id",
			message: "Join our team!",
		});
		expect(args).toContain("--message");
		expect(args).toContain("Join our team!");
	});
});

describe("rine_groups buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_groups")!;

	it("builds minimal args", () => {
		const { args } = tool.buildArgs({});
		expect(args).toEqual(["group", "list"]);
	});

	it("includes agent via --as", () => {
		const { args } = tool.buildArgs({ agent: "my-agent" });
		expect(args).toContain("--as");
		expect(args).toContain("my-agent");
	});
});

describe("rine_group_join buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_group_join")!;

	it("builds with group_id", () => {
		const { args } = tool.buildArgs({ group_id: "grp-123" });
		expect(args).toEqual(["group", "join", "grp-123"]);
	});

	it("includes optional message", () => {
		const { args } = tool.buildArgs({
			group_id: "grp-123",
			message: "Let me in!",
		});
		expect(args).toContain("--message");
		expect(args).toContain("Let me in!");
	});
});

describe("rine_group_members buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_group_members")!;

	it("passes group_id as positional arg", () => {
		const { args } = tool.buildArgs({ group_id: "grp-456" });
		expect(args).toEqual(["group", "members", "grp-456"]);
	});
});

describe("rine_poll", () => {
	const tool = tools.find((t) => t.name === "rine_poll")!;

	it("buildArgs throws (poll uses HTTP, not CLI dispatch)", () => {
		expect(() => tool.buildArgs({})).toThrow(/HTTP fetch/);
	});
});

describe("rine_send idempotency_key", () => {
	const tool = tools.find((t) => t.name === "rine_send")!;

	it("passes idempotency_key as --idempotency-key", () => {
		const { args } = tool.buildArgs({
			to: "bot@test.rine.network",
			payload: { x: 1 },
			idempotency_key: "unique-key-123",
		});
		expect(args).toContain("--idempotency-key");
		expect(args).toContain("unique-key-123");
	});
});

describe("rine_whoami buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_whoami")!;

	it("takes no params", () => {
		const { args } = tool.buildArgs({});
		expect(args).toEqual(["whoami"]);
	});
});

describe("rine_discover_groups buildArgs", () => {
	const tool = tools.find((t) => t.name === "rine_discover_groups")!;

	it("builds with query", () => {
		const { args } = tool.buildArgs({ query: "finance" });
		expect(args).toContain("-q");
		expect(args).toContain("finance");
	});
});
