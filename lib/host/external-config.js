import { newTaskId } from "../shared/protocol.js";
//#region src/host/external-config.ts
/** Platform-neutral validation; each registered provider validates its own scope/options. */
function normalizeConnection(raw, registry, previous, allowEmptyMappings = false) {
	if (!raw || typeof raw !== "object") throw new Error("invalid external connection");
	const e = raw;
	const provider = typeof e.provider === "string" ? e.provider : previous?.provider ?? "zentao";
	const definition = registry.get(provider);
	const descriptor = definition.descriptor;
	const authMode = typeof e.authMode === "string" ? e.authMode : descriptor.authModes[0].id;
	const mode = descriptor.authModes.find((m) => m.id === authMode);
	if (!mode) throw new Error("unsupported authentication mode");
	const baseUrl = new URL(String(e.baseUrl ?? descriptor.defaultBaseUrl));
	if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("invalid server URL");
	const url = baseUrl.href.replace(/\/$/, "");
	const account = typeof e.account === "string" ? e.account.trim() : "";
	if (!account) throw new Error("sync account is required");
	const sameSource = previous?.provider === provider && previous.baseUrl === url && previous.account === account;
	const sameIdentity = sameSource && previous.authMode === authMode;
	const incoming = e.credentials && typeof e.credentials === "object" && !Array.isArray(e.credentials) ? e.credentials : {};
	const credentials = {};
	for (const field of mode.fields) {
		const value = incoming[field.key];
		if (value !== void 0 && typeof value !== "string") throw new Error("invalid credential value");
		const credential = typeof value === "string" && value.length ? value : sameIdentity ? previous.credentials[field.key] : "";
		if (!credential) throw new Error("enter credentials for this server/account/authentication mode");
		credentials[field.key] = credential;
	}
	if (!Array.isArray(e.mappings) || !allowEmptyMappings && e.mappings.length === 0) throw new Error("at least one project mapping is required");
	const mappings = e.mappings.map((r) => {
		if (!r || typeof r !== "object") throw new Error("invalid mapping");
		const m = r;
		if (typeof m.projectId !== "string" || !m.projectId.trim() || typeof m.workspaceId !== "string" || !m.workspaceId) throw new Error("invalid mapping");
		return {
			projectId: m.projectId.trim(),
			workspaceId: m.workspaceId
		};
	});
	if (new Set(mappings.map((m) => m.projectId)).size !== mappings.length) throw new Error("duplicate project mapping");
	const intervalMinutes = Number(e.intervalMinutes ?? 0);
	if (!Number.isInteger(intervalMinutes) || intervalMinutes !== 0 && (intervalMinutes < 5 || intervalMinutes > 1440)) throw new Error("sync interval must be 0 or 5–1440 minutes");
	const since = String(e.since ?? "");
	if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) throw new Error("invalid start date");
	const itemTypes = e.itemTypes === void 0 ? [descriptor.capabilities.itemTypes[0]] : Array.isArray(e.itemTypes) ? e.itemTypes : [];
	if (!itemTypes.length || itemTypes.some((type) => !descriptor.capabilities.itemTypes.includes(type))) throw new Error("unsupported or empty work item types");
	const rawSettings = e.settings && typeof e.settings === "object" ? e.settings : {};
	const settings = {};
	for (const field of descriptor.settingsFields ?? []) {
		const value = rawSettings[field.key] ?? field.defaultValue;
		if (typeof value !== "string") throw new Error("invalid provider setting");
		settings[field.key] = value.trim();
	}
	const config = {
		id: sameSource ? previous.id : newTaskId(),
		provider,
		baseUrl: url,
		account,
		authMode,
		credentials,
		itemTypes: [...new Set(itemTypes)],
		settings,
		mappings,
		intervalMinutes,
		since
	};
	definition.validate?.(config);
	return config;
}
//#endregion
export { normalizeConnection };

//# sourceMappingURL=external-config.js.map