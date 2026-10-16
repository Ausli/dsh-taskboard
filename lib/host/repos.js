/** Default TTL of the per-workspace discovery cache (aligns routes' git-detect TTL). */
const CACHE_TTL_MS = 6e4;
/** Skip-listed directory names at every level of the scan. */
const SKIP_DIRS = /* @__PURE__ */ new Set([
	"node_modules",
	".dsh-worktrees",
	"lib",
	"dist",
	"build",
	"out",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	"target",
	".next",
	".nuxt",
	".cache",
	".gradle",
	"Pods"
]);
/** Real IO over node:fs/promises (dynamic import like the git face). */
const realRepoIo = {
	async readDir(dir) {
		try {
			const { readdir } = await import("node:fs/promises");
			return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	},
	async hasGitDir(dir) {
		try {
			const { stat } = await import("node:fs/promises");
			return (await stat(`${dir}/.git`)).isDirectory();
		} catch {
			return false;
		}
	}
};
/**
* Build a scanner over an injectable IO face.
* @param io - the IO face (real filesystem when omitted).
* @param ttlMs - cache lifetime; `0` disables caching (tests).
*/
function createRepoScanner(io = realRepoIo, ttlMs = CACHE_TTL_MS) {
	const cache = /* @__PURE__ */ new Map();
	const scanDir = async (dir, rel, depth, out) => {
		if (depth > 3) return;
		const names = (await io.readDir(dir)).slice().sort();
		for (const name of names) {
			if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
			const childRel = rel.length === 0 ? name : `${rel}/${name}`;
			const childAbs = `${dir}/${name}`;
			if (await io.hasGitDir(childAbs)) {
				out.push({
					relPath: childRel,
					absPath: childAbs
				});
				continue;
			}
			try {
				await scanDir(childAbs, childRel, depth + 1, out);
			} catch {}
		}
	};
	return {
		async findNestedRepos(workspacePath) {
			const root = workspacePath.replace(/[\\/]+$/, "");
			const now = Date.now();
			const cached = cache.get(root);
			if (ttlMs > 0 && cached !== void 0 && now - cached.at < ttlMs) return cached.repos;
			const out = [];
			try {
				await scanDir(root, "", 1, out);
			} catch {}
			if (ttlMs > 0) cache.set(root, {
				at: now,
				repos: out
			});
			return out;
		},
		clearCache() {
			cache.clear();
		}
	};
}
//#endregion
export { createRepoScanner };

//# sourceMappingURL=repos.js.map