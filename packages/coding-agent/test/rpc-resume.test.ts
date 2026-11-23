import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleRpcResume } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

describe("RPC resume on a live process", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-rpc-resume-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "host-rpc-agent.ts"), directory],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		await client.start();
	});

	afterEach(async () => {
		const ownClient = client;
		const ownDirectory = directory;
		await ownClient.stop();
		await removeWithRetries(ownDirectory);
	});

	async function untilStreaming(): Promise<void> {
		for (let attempt = 0; attempt < 200; attempt++) {
			if ((await client.getState()).isStreaming) return;
			await Bun.sleep(25);
		}
		throw new Error("session never started streaming");
	}

	async function hostResumeEntries() {
		const { entries } = await client.getEntries();
		return entries.filter(entry => entry.type === "custom" && entry.customType === "host-resume");
	}

	test("an idle session continues without journaling a user message", async () => {
		await client.promptAndWait("hello");
		const userMessagesBefore = (await client.getMessages()).filter(message => message.role === "user").length;
		const idle = Promise.withResolvers<void>();
		const off = client.onEvent(event => {
			if (event.type === "agent_end") idle.resolve();
		});

		await client.resume({ hostMessageId: "host-dot" });
		await idle.promise;
		off();

		expect(await hostResumeEntries()).toMatchObject([
			{ type: "custom", customType: "host-resume", data: { hostMessageId: "host-dot", text: "." } },
		]);
		const messages = await client.getMessages();
		expect(messages.filter(message => message.role === "user")).toHaveLength(userMessagesBefore);
		expect(messages.length).toBeGreaterThan(2);
		expect(JSON.stringify(messages)).not.toContain('"."');
	}, 30_000);

	test("without hostMessageId nothing is journaled but the continuation", async () => {
		await client.promptAndWait("hello");
		const idle = Promise.withResolvers<void>();
		const off = client.onEvent(event => {
			if (event.type === "agent_end") idle.resolve();
		});
		await client.resume();
		await idle.promise;
		off();
		expect(await hostResumeEntries()).toEqual([]);
	}, 30_000);

	test("answers once the continuation is admitted, while its run is still streaming", async () => {
		await client.promptAndWait("stall-on-continue");
		const restarted = Promise.withResolvers<void>();
		const off = client.onEvent(event => {
			if (event.type === "agent_start") restarted.resolve();
		});

		await client.resume({ hostMessageId: "host-long" });
		await restarted.promise;
		off();

		// An abort behind the continuation is not queued on it: it answers while the run streams.
		await client.abort();
		expect((await client.getState()).isStreaming).toBe(false);
	}, 30_000);

	test("a streaming session is interrupted and continued", async () => {
		await client.prompt("slow");
		await untilStreaming();
		let starts = 0;
		const restarted = Promise.withResolvers<void>();
		const off = client.onEvent(event => {
			if (event.type === "agent_start" && ++starts === 1) restarted.resolve();
		});

		await client.resume({ hostMessageId: "host-interrupt" });
		await restarted.promise;
		off();

		expect(await hostResumeEntries()).toMatchObject([{ data: { hostMessageId: "host-interrupt", text: "." } }]);
		await client.abort();
	}, 30_000);

	test("rejects with Nothing to resume on an empty session, keeping the marker", async () => {
		const failure = await rejectionOf(client.resume({ hostMessageId: "host-empty" }));
		expect(failure).toMatchObject({ message: expect.stringMatching(/Nothing to resume/) });
		expect(await hostResumeEntries()).toMatchObject([{ data: { hostMessageId: "host-empty" } }]);
	}, 30_000);

	test("rejects a malformed id and an unknown subagent", async () => {
		expect(await rejectionOf(client.resume({ hostMessageId: "" }))).toMatchObject({
			message: expect.stringMatching(/hostMessageId must be a non-empty string/),
		});
		expect(await rejectionOf(client.resume({ subagentId: "Ghost" }))).toMatchObject({
			message: expect.stringMatching(/Subagent event bus is unavailable|Ghost/),
		});
	}, 30_000);
});

describe("handleRpcResume on subagents", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let sessionDir: string;
	let subagentFile: string;
	let calls: string[];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		calls = [];
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-resume-sub-"));
		subagentFile = path.join(sessionDir, "SubagentA.jsonl");
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(() => {
		registry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		removeSyncWithRetries(sessionDir);
	});

	function emitLifecycle(id: string, status: SubagentLifecyclePayload["status"]): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile: subagentFile,
		} satisfies SubagentLifecyclePayload);
	}

	function fakeSession(label: string) {
		return {
			// The structural marker of a view session (see `isAgentViewSession`).
			activeToolExecutionUpdates: () => [],
			sessionManager: {
				appendCustomEntry: (customType: string, data?: unknown) => {
					calls.push(`${label}:append:${customType}:${JSON.stringify(data)}`);
				},
			},
			resume: async () => {
				calls.push(`${label}:resume`);
			},
		};
	}

	function registerLiveAgent(id: string, sessionFile: string): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: fakeSession(id) as never,
			sessionFile,
			status: "running",
		});
	}

	test("resumes the named subagent's session, journaling the marker there first", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", subagentFile);

		await handleRpcResume(fakeSession("main"), registry, { subagentId: "SubagentA", hostMessageId: "h1" });

		expect(calls).toEqual([
			`SubagentA:append:host-resume:${JSON.stringify({ hostMessageId: "h1", text: "." })}`,
			"SubagentA:resume",
		]);
	});

	test("reaches a subagent that already finished while it stays registered", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", subagentFile);
		AgentRegistry.global().setStatus("SubagentA", "idle");
		emitLifecycle("SubagentA", "completed");
		expect(registry.getSubagents()).toEqual([]);

		await handleRpcResume(fakeSession("main"), registry, { subagentId: "SubagentA" });

		expect(calls).toEqual(["SubagentA:resume"]);
	});

	test("resumes the main session itself when no subagent is named", async () => {
		await handleRpcResume(fakeSession("main"), registry, { hostMessageId: "h2" });
		expect(calls).toEqual([
			`main:append:host-resume:${JSON.stringify({ hostMessageId: "h2", text: "." })}`,
			"main:resume",
		]);
	});

	test("refuses an id this session never spawned", async () => {
		registerLiveAgent("Stranger", path.join(sessionDir, "Stranger.jsonl"));
		const failure = await rejectionOf(handleRpcResume(fakeSession("main"), registry, { subagentId: "Stranger" }));
		expect(failure).toMatchObject({ message: expect.stringMatching(/Stranger/) });
		expect(calls).toEqual([]);
	});

	test("refuses a same-named agent whose transcript is not this roster's", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", path.join(sessionDir, "elsewhere", "SubagentA.jsonl"));
		const failure = await rejectionOf(handleRpcResume(fakeSession("main"), registry, { subagentId: "SubagentA" }));
		expect(failure).toMatchObject({ message: expect.stringMatching(/Subagent not resumable/) });
		expect(calls).toEqual([]);
	});

	test("rejects a subagent id when there is no subagent bus", async () => {
		const failure = await rejectionOf(handleRpcResume(fakeSession("main"), undefined, { subagentId: "SubagentA" }));
		expect(failure).toMatchObject({ message: expect.stringMatching(/unavailable/) });
	});
});
