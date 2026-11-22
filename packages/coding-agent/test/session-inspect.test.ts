import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	isSessionLeaseHeld,
	ReadOnlySessionError,
	ReadOnlySessionStorage,
	type SessionStorage,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const PACKAGE_DIR = path.join(import.meta.dir, "..");
const SESSION_ID = "inspectfixture01";

const MODELS_YML = `providers:
  smoke:
    baseUrl: http://127.0.0.1:9/v1
    apiKey: dummy
    api: openai-completions
    models:
      - id: smoke-model
        name: Smoke Model
        contextWindow: 32000
        maxTokens: 4096
`;

describe("omp session inspect --json", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-inspect-"));
		await fs.mkdir(path.join(root, "work"));
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	/** A transcript with a saved model unless `model` is false. */
	async function writeFixture(options: { model?: boolean; savedModel?: string } = {}): Promise<string> {
		const lines = [
			{
				type: "session",
				version: 3,
				id: SESSION_ID,
				timestamp: "2026-11-22T00:00:00.000Z",
				cwd: path.join(root, "work"),
			},
			...(options.model === false
				? []
				: [
						{
							type: "model_change",
							id: "bbbb2222",
							parentId: null,
							timestamp: "2026-11-22T00:00:00.500Z",
							model: options.savedModel ?? "smoke/smoke-model",
							role: "default",
						},
					]),
			{
				type: "message",
				id: "aaaa1111",
				parentId: options.model === false ? null : "bbbb2222",
				timestamp: "2026-11-22T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: 1763769601000 },
			},
		];
		const file = path.join(root, "fixture.jsonl");
		await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		return file;
	}

	/** Isolated child: only PATH and throwaway dirs, a dummy-key provider, and the shared test lease directory. */
	function spawnInspect(args: string[], models = true) {
		const dir = path.join(root, "agent");
		return fs
			.mkdir(dir, { recursive: true })
			.then(() => (models ? Bun.write(path.join(dir, "models.yml"), MODELS_YML) : undefined))
			.then(() =>
				Bun.spawn(
					[
						process.execPath,
						"--preload",
						path.join(PACKAGE_DIR, "scripts", "omp.ts"),
						path.join(PACKAGE_DIR, "src", "cli.ts"),
						"session",
						"inspect",
						...args,
					],
					{
						cwd: path.join(root, "work"),
						env: {
							PATH: process.env.PATH ?? "",
							HOME: dir,
							PI_CODING_AGENT_DIR: dir,
							XDG_CONFIG_HOME: dir,
							XDG_STATE_HOME: dir,
							XDG_DATA_HOME: dir,
							TMPDIR: dir,
							PI_NO_TITLE: "1",
							PI_TEST_SESSION_OWNERS_DIR: process.env.PI_TEST_SESSION_OWNERS_DIR ?? "",
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				),
			);
	}

	async function run(args: string[], models = true) {
		const child = await spawnInspect(args, models);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	}

	async function snapshot(file: string) {
		return {
			bytes: Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64"),
			siblings: (await fs.readdir(root)).sort(),
		};
	}

	test("prints one JSON object shaped like a live session's report", async () => {
		const file = await writeFixture();
		const { stdout, stderr, code } = await run(["--json", file]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(stdout.trimEnd().split("\n")).toHaveLength(1);
		const report = JSON.parse(stdout);
		expect(report).toMatchObject({
			sessionId: SESSION_ID,
			title: null,
			model: { provider: "smoke", modelId: "smoke-model" },
			todoPhases: [],
			goal: null,
			leaseHeld: false,
		});
		expect(report.contextBreakdown).toMatchObject({
			model: { provider: "smoke", modelId: "smoke-model" },
			contextWindow: 32000,
		});
		expect(report.contextBreakdown.categories.map((category: { id: string }) => category.id)).toEqual(
			expect.arrayContaining(["systemPrompt", "systemTools", "messages"]),
		);
		expect(report.contextBreakdownReason).toBeUndefined();
		expect(Array.isArray(report.availableCommands)).toBe(true);
		expect(report.availableCommands.length).toBeGreaterThan(0);
		expect(report.availableCommands[0]).toMatchObject({ name: expect.any(String), source: expect.any(String) });
		expect(Object.keys(report).sort()).toEqual(
			[
				"availableCommands",
				"contextBreakdown",
				"goal",
				"leaseHeld",
				"model",
				"sessionId",
				"thinkingLevel",
				"title",
				"todoPhases",
			].sort(),
		);
	}, 60_000);

	test("falls back when the saved model's provider is unknown, reporting what was requested", async () => {
		const file = await writeFixture({ savedModel: "ghost/ghost-model" });
		const before = await snapshot(file);
		const { stdout, stderr, code } = await run(["--json", file]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.model).toEqual({ provider: "smoke", modelId: "smoke-model" });
		expect(report.modelFallback).toEqual({
			requested: "ghost/ghost-model",
			reason: expect.stringContaining("Could not restore model ghost/ghost-model"),
		});
		expect(report.modelFallback.reason).toContain("Using smoke/smoke-model");
		expect(report.contextBreakdown).toMatchObject({ model: { provider: "smoke", modelId: "smoke-model" } });
		expect((await snapshot(file)).bytes).toBe(before.bytes);
	}, 60_000);

	test("reports model null with the reason, exit 0, when the saved model is gone and none is available", async () => {
		const file = await writeFixture({ savedModel: "ghost/ghost-model" });
		const { stdout, code } = await run(["--json", file], false);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.model).toBeNull();
		expect(report.modelFallback).toMatchObject({
			requested: "ghost/ghost-model",
			reason: expect.stringContaining("Could not restore model ghost/ghost-model"),
		});
		expect(report.contextBreakdown).toBeNull();
		expect(report.contextBreakdownReason).toMatch(/no model/);
	}, 60_000);

	test("reports null with a reason when no model is selected", async () => {
		const file = await writeFixture({ model: false });
		const { stdout, code } = await run(["--json", file], false);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.model).toBeNull();
		expect(report.contextBreakdown).toBeNull();
		expect(report.contextBreakdownReason).toMatch(/no model/);
	}, 60_000);

	test("leaves the transcript byte-identical and takes no lease, even when killed mid-run", async () => {
		const file = await writeFixture();
		const before = await snapshot(file);

		const finished = await run(["--json", file]);
		expect(finished.code).toBe(0);
		expect(await snapshot(file)).toEqual({ ...before, siblings: expect.arrayContaining(before.siblings) });
		expect(isSessionLeaseHeld(SESSION_ID)).toBe(false);

		const killed = await spawnInspect(["--json", file]);
		await Bun.sleep(300);
		killed.kill("SIGKILL");
		await killed.exited;
		expect((await snapshot(file)).bytes).toBe(before.bytes);
		expect(isSessionLeaseHeld(SESSION_ID)).toBe(false);
		// A later process can still own the session: nothing was left locked.
		const lease = tryAcquireSessionLease(SESSION_ID);
		expect(lease).not.toBeNull();
		lease?.release();
	}, 60_000);

	test("a read-only manager drops every append and refuses every write", async () => {
		const file = await writeFixture();
		const before = await snapshot(file);
		const manager = await SessionManager.openReadOnly(file);
		const entriesBefore = manager.getEntries().length;

		manager.appendCustomEntry("note", { a: 1 });
		manager.appendThinkingLevelChange("high");
		await manager.flush();
		await manager.close();

		expect(manager.getEntries()).toHaveLength(entriesBefore);
		expect(manager.claimOwnership()).toBe(true);
		expect(isSessionLeaseHeld(SESSION_ID)).toBe(false);
		expect(await snapshot(file)).toEqual(before);
		const storage: SessionStorage = new ReadOnlySessionStorage();
		expect(() => storage.writeTextSync(file, "x")).toThrow(ReadOnlySessionError);
		expect(() => storage.openWriter(file)).toThrow(ReadOnlySessionError);
		expect(storage.claimSession).toBeUndefined();
	});

	test("works while another process holds the lease: no refusal, no sibling file, nothing written", async () => {
		const file = await writeFixture();
		const before = await snapshot(file);
		const owner = tryAcquireSessionLease(SESSION_ID);
		expect(owner).not.toBeNull();
		try {
			const { stdout, stderr, code } = await run(["--json", file]);
			expect(stderr).toBe("");
			expect(code).toBe(0);
			expect(JSON.parse(stdout)).toMatchObject({ sessionId: SESSION_ID, leaseHeld: true });
			const after = await snapshot(file);
			expect(after.bytes).toBe(before.bytes);
			expect(after.siblings.filter(name => name.endsWith(".jsonl"))).toEqual(["fixture.jsonl"]);
			expect(await fs.readdir(path.join(root, "work"))).toEqual([]);
			// The owner kept its lease throughout.
			expect(isSessionLeaseHeld(SESSION_ID)).toBe(true);
		} finally {
			owner?.release();
		}
	}, 60_000);

	test("errors cleanly for a file with no session header and for a missing file", async () => {
		const headerless = path.join(root, "headerless.jsonl");
		await Bun.write(headerless, `${JSON.stringify({ type: "message", id: "x", parentId: null })}\n`);
		const bad = await run(["--json", headerless]);
		expect(bad.code).toBe(1);
		expect(bad.stdout).toBe("");
		expect(bad.stderr).toMatch(/error: .*header/i);
		expect(await Bun.file(headerless).text()).toBe(
			`${JSON.stringify({ type: "message", id: "x", parentId: null })}\n`,
		);

		const missing = await run(["--json", path.join(root, "nope.jsonl")]);
		expect(missing.code).toBe(1);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toMatch(/error: .*not found/i);

		const noFlag = await run([headerless]);
		expect(noFlag.code).not.toBe(0);
		expect(noFlag.stdout).toBe("");
	}, 60_000);
});
