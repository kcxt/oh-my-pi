import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --auto-title flag", () => {
	it("is a valueless opt-in that leaves the next flag alone", () => {
		const result = parseArgs(["--mode", "rpc", "--auto-title", "--model", "opus"]);
		expect(result.autoTitle).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
	});

	it("is off unless given", () => {
		expect(parseArgs(["--mode", "rpc"]).autoTitle).toBeUndefined();
	});
});
