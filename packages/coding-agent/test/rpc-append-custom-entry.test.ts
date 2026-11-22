import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

describe("RPC append_custom_entry", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-custom-entry-"));
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

	test("journals a custom entry chained onto the leaf, persisted to the session file", async () => {
		await client.start();
		await client.promptAndWait("hello");
		const before = await client.getEntries();

		const { entryId } = await client.appendCustomEntry("oc_notice", { text: "compacted", n: 2 });

		const after = await client.getEntries();
		expect(after.leafId).toBe(entryId);
		const entry = after.entries.find(candidate => candidate.id === entryId);
		expect(entry).toMatchObject({
			type: "custom",
			customType: "oc_notice",
			data: { text: "compacted", n: 2 },
			parentId: before.leafId,
		});
		expect(typeof entry?.id).toBe("string");

		const { sessionFile } = await client.getState();
		const journal = parseSessionEntries(await Bun.file(sessionFile!).text());
		expect(journal.find(candidate => "id" in candidate && candidate.id === entryId)).toMatchObject({
			type: "custom",
			customType: "oc_notice",
			parentId: before.leafId,
		});
	}, 30_000);

	test("the entry is not a message and the model never receives it", async () => {
		await client.start();
		await client.promptAndWait("hello");
		await client.appendCustomEntry("oc_notice", { text: "SECRET-NOTICE-TEXT" });
		const messagesBefore = (await client.getMessages()).length;

		await client.promptAndWait("echo");

		expect(messagesBefore).toBe(2);
		const echoed = await client.getLastAssistantText();
		expect(echoed).toContain("hello");
		expect(echoed).not.toContain("SECRET-NOTICE-TEXT");
		expect(echoed).not.toContain("oc_notice");
	}, 30_000);

	test("rejects a missing customType", async () => {
		await client.start();
		expect(await rejectionOf(client.appendCustomEntry("", { a: 1 }))).toMatchObject({
			message: expect.stringMatching(/customType must be a non-empty string/),
		});
	}, 30_000);
});
