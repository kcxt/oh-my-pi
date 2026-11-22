import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { crossRootWarning, findGitRoot, noteBashCwd } from "@oh-my-pi/pi-coding-agent/utils/bash-cd-root";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("cross git-root warning", () => {
	let root: string;
	const session = {};

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cd-root-"));
		for (const name of ["a", "b"]) {
			await fs.mkdir(path.join(root, name, ".git"), { recursive: true });
			await fs.mkdir(path.join(root, name, "src"), { recursive: true });
		}
	});

	afterEach(async () => {
		noteBashCwd(session, undefined);
		await removeWithRetries(root);
	});

	it("finds the nearest git root", () => {
		expect(findGitRoot(path.join(root, "a", "src"))).toBe(path.join(root, "a"));
		expect(findGitRoot(path.parse(root).root)).toBeUndefined();
	});

	it("warns naming both roots when the last bash command ran in another checkout", () => {
		noteBashCwd(session, path.join(root, "b", "src"));
		const warning = crossRootWarning(session, path.join(root, "a", "src", "x.ts"));
		expect(warning).toContain(path.join(root, "a"));
		expect(warning).toContain(path.join(root, "b"));
	});

	it("stays quiet in the same root, without a recorded cd, or after a command that did not cd", () => {
		const file = path.join(root, "a", "src", "x.ts");
		expect(crossRootWarning(session, file)).toBeUndefined();
		noteBashCwd(session, path.join(root, "a"));
		expect(crossRootWarning(session, file)).toBeUndefined();
		noteBashCwd(session, path.join(root, "b"));
		noteBashCwd(session, undefined);
		expect(crossRootWarning(session, file)).toBeUndefined();
	});
});
