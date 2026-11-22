import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC dispatch over a session persisted under the test's temp root; only model replies are scripted.
// The root arrives as argv so storage can never land in an inherited cwd such as the repo checkout.
// A prompt mentioning "slow" streams until the test aborts it; "echo" answers with the JSON of the
// context the model received; everything else answers "Done".
const root = process.argv[2];
if (!root || root.startsWith("-")) throw new Error("host-rpc-agent: expected the temp root as the first argument");
process.chdir(root);
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const mock = createMockModel({
	handler: context => {
		const last = JSON.stringify(context.messages.at(-1)?.content);
		if (last.includes("echo")) return { content: [JSON.stringify(context.messages)] };
		if (!last.includes("slow")) return { content: ["Done"] };
		// The delay only bounds a leaked process; the test aborts the turn.
		return { content: ["Done"], delayMs: 600_000 };
	},
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const recapSeconds = Number(process.env.HOST_RPC_RECAP_SECONDS) || undefined;
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
	// Idle recap is off unless the test asks for it (HOST_RPC_RECAP_SECONDS), so a settled turn owes nothing.
	settings: Settings.isolated({
		"compaction.enabled": false,
		"compaction.keepRecentTokens": 1,
		...(recapSeconds ? { "recap.enabled": true, "recap.idleSeconds": recapSeconds } : { "recap.enabled": false }),
	}),
	modelRegistry,
	sideStreamFn: mock.stream,
});
await runRpcMode(session);
