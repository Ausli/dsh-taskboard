import { join } from "node:path";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
//#region src/host/assets.ts
/** Durable, content-addressed image attachments for task descriptions/comments. */
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_STORE_BYTES = 200 * 1024 * 1024;
const ORPHAN_GRACE_MS = 1440 * 60 * 1e3;
const ASSET_NAME_RE = /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/;
/** Detect supported images from magic bytes; request MIME and filenames are not trusted. */
function detectImage(bytes) {
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return {
		extension: "png",
		mime: "image/png"
	};
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return {
		extension: "jpg",
		mime: "image/jpeg"
	};
	if (bytes.length >= 6) {
		const head = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
		if (head === "GIF87a" || head === "GIF89a") return {
			extension: "gif",
			mime: "image/gif"
		};
	}
	if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return {
		extension: "webp",
		mime: "image/webp"
	};
}
/** Files live outside the ledger so state/SSE/tool payloads only carry short Markdown URLs. */
var AssetStore = class {
	now;
	storageQueue;
	queue = Promise.resolve();
	root;
	constructor(root, now = () => Date.now(), storageQueue) {
		this.now = now;
		this.storageQueue = storageQueue;
		this.root = root;
	}
	/** Current absolute attachment-directory path. */
	location() {
		return this.root;
	}
	/** Switch reads and future writes after the coordinator copied the directory. */
	setLocation(root) {
		this.root = root;
	}
	async put(bytes, declaredMime) {
		const run = () => this.putSerial(bytes, declaredMime);
		if (this.storageQueue !== void 0) return this.storageQueue.run(run);
		return this.queue = this.queue.then(run, run);
	}
	async putSerial(bytes, declaredMime) {
		if (bytes.length === 0 || bytes.length > 5242880) throw new Error(`image must be 1..${MAX_ASSET_BYTES} bytes`);
		const kind = detectImage(bytes);
		if (kind === void 0) throw new Error("unsupported image; use PNG, JPEG, GIF, or WebP");
		if (declaredMime !== void 0 && declaredMime.toLowerCase() !== kind.mime) throw new Error(`image content does not match ${declaredMime}`);
		const id = createHash("sha256").update(bytes).digest("hex");
		const name = `${id}.${kind.extension}`;
		await mkdir(this.root, { recursive: true });
		try {
			const current = await stat(join(this.root, name));
			if (current.isFile()) return {
				id,
				name,
				size: current.size,
				url: `/dsh-taskboard/assets/${name}`,
				...kind
			};
		} catch {}
		let total = 0;
		for (const entry of await readdir(this.root, { withFileTypes: true })) {
			if (!entry.isFile() || !ASSET_NAME_RE.test(entry.name)) continue;
			try {
				total += (await stat(join(this.root, entry.name))).size;
			} catch {}
		}
		if (total + bytes.length > 209715200) throw new Error("image store quota exceeded");
		try {
			await writeFile(join(this.root, name), bytes, { flag: "wx" });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		return {
			id,
			name,
			size: bytes.length,
			url: `/dsh-taskboard/assets/${name}`,
			...kind
		};
	}
	async read(name) {
		const run = async () => {
			const match = ASSET_NAME_RE.exec(name);
			if (match === null) return void 0;
			const mime = match[2] === "png" ? "image/png" : match[2] === "jpg" ? "image/jpeg" : match[2] === "gif" ? "image/gif" : "image/webp";
			try {
				return {
					bytes: await readFile(join(this.root, name)),
					mime
				};
			} catch {
				return;
			}
		};
		return this.storageQueue === void 0 ? run() : this.storageQueue.run(run);
	}
	/** Remove abandoned draft uploads after a grace period; referenced files always survive. */
	async cleanup(referencedContent) {
		const run = async () => {
			let entries;
			try {
				entries = await readdir(this.root, { withFileTypes: true });
			} catch {
				return 0;
			}
			let removed = 0;
			for (const entry of entries) {
				if (!entry.isFile() || !ASSET_NAME_RE.test(entry.name) || referencedContent.includes(entry.name)) continue;
				const path = join(this.root, entry.name);
				try {
					const info = await stat(path);
					if (this.now() - info.mtimeMs < 864e5) continue;
					await rm(path, { force: true });
					removed += 1;
				} catch {}
			}
			return removed;
		};
		return this.storageQueue === void 0 ? run() : this.storageQueue.run(run);
	}
};
//#endregion
export { AssetStore, MAX_ASSET_BYTES, MAX_ASSET_STORE_BYTES, ORPHAN_GRACE_MS, detectImage };

//# sourceMappingURL=assets.js.map