import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient, RpcCommandError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

const MODEL = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

describe("RPC switch_session claimLease", () => {
	const clients: RpcClient[] = [];
	const directories: string[] = [];

	// Every process shares one root: a session records its cwd, and a switch to another cwd is refused.
	async function spawn(): Promise<RpcClient> {
		const directory = directories[0] ?? (await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-claim-lease-")));
		if (directories.length === 0) directories.push(directory);
		const client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "host-rpc-agent.ts"), directory],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		clients.push(client);
		await client.start();
		return client;
	}

	beforeEach(() => {
		clients.length = 0;
		directories.length = 0;
	});

	afterEach(async () => {
		const ownClients = [...clients];
		const ownDirectories = [...directories];
		for (const client of ownClients) await client.stop();
		for (const directory of ownDirectories) await removeWithRetries(directory);
	});

	test("refuses a session another process owns, leaving the current session untouched", async () => {
		const owner = await spawn();
		await owner.promptAndWait("hello");
		const owned = await owner.getState();

		const claimer = await spawn();
		const before = await claimer.getState();
		const refusal = await rejectionOf(claimer.switchSession(owned.sessionFile!, MODEL, { claimLease: true }));
		expect(refusal).toBeInstanceOf(RpcCommandError);
		expect(refusal).toMatchObject({ code: "session_busy" });

		const after = await claimer.getState();
		expect(after.sessionId).toBe(before.sessionId);
		expect(after.sessionFile).toBe(before.sessionFile);
	}, 60_000);

	test("claims a free session on open, and a later claimer is refused while it is held", async () => {
		const owner = await spawn();
		await owner.promptAndWait("hello");
		const target = await owner.getState();
		// Close the owner's session so its lease is free, keeping the file.
		await owner.newSession();
		expect((await owner.getSessionLease([target.sessionId])).held).toEqual([]);

		const claimer = await spawn();
		expect(await claimer.switchSession(target.sessionFile!, MODEL, { claimLease: true })).toEqual({
			cancelled: false,
		});
		// Held on open, before any write.
		expect((await owner.getSessionLease([target.sessionId])).held).toEqual([target.sessionId]);

		const late = await rejectionOf(owner.switchSession(target.sessionFile!, MODEL, { claimLease: true }));
		expect(late).toMatchObject({ code: "session_busy" });
		// Without the flag the switch still opens it, as before.
		expect(await owner.switchSession(target.sessionFile!, MODEL)).toEqual({ cancelled: false });
	}, 60_000);

	test("fails without a code for a path that holds no session", async () => {
		const client = await spawn();
		const missing = path.join(directories[0]!, "missing.jsonl");
		const failure = await rejectionOf(client.switchSession(missing, MODEL, { claimLease: true }));
		expect(failure).toMatchObject({ message: expect.stringMatching(/No session found/), code: undefined });
	}, 30_000);
});
