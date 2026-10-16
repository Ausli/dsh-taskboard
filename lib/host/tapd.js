import { externalGet, trackerText } from "./external-http.js";
//#region src/host/tapd.ts
const TYPES = {
	bug: {
		endpoint: "bugs",
		wrapper: "Bug",
		title: "title",
		owner: "current_owner"
	},
	story: {
		endpoint: "stories",
		wrapper: "Story",
		title: "name",
		owner: "owner"
	},
	task: {
		endpoint: "tasks",
		wrapper: "Task",
		title: "name",
		owner: "owner"
	}
};
function opaqueId(raw) {
	if (typeof raw === "number" && !Number.isSafeInteger(raw)) throw new Error("unsafe numeric TAPD ID");
	const id = String(raw ?? "");
	if (!/^\d+$/.test(id)) throw new Error("invalid TAPD ID");
	return id;
}
/** TAPD Open API; API credentials and the assignee nickname are separate identities. */
var TapdProvider = class {
	config;
	request;
	minIntervalMs;
	nextRequestAt = 0;
	constructor(config, request = fetch, minIntervalMs = 1100) {
		this.config = config;
		this.request = request;
		this.minIntervalMs = minIntervalMs;
	}
	async get(path, params, signal) {
		const delay = Math.max(0, this.nextRequestAt - Date.now());
		if (delay) await new Promise((resolve, reject) => {
			const abort = () => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error("request aborted"));
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, delay);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		signal.throwIfAborted();
		this.nextRequestAt = Date.now() + this.minIntervalMs;
		const c = this.config.credentials;
		const authorization = this.config.authMode === "basic" ? `Basic ${Buffer.from(`${c.apiUser}:${c.apiPassword}`, "utf8").toString("base64")}` : `Bearer ${c.accessToken}`;
		const raw = await externalGet(this.request, `${this.config.baseUrl}/${path}?${new URLSearchParams(params)}`, { Authorization: authorization }, signal);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid TAPD response");
		const response = raw;
		if (response.status !== 1 || !Array.isArray(response.data)) throw new Error("TAPD API rejected request or returned invalid data");
		return response.data;
	}
	async test(signal) {
		for (const mapping of this.config.mappings) for (const type of this.config.itemTypes) await this.get(TYPES[type].endpoint, {
			workspace_id: mapping.projectId,
			limit: "1",
			fields: "id"
		}, signal);
	}
	async listProjects(signal) {
		if (!this.config.settings.companyId) throw new Error("company ID is required for TAPD project discovery");
		return (await this.get("workspaces/user_participant_projects", {
			nick: this.config.account,
			company_id: this.config.settings.companyId
		}, signal)).map((row) => {
			const workspace = row && typeof row === "object" ? row.Workspace : void 0;
			if (!workspace || typeof workspace !== "object") throw new Error("invalid TAPD workspace");
			const w = workspace;
			if (typeof w.name !== "string") throw new Error("invalid TAPD workspace name");
			return {
				id: opaqueId(w.id),
				name: w.name
			};
		});
	}
	normalize(row, projectId, type) {
		const spec = TYPES[type];
		const raw = row && typeof row === "object" ? row[spec.wrapper] : void 0;
		if (!raw || typeof raw !== "object") throw new Error("invalid TAPD work item wrapper");
		const item = raw;
		const id = opaqueId(item.id);
		if (item.workspace_id !== void 0 && opaqueId(item.workspace_id) !== projectId) throw new Error("TAPD project mismatch");
		if (typeof item[spec.title] !== "string" || !String(item[spec.title]).trim() || typeof item.status !== "string") throw new Error("invalid TAPD work item fields");
		const assignedTo = String(item[spec.owner] ?? "");
		const assignees = assignedTo.split(";").map((s) => s.trim()).filter(Boolean);
		const priority = String(item.priority_label || item.priority || "");
		const labels = (key, fallback) => (this.config.settings[key] ?? fallback).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
		const terminal = labels("terminalStatuses", "closed,resolved,done,rejected");
		const high = labels("urgentPriorities", "urgent,high,紧急,高");
		const low = labels("relaxedPriorities", "low,nice to have,低");
		const normalizedPriority = priority.toLowerCase();
		const urgency = high.includes(normalizedPriority) || !item.priority_label && type !== "bug" && priority === "4" ? "urgent" : low.includes(normalizedPriority) || !item.priority_label && type !== "bug" && ["1", "2"].includes(priority) ? "relaxed" : "normal";
		return {
			projectId,
			type,
			id,
			title: String(item[spec.title]).trim(),
			description: trackerText(item.description),
			status: item.status,
			assignedTo,
			assignees,
			priority,
			urgency,
			closed: terminal.includes(item.status.toLowerCase()),
			url: `https://www.tapd.cn/${encodeURIComponent(projectId)}/prong/${spec.endpoint}/view/${encodeURIComponent(id)}`
		};
	}
	async getItem(projectId, type, id, signal) {
		const spec = TYPES[type];
		if (!spec || !this.config.itemTypes.includes(type)) throw new Error("unsupported TAPD item type");
		const rows = await this.get(spec.endpoint, {
			workspace_id: projectId,
			id: opaqueId(id),
			limit: "1"
		}, signal);
		if (!rows.length) return void 0;
		const item = this.normalize(rows[0], projectId, type);
		if (item.id !== id) throw new Error("TAPD item mismatch");
		return item;
	}
	async getItems(projectId, signal) {
		const all = [];
		for (const type of this.config.itemTypes) {
			const spec = TYPES[type];
			if (!spec) throw new Error("unsupported TAPD item type");
			const seen = /* @__PURE__ */ new Set();
			let cursor = "";
			for (let page = 0; page < 1e4; page++) {
				const params = {
					workspace_id: projectId,
					limit: "200",
					order: "id desc",
					fields: `id,workspace_id,${spec.title},description,status,${spec.owner},priority,priority_label,created`
				};
				if (cursor) params.cursor = cursor;
				const rows = await this.get(spec.endpoint, params, signal);
				if (!rows.length) break;
				let added = 0;
				let last = "";
				for (const row of rows) {
					const item = this.normalize(row, projectId, type);
					last = item.id;
					if (seen.has(item.id)) continue;
					seen.add(item.id);
					added++;
					const raw = row[spec.wrapper];
					const created = typeof raw.created === "string" ? raw.created.slice(0, 10) : "";
					if (!this.config.since || !created || created >= this.config.since) all.push(item);
				}
				if (!added || last === cursor) throw new Error("TAPD cursor did not advance");
				cursor = last;
				if (rows.length < 200) break;
				if (page === 9999) throw new Error("TAPD scan limit exceeded");
			}
		}
		return all;
	}
};
//#endregion
export { TapdProvider };

//# sourceMappingURL=tapd.js.map