/**
 * Cross-checkout guard: a relative `read`/`edit` path resolves against the session cwd, while the agent's
 * shell may have `cd`'d into another git checkout (a worktree, a sibling clone). The bash tool records only
 * the cwd of its most recent command; read and edit compare that command's git root with the root their
 * path resolved to.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const lastBashCwd = new WeakMap<object, string>();

/** Record the directory the session's most recent bash command ran in; `undefined` when it ran in the session cwd. */
export function noteBashCwd(session: object, cwd: string | undefined): void {
	if (cwd) lastBashCwd.set(session, cwd);
	else lastBashCwd.delete(session);
}

/** Nearest ancestor of `from` (itself included) holding a `.git` entry, or `undefined`. */
export function findGitRoot(from: string): string | undefined {
	let dir = path.resolve(from);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * One-line warning when the most recent bash command ran in a different git root than `resolvedPath`'s,
 * or `undefined` (same root, no recorded `cd`, or either side outside a repository).
 */
export function crossRootWarning(session: object, resolvedPath: string): string | undefined {
	const bashCwd = lastBashCwd.get(session);
	if (!bashCwd) return undefined;
	const bashRoot = findGitRoot(bashCwd);
	const pathRoot = findGitRoot(path.dirname(resolvedPath));
	if (!bashRoot || !pathRoot || bashRoot === pathRoot) return undefined;
	return `warning: ${resolvedPath} resolved in git root ${pathRoot}, but your last bash command ran in ${bashRoot}. If you meant that checkout, pass the absolute path.`;
}
