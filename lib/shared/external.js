//#region src/shared/external.ts
function normalizeExternalSyncRecords(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	return Object.fromEntries(Object.entries(raw).flatMap(([id, value]) => {
		if (!id || !value || typeof value !== "object" || Array.isArray(value)) return [];
		const e = value;
		const links = e.links && typeof e.links === "object" && !Array.isArray(e.links) ? Object.fromEntries(Object.entries(e.links).filter((entry) => typeof entry[1] === "string")) : {};
		const ignored = Array.isArray(e.ignored) ? [...new Set(e.ignored.filter((v) => typeof v === "string"))] : [];
		const r = e.lastResult;
		const lastResult = r && typeof r === "object" && [
			"created",
			"updated",
			"unchanged",
			"conflicts",
			"ignored",
			"at"
		].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]) && r[k] >= 0) ? {
			created: r.created,
			updated: r.updated,
			unchanged: r.unchanged,
			conflicts: r.conflicts,
			ignored: r.ignored,
			at: r.at
		} : void 0;
		return [[id, {
			links,
			ignored,
			...lastResult ? { lastResult } : {},
			...typeof e.lastError === "string" ? { lastError: e.lastError } : {},
			...typeof e.lastAttemptAt === "number" && Number.isFinite(e.lastAttemptAt) ? { lastAttemptAt: e.lastAttemptAt } : {}
		}]];
	}));
}
function externalKey(connectionId, item) {
	return JSON.stringify([
		connectionId,
		item.projectId,
		item.type,
		item.id
	]);
}
/** Explicit reconstruction also prevents credentials/unknown fields entering exports. */
function normalizeExternalSource(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const e = raw;
	if (typeof e.connectionId !== "string" || !e.connectionId || typeof e.provider !== "string" || typeof e.syncedAt !== "number" || !Number.isFinite(e.syncedAt) || !e.item || typeof e.item !== "object") return void 0;
	const i = e.item;
	for (const field of [
		"projectId",
		"type",
		"id",
		"url",
		"status",
		"priority",
		"assignedTo",
		"title",
		"description"
	]) if (typeof i[field] !== "string") return void 0;
	try {
		if (!["http:", "https:"].includes(new URL(i.url).protocol)) return void 0;
	} catch {
		return;
	}
	if (![
		"urgent",
		"normal",
		"relaxed"
	].includes(String(i.urgency)) || typeof i.closed !== "boolean") return void 0;
	const item = {
		projectId: i.projectId,
		type: i.type,
		id: i.id,
		url: i.url,
		status: i.status,
		priority: i.priority,
		assignedTo: i.assignedTo,
		title: i.title,
		description: i.description,
		urgency: i.urgency,
		closed: i.closed,
		...Array.isArray(i.assignees) ? { assignees: i.assignees.filter((v) => typeof v === "string") } : {}
	};
	return {
		connectionId: e.connectionId,
		provider: e.provider,
		...typeof e.providerName === "string" ? { providerName: e.providerName } : {},
		syncedAt: e.syncedAt,
		item,
		conflicts: Array.isArray(e.conflicts) ? e.conflicts.filter((v) => [
			"title",
			"description",
			"urgency"
		].includes(v)) : []
	};
}
/** Three-way merge; unresolved conflicts persist across unchanged syncs. */
function mergeExternalFields(local, previous, incoming, frozen) {
	const fields = {
		title: local.title,
		description: local.description,
		urgency: local.urgency
	};
	const conflicts = [];
	for (const key of [
		"title",
		"description",
		"urgency"
	]) {
		if (local[key] === incoming[key]) continue;
		if (!(incoming[key] !== previous.item[key]) && !previous.conflicts.includes(key)) continue;
		if (!frozen && local[key] === previous.item[key] && !previous.conflicts.includes(key)) if (key === "urgency") fields.urgency = incoming.urgency;
		else fields[key] = incoming[key];
		else conflicts.push(key);
	}
	return {
		fields,
		conflicts
	};
}
//#endregion
export { externalKey, mergeExternalFields, normalizeExternalSource, normalizeExternalSyncRecords };

//# sourceMappingURL=external.js.map