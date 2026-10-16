import { ExternalRequestThrottle, externalGet, trackerText } from "./external-http.js";
//#region src/host/zentao.ts
/** ZenTao REST API v1, product Bug lists. Product IDs form the mapping scope. */
var ZentaoProvider = class {
	config;
	request;
	token;
	throttle;
	constructor(config, request = fetch) {
		this.config = config;
		this.request = request;
		if (config.authMode !== "password" || !config.credentials.username || !config.credentials.password) throw new Error("ZenTao requires a username and password");
		this.throttle = new ExternalRequestThrottle(Number(config.settings.requestIntervalMs ?? 200));
	}
	async authenticate(signal) {
		if (this.token) return this.token;
		await this.throttle.wait(signal);
		const response = await this.request(`${this.config.baseUrl}/api.php/v1/tokens`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({
				account: this.config.credentials.username,
				password: this.config.credentials.password
			}),
			signal: AbortSignal.any([signal, AbortSignal.timeout(3e4)]),
			redirect: "error"
		});
		if (!response.ok) throw new Error("ZenTao login failed");
		let result;
		try {
			result = await response.json();
		} catch {
			throw new Error("ZenTao login returned invalid JSON");
		}
		if (!result || typeof result !== "object" || !("token" in result) || typeof result.token !== "string" || !result.token.trim()) throw new Error("ZenTao login failed");
		this.token = result.token;
		return this.token;
	}
	async get(path, signal) {
		const token = await this.authenticate(signal);
		let raw;
		try {
			raw = await externalGet(this.request, `${this.config.baseUrl}/api.php/v1/${path}`, { Token: token }, signal, () => this.throttle.wait(signal));
		} catch (error) {
			if (this.config.authMode !== "password" || !(error instanceof Error) || !/HTTP (401|403)\)/.test(error.message)) throw error;
			this.token = void 0;
			raw = await externalGet(this.request, `${this.config.baseUrl}/api.php/v1/${path}`, { Token: await this.authenticate(signal) }, signal, () => this.throttle.wait(signal));
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || "error" in raw) throw new Error("invalid ZenTao response");
		return raw;
	}
	async listProjects(signal) {
		const projects = [];
		const seen = /* @__PURE__ */ new Set();
		for (let page = 1; page <= 1e4; page++) {
			const result = await this.get(`products?limit=100&page=${page}`, signal);
			if (!Array.isArray(result.products)) throw new Error("invalid ZenTao product list");
			let added = 0;
			for (const raw of result.products) {
				if (!raw || typeof raw !== "object") throw new Error("invalid ZenTao product");
				const p = raw;
				if (typeof p.id === "number" && !Number.isSafeInteger(p.id)) throw new Error("unsafe product ID");
				const id = String(p.id ?? "");
				if (!/^\d+$/.test(id) || typeof p.name !== "string") throw new Error("invalid ZenTao product fields");
				if (!seen.has(id)) {
					seen.add(id);
					added++;
					projects.push({
						id,
						name: p.name
					});
				}
			}
			if (!result.products.length || typeof result.total === "number" && seen.size >= result.total) return projects;
			if (!added) throw new Error("ZenTao product pagination did not advance");
		}
		throw new Error("ZenTao product pagination limit exceeded");
	}
	async getItem(projectId, type, id, signal) {
		if (type !== "bug" || !/^\d+$/.test(id)) throw new Error("unsupported ZenTao work item");
		const result = await this.get(`bugs/${encodeURIComponent(id)}`, signal);
		const b = result.bug && typeof result.bug === "object" ? result.bug : result;
		if (String(b.id) !== id || String(b.product) !== projectId || typeof b.title !== "string" || typeof b.status !== "string") throw new Error("invalid ZenTao Bug details");
		const assigned = typeof b.assignedTo === "object" && b.assignedTo !== null ? String(b.assignedTo.account ?? "") : String(b.assignedTo ?? "");
		const priority = String(b.pri ?? "");
		return {
			projectId,
			type,
			id,
			title: b.title,
			description: trackerText(b.steps),
			status: b.status,
			assignedTo: assigned,
			priority,
			urgency: priority === "1" ? "urgent" : priority === "4" ? "relaxed" : "normal",
			closed: ["closed", "resolved"].includes(b.status),
			url: `${this.config.baseUrl}/index.php?m=bug&f=view&bugID=${encodeURIComponent(id)}`
		};
	}
	async test(signal) {
		for (const mapping of this.config.mappings) {
			const result = await this.get(`products/${encodeURIComponent(mapping.projectId)}/bugs?limit=1&page=1`, signal);
			if (!Array.isArray(result.bugs)) throw new Error("unsupported ZenTao Bug API");
		}
	}
	async getItems(projectId, signal, context) {
		const items = [];
		const seen = /* @__PURE__ */ new Set();
		for (let page = 1; page <= 1e4; page++) {
			const result = await this.get(`products/${encodeURIComponent(projectId)}/bugs?status=all&limit=100&page=${page}`, signal);
			if (!Array.isArray(result.bugs)) throw new Error("invalid ZenTao Bug list");
			let added = 0;
			for (const raw of result.bugs) {
				if (!raw || typeof raw !== "object") throw new Error("invalid ZenTao Bug");
				const b = raw;
				if (typeof b.id === "number" && !Number.isSafeInteger(b.id)) throw new Error("ZenTao numeric Bug ID exceeds safe integer range");
				const id = String(b.id ?? "");
				if (!/^\d+$/.test(id) || typeof b.title !== "string" || !b.title.trim() || typeof b.status !== "string") throw new Error("invalid ZenTao Bug fields");
				if (seen.has(id)) continue;
				seen.add(id);
				added++;
				const opened = typeof b.openedDate === "string" ? b.openedDate.slice(0, 10) : "";
				if (this.config.since && opened && opened < this.config.since) continue;
				const assigned = typeof b.assignedTo === "object" && b.assignedTo !== null ? String(b.assignedTo.account ?? "") : String(b.assignedTo ?? "");
				const previous = context?.existing.get(JSON.stringify(["bug", id]));
				if (context && !previous && (assigned !== this.config.account || ["closed", "resolved"].includes(b.status))) continue;
				if (b.steps === void 0 && previous?.metadataOnly) b.steps = previous.item.description;
				if (b.steps === void 0) {
					const detail = await this.get(`bugs/${encodeURIComponent(id)}`, signal);
					const payload = detail.bug && typeof detail.bug === "object" ? detail.bug : detail;
					if (typeof payload.steps !== "string") throw new Error("ZenTao Bug description is missing");
					b.steps = payload.steps;
				}
				const priority = String(b.pri ?? "");
				items.push({
					projectId,
					type: "bug",
					id,
					title: b.title.trim(),
					description: trackerText(b.steps),
					urgency: priority === "1" ? "urgent" : priority === "4" ? "relaxed" : "normal",
					priority,
					assignedTo: assigned,
					status: b.status,
					closed: ["closed", "resolved"].includes(b.status),
					url: `${this.config.baseUrl}/index.php?m=bug&f=view&bugID=${encodeURIComponent(id)}`
				});
			}
			const total = typeof result.total === "number" ? result.total : Number(result.total);
			if (result.bugs.length === 0 || Number.isFinite(total) && seen.size >= total) return items;
			if (added === 0) throw new Error("ZenTao pagination did not advance");
		}
		throw new Error("ZenTao pagination limit exceeded");
	}
};
//#endregion
export { ZentaoProvider };

//# sourceMappingURL=zentao.js.map