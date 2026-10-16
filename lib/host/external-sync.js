import { externalKey, mergeExternalFields, normalizeExternalSource, normalizeExternalSyncRecords } from "../shared/external.js";
import { defaultIsolationOf, defaultPermissionOf, newTaskId, normalizeTitle } from "../shared/protocol.js";
import { createBuiltinProviders } from "./external-providers.js";
import { normalizeConnection } from "./external-config.js";
import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
//#region src/host/external-sync.ts
/** Host-only connection state. Credential files live outside task exports. */
var ExternalSyncService = class {
	options;
	state = {};
	volatileError;
	ready;
	lane = Promise.resolve();
	running = false;
	disposed = false;
	controller;
	timer;
	lastAttempt = 0;
	registry;
	constructor(options) {
		this.options = options;
		this.registry = options.registry ?? createBuiltinProviders();
		this.ready = this.load();
	}
	now() {
		return this.options.now?.() ?? Date.now();
	}
	async load() {
		try {
			const raw = JSON.parse(await readFile(this.options.file, "utf8"));
			if (raw.config) {
				if (typeof raw.config.id !== "string" || !raw.config.id) throw new Error("invalid connection identity");
				this.state.config = {
					...normalizeConnection(raw.config, this.registry),
					id: raw.config.id
				};
			}
			await this.options.store.load();
			if (this.state.config && (Object.keys(raw.links ?? {}).length || raw.ignored?.length || raw.lastResult || raw.lastError)) {
				const id = this.state.config.id;
				const migrated = normalizeExternalSyncRecords({ [id]: raw })[id];
				await this.options.store.mutate("external-sync-updated", (ledger) => {
					if (ledger.externalSync?.[id]) return void 0;
					ledger.externalSync ??= {};
					ledger.externalSync[id] = migrated;
					return [];
				});
			}
			this.lastAttempt = this.state.config ? this.options.store.snapshot().externalSync?.[this.state.config.id]?.lastAttemptAt ?? 0 : 0;
		} catch (error) {
			if (error.code !== "ENOENT") this.volatileError = "External sync configuration could not be loaded; reconfigure the connection.";
		}
		await this.options.store.load();
	}
	async persist() {
		await mkdir(dirname(this.options.file), { recursive: true });
		const temp = `${this.options.file}.tmp`;
		await writeFile(temp, JSON.stringify(this.state), { mode: 384 });
		await rename(temp, this.options.file);
	}
	serial(run) {
		const next = this.lane.then(run, run);
		this.lane = next.catch(() => {});
		return next;
	}
	async status() {
		await this.ready;
		const config = this.state.config ? (({ credentials: _credentials, ...rest }) => rest)(this.state.config) : void 0;
		const credentialPresent = Object.fromEntries(Object.entries(this.state.config?.credentials ?? {}).map(([key, value]) => [key, Boolean(value)]));
		const mode = config && this.registry.get(config.provider).descriptor.authModes.find((m) => m.id === config.authMode);
		const credentialValues = Object.fromEntries((mode?.fields ?? []).filter((f) => f.secret === false).map((f) => [f.key, this.state.config.credentials[f.key] ?? ""]));
		const record = config ? this.options.store.snapshot().externalSync?.[config.id] : void 0;
		return {
			config,
			credentialPresent,
			credentialValues,
			providers: this.registry.list(),
			running: this.running,
			lastResult: record?.lastResult,
			lastError: this.volatileError ?? record?.lastError,
			lastAttemptAt: record?.lastAttemptAt,
			ignoredCount: record?.ignored.length ?? 0
		};
	}
	async configure(raw) {
		await this.ready;
		if (this.running) throw new Error("sync is running");
		await this.serial(async () => {
			if (this.running) throw new Error("sync is running");
			const config = normalizeConnection(raw, this.registry, this.state.config);
			if (config.mappings.some((m) => !this.options.workspaceExists(m.workspaceId))) throw new Error("unknown workspace");
			const old = this.state;
			this.state = { config };
			try {
				await this.persist();
			} catch (e) {
				this.state = old;
				throw e;
			}
			this.volatileError = void 0;
		});
	}
	async clearIgnored() {
		await this.ready;
		if (this.running) throw new Error("sync is running");
		await this.serial(async () => {
			if (this.running) throw new Error("sync is running");
			if (!this.state.config) throw new Error("configure a connection first");
			await this.options.store.mutate("external-sync-updated", (ledger) => {
				const record = this.record(ledger, this.state.config.id);
				record.ignored = [];
				record.links = {};
				return [];
			});
		});
	}
	async resolve(taskId, field, acceptExternal, ifVersion) {
		if (![
			"title",
			"description",
			"urgency"
		].includes(field)) throw new Error("invalid conflict field");
		await this.options.store.mutate("task-updated", (ledger) => {
			const task = ledger.tasks.find((t) => t.id === taskId);
			if (!task?.external || task.version !== ifVersion) throw new Error("task changed; refresh and retry");
			if (task.status === "in_progress" || task.executions.some((e) => e.outcome === "running")) throw new Error("wait until execution finishes");
			const key = field;
			if (!task.external.conflicts.includes(key)) throw new Error("field is not an unresolved conflict");
			if (acceptExternal) if (key === "urgency") task.urgency = task.external.item.urgency;
			else task[key] = task.external.item[key];
			task.external.conflicts = task.external.conflicts.filter((k) => k !== key);
			task.version++;
			task.updatedAt = this.now();
			task.updatedBy = { kind: "user" };
			return [task];
		});
	}
	record(ledger, connectionId) {
		ledger.externalSync ??= {};
		return ledger.externalSync[connectionId] ??= {
			links: {},
			ignored: []
		};
	}
	start() {
		if (this.timer || this.disposed) return;
		this.timer = setInterval(() => {
			this.tick().catch(() => {});
		}, 3e4);
		this.timer.unref?.();
	}
	async tick() {
		await this.ready;
		const interval = this.state.config?.intervalMinutes ?? 0;
		if (interval && !this.running && this.now() - this.lastAttempt >= interval * 6e4) await this.sync();
	}
	dispose() {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.controller?.abort();
	}
	cancel() {
		this.controller?.abort();
	}
	async test() {
		await this.ready;
		if (!this.state.config) throw new Error("configure a connection first");
		await this.provider(this.state.config).test(AbortSignal.timeout(3e4));
	}
	provider(config) {
		return this.options.provider?.(config) ?? this.registry.create(config);
	}
	async discoverProjects(raw) {
		await this.ready;
		const config = raw ? normalizeConnection(raw, this.registry, this.state.config, true) : this.state.config;
		if (!config) throw new Error("configure a connection first");
		const descriptor = this.registry.get(config.provider).descriptor;
		const provider = this.provider(config);
		if (!descriptor.capabilities.projectDiscovery || !provider.listProjects) throw new Error("project discovery is not supported");
		return provider.listProjects(AbortSignal.timeout(3e4));
	}
	async discoverAccount() {
		await this.ready;
		if (!this.state.config) throw new Error("configure a connection first");
		const definition = this.registry.get(this.state.config.provider);
		const provider = this.provider(this.state.config);
		if (!definition.descriptor.capabilities.accountDiscovery || !provider.getAccount) throw new Error("this provider requires an explicit assignee account");
		return provider.getAccount(AbortSignal.timeout(3e4));
	}
	async sync() {
		await this.ready;
		if (this.disposed) throw new Error("sync service stopped");
		if (this.running) throw new Error("sync is already running");
		if (!this.state.config) throw new Error("configure a connection first");
		this.running = true;
		this.lastAttempt = this.now();
		const config = structuredClone(this.state.config);
		this.controller = new AbortController();
		const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(3e5)]);
		const result = {
			created: 0,
			updated: 0,
			unchanged: 0,
			conflicts: 0,
			ignored: 0,
			at: this.now()
		};
		let committed = false;
		try {
			await this.options.store.load();
			const provider = this.provider(config);
			const items = [];
			for (const mapping of config.mappings) {
				if (!this.options.workspaceExists(mapping.workspaceId)) throw new Error("mapped workspace no longer exists");
				const existing = new Map(this.options.store.snapshot().tasks.filter((t) => t.external?.connectionId === config.id && t.external.item.projectId === mapping.projectId).map((t) => [JSON.stringify([t.external.item.type, t.external.item.id]), {
					item: t.external.item,
					metadataOnly: t.trashedAt !== void 0 || [
						"done",
						"canceled",
						"archived"
					].includes(t.status)
				}]));
				for (const item of await provider.getItems(mapping.projectId, signal, { existing })) {
					if (item.projectId !== mapping.projectId || !config.itemTypes.includes(item.type)) throw new Error("provider returned an unexpected scope or work item type");
					const source = normalizeExternalSource({
						connectionId: config.id,
						provider: config.provider,
						item,
						syncedAt: result.at,
						conflicts: []
					});
					if (!source) throw new Error("provider returned an invalid work item");
					items.push({
						item: source.item,
						workspaceId: mapping.workspaceId
					});
				}
			}
			signal.throwIfAborted();
			await this.serial(async () => {
				signal.throwIfAborted();
				await this.options.store.mutate("external-sync-updated", (ledger) => {
					signal.throwIfAborted();
					const record = this.record(ledger, config.id);
					const ignored = new Set(record.ignored);
					const links = { ...record.links };
					const changed = [];
					const byKey = new Map(ledger.tasks.filter((t) => t.external).map((t) => [externalKey(t.external.connectionId, t.external.item), t]));
					const seen = /* @__PURE__ */ new Set();
					for (const { item: rawItem, workspaceId } of items) {
						const item = {
							...rawItem,
							title: normalizeTitle(rawItem.title)
						};
						const key = externalKey(config.id, item);
						if (seen.has(key)) continue;
						seen.add(key);
						const task = byKey.get(key);
						if (task) links[key] = task.id;
						if (!task && links[key]) ignored.add(key);
						if (task?.trashedAt !== void 0) {
							ignored.add(key);
							result.ignored++;
							continue;
						}
						if (ignored.has(key)) {
							result.ignored++;
							continue;
						}
						if (task?.status === "archived") {
							result.unchanged++;
							continue;
						}
						const source = {
							connectionId: config.id,
							provider: config.provider,
							providerName: this.registry.get(config.provider).descriptor.name,
							item,
							syncedAt: result.at,
							conflicts: []
						};
						if (!task) {
							if (item.closed || !(item.assignees ?? [item.assignedTo]).includes(config.account)) continue;
							const created = {
								id: newTaskId(),
								title: item.title,
								description: item.description,
								urgency: item.urgency,
								workspaceId,
								prompt: "",
								status: "backlog",
								blocked: false,
								execution: { mode: "claim" },
								isolation: defaultIsolationOf(ledger.settings),
								permission: defaultPermissionOf(ledger.settings),
								model: ledger.settings?.defaultModel,
								presetId: ledger.settings?.defaultPresetId,
								version: 1,
								createdAt: result.at,
								updatedAt: result.at,
								createdBy: { kind: "user" },
								updatedBy: { kind: "user" },
								comments: [],
								executions: [],
								external: source
							};
							ledger.tasks.push(created);
							changed.push(created);
							byKey.set(key, created);
							links[key] = created.id;
							result.created++;
						} else {
							links[key] = task.id;
							if (task.status === "done" || task.status === "canceled") {
								const old = task.external.item;
								if (![
									"status",
									"assignedTo",
									"assignees",
									"closed"
								].some((key) => JSON.stringify(old[key]) !== JSON.stringify(item[key])) && !task.external.conflicts.length) {
									result.unchanged++;
									continue;
								}
								task.external = {
									...task.external,
									item: {
										...old,
										status: item.status,
										assignedTo: item.assignedTo,
										closed: item.closed,
										...item.assignees !== void 0 ? { assignees: item.assignees } : {}
									},
									conflicts: [],
									syncedAt: result.at
								};
								if (item.assignees === void 0) delete task.external.item.assignees;
								task.version++;
								task.updatedAt = result.at;
								changed.push(task);
								result.updated++;
								continue;
							}
							const merged = mergeExternalFields(task, task.external, item, ["in_progress", "in_review"].includes(task.status) || task.executions.some((e) => e.outcome === "running"));
							source.conflicts = merged.conflicts;
							const previous = task.external.item;
							if ([.../* @__PURE__ */ new Set([...Object.keys(previous), ...Object.keys(item)])].every((key) => JSON.stringify(previous[key]) === JSON.stringify(item[key])) && JSON.stringify(task.external.conflicts) === JSON.stringify(source.conflicts)) {
								result.unchanged++;
								continue;
							}
							Object.assign(task, merged.fields);
							task.external = source;
							task.version++;
							task.updatedAt = result.at;
							changed.push(task);
							result.updated++;
							if (source.conflicts.length) result.conflicts++;
						}
					}
					record.ignored = [...ignored];
					record.links = links;
					record.lastResult = result;
					record.lastAttemptAt = this.lastAttempt;
					delete record.lastError;
					return changed;
				});
				committed = true;
				this.volatileError = void 0;
			});
			return result;
		} catch (error) {
			const message = committed ? "Tasks were updated, but sync completion reporting failed." : "External sync failed. Check connection, credentials, permissions and server availability.";
			this.volatileError = message;
			try {
				await this.serial(async () => this.options.store.mutate("external-sync-updated", (ledger) => {
					const record = this.record(ledger, config.id);
					record.lastAttemptAt = this.lastAttempt;
					record.lastError = message;
					return [];
				}));
			} catch {
				this.volatileError = `${message} Sync status could not be saved.`;
			}
			throw new Error(this.volatileError, { cause: error });
		} finally {
			this.running = false;
			this.controller = void 0;
		}
	}
};
//#endregion
export { ExternalSyncService };

//# sourceMappingURL=external-sync.js.map