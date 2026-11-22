import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcRecapFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("RPC idle maintenance", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	async function spawn(recapSeconds?: number): Promise<RpcClient> {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-idle-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "host-rpc-agent.ts"), directory],
			cwd: directory,
			env: {
				PI_CODING_AGENT_DIR: directory,
				PI_NO_TITLE: "1",
				...(recapSeconds ? { HOST_RPC_RECAP_SECONDS: String(recapSeconds) } : {}),
			},
		});
		await client.start();
		return client;
	}

	afterEach(async () => {
		const ownClient = client;
		const ownDirectory = directory;
		client = undefined;
		directory = undefined;
		await ownClient?.stop();
		if (ownDirectory) await removeWithRetries(ownDirectory);
	});

	test("get_state omits idleMaintenance when nothing is owed", async () => {
		const rpc = await spawn();
		expect("idleMaintenance" in (await rpc.getState())).toBe(false);
		await rpc.promptAndWait("hello");
		await rpc.waitForSettled();
		expect("idleMaintenance" in (await rpc.getState())).toBe(false);
	}, 30_000);

	test("an owed recap shows its due time, then arrives as a recap frame and the field clears", async () => {
		const rpc = await spawn(2);
		const recaps: RpcRecapFrame[] = [];
		rpc.onRecap(frame => recaps.push(frame));
		const before = Date.now();
		await rpc.promptAndWait("hello");

		let due: number | undefined;
		for (let attempt = 0; attempt < 100 && due === undefined && recaps.length === 0; attempt++) {
			due = (await rpc.getState()).idleMaintenance?.recapDueAt;
			if (due === undefined) await Bun.sleep(25);
		}
		expect(due).toBeDefined();
		expect(due!).toBeGreaterThan(before);
		expect(due!).toBeLessThanOrEqual(Date.now() + 2_500);
		expect((await rpc.getState()).idleMaintenance?.compactionDueAt).toBeUndefined();

		for (let attempt = 0; attempt < 200 && recaps.length === 0; attempt++) await Bun.sleep(50);
		expect(recaps).toHaveLength(1);
		expect(recaps[0]).toMatchObject({ type: "recap", recap: "Done" });
		expect(recaps[0]!.createdAt).toBeGreaterThanOrEqual(due!);

		expect("idleMaintenance" in (await rpc.getState())).toBe(false);
	}, 30_000);

	test("new activity supersedes the owed recap", async () => {
		const rpc = await spawn(2);
		await rpc.promptAndWait("hello");
		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await rpc.getState()).idleMaintenance?.recapDueAt !== undefined) break;
			await Bun.sleep(25);
		}
		await rpc.prompt("slow");
		for (let attempt = 0; attempt < 100 && !(await rpc.getState()).isStreaming; attempt++) await Bun.sleep(25);
		expect("idleMaintenance" in (await rpc.getState())).toBe(false);
		await rpc.abort();
	}, 30_000);
});
