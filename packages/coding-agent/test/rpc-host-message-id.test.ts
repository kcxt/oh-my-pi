import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

type HostIdMessage = AgentMessage & { hostMessageId?: string };
type UserFrame = { type: string; hostMessageId?: string };

function storedUserIds(entries: readonly { type: string; message?: AgentMessage }[]): (string | undefined)[] {
	return entries.flatMap(entry =>
		entry.type === "message" && entry.message?.role === "user"
			? [(entry.message as HostIdMessage).hostMessageId]
			: [],
	);
}

describe("RPC hostMessageId", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-host-id-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "host-rpc-agent.ts"), directory],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		const ownClient = client;
		const ownDirectory = directory;
		await ownClient?.stop();
		await removeWithRetries(ownDirectory);
	});

	/** Records user-message frames; `ended(n)` resolves at the n-th `agent_end`. */
	function watch() {
		const frames: UserFrame[] = [];
		let ends = 0;
		const waiters: { count: number; resolve: () => void }[] = [];
		const off = client.onEvent(event => {
			if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user") {
				frames.push({ type: event.type, hostMessageId: (event.message as HostIdMessage).hostMessageId });
			}
			if (event.type === "agent_end") {
				ends++;
				for (const waiter of waiters) if (ends >= waiter.count) waiter.resolve();
			}
		});
		return {
			frames,
			ended: (count = 1) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				if (ends >= count) resolve();
				else waiters.push({ count, resolve });
				return promise;
			},
			stop: off,
		};
	}

	async function untilStreaming(): Promise<void> {
		for (let attempt = 0; attempt < 200; attempt++) {
			if ((await client.getState()).isStreaming) return;
			await Bun.sleep(25);
		}
		throw new Error("session never started streaming");
	}

	test("a prompt's id is journaled and echoed on its message_start and message_end", async () => {
		await client.start();
		const seen = watch();
		await client.prompt("hello", undefined, undefined, { hostMessageId: "host-1" });
		await seen.ended();
		seen.stop();

		expect(seen.frames).toEqual([
			{ type: "message_start", hostMessageId: "host-1" },
			{ type: "message_end", hostMessageId: "host-1" },
		]);
		expect(storedUserIds((await client.getEntries()).entries)).toEqual(["host-1"]);
	}, 30_000);

	test("messages sent without an id carry none", async () => {
		await client.start();
		const seen = watch();
		await client.prompt("plain");
		await seen.ended();
		seen.stop();
		expect(seen.frames.map(frame => frame.hostMessageId)).toEqual([undefined, undefined]);
	}, 30_000);

	test("abort_and_prompt journals the replacement with its id", async () => {
		await client.start();
		await client.prompt("slow", undefined, undefined, { hostMessageId: "slow-id" });
		await untilStreaming();
		const seen = watch();
		await client.abortAndPrompt("replacement", undefined, { hostMessageId: "replacement-id" });
		// The aborted run ends first, then the replacement's.
		await seen.ended(2);
		seen.stop();

		expect(seen.frames.map(frame => frame.hostMessageId)).toEqual(["replacement-id", "replacement-id"]);
		expect(storedUserIds((await client.getEntries()).entries)).toEqual(["slow-id", "replacement-id"]);
	}, 30_000);

	test("a queued steer and follow_up keep their ids once an abort drains the queue", async () => {
		await client.start();
		await client.prompt("slow");
		await untilStreaming();
		const seen = watch();
		await client.steer("redirect", undefined, { hostMessageId: "steer-id" });
		await client.followUp("later", undefined, { hostMessageId: "follow-id" });
		await client.abort();
		for (let attempt = 0; attempt < 200; attempt++) {
			if (storedUserIds((await client.getEntries()).entries).includes("follow-id")) break;
			await Bun.sleep(50);
		}
		seen.stop();

		const ids = storedUserIds((await client.getEntries()).entries);
		expect(ids).toContain("steer-id");
		expect(ids).toContain("follow-id");
		const framed = new Set(seen.frames.map(frame => frame.hostMessageId));
		expect(framed.has("steer-id")).toBe(true);
		expect(framed.has("follow-id")).toBe(true);
	}, 30_000);

	test("the id survives compaction, fork and reload", async () => {
		await client.start();
		const seen = watch();
		await client.prompt("first", undefined, undefined, { hostMessageId: "keep-me" });
		await seen.ended(1);
		await client.prompt("second");
		await seen.ended(2);
		seen.stop();
		const source = await client.getState();

		await client.compact();
		const { entries } = await client.getEntries();
		const keepEntry = entries.find(
			entry => entry.type === "message" && (entry.message as HostIdMessage).hostMessageId === "keep-me",
		);
		expect(keepEntry).toBeDefined();
		const sourceJournal = parseSessionEntries(await Bun.file(source.sessionFile!).text());
		expect(storedUserIds(sourceJournal)).toContain("keep-me");

		await client.fork(keepEntry!.id);
		const forked = await client.getState();
		expect(forked.sessionFile).not.toBe(source.sessionFile);
		expect(storedUserIds(parseSessionEntries(await Bun.file(forked.sessionFile!).text()))).toEqual(["keep-me"]);

		await client.switchSession(source.sessionFile!, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(storedUserIds((await client.getEntries()).entries)).toContain("keep-me");
	}, 60_000);

	test("rejects a hostMessageId that is not a non-empty string", async () => {
		await client.start();
		expect(await rejectionOf(client.prompt("x", undefined, undefined, { hostMessageId: "" }))).toMatchObject({
			message: expect.stringMatching(/hostMessageId must be a non-empty string/),
		});
	}, 30_000);
});
