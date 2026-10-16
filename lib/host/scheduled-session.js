//#region src/host/scheduled-session.ts
/**
* Only confirmed absence, archival or incompatible configuration permits a
* replacement session... and so does any resume obstacle: busy, locked or
* corrupt sessions degrade to a brand-new conversation (issue #26 policy),
* trading history continuity for guaranteed execution progress.
*/
function scheduledSessionResumer(deps) {
	return async (sessionId, options, onDegrade) => {
		const report = (reason) => {
			onDegrade?.(reason);
			deps.onDegrade?.(reason, sessionId);
		};
		if (deps.isArchived(sessionId)) return report("archived");
		const compatible = (header) => header.cwd === options.meta?.cwd && header.agentPreset === options.meta?.agentPreset;
		const live = deps.agents.get(sessionId);
		if (live !== void 0) {
			if (live.status !== "idle") return report("busy");
			if (!compatible(live.session.header)) return report("incompatible");
			const model = options.agentOptions;
			if (live.options?.provider !== model?.provider || live.options?.model !== model?.model || live.options?.reasoningEffort !== model?.reasoningEffort) return report("incompatible");
			return {
				agent: live,
				borrowed: true,
				dispose: async () => {
					live.cancel({ kind: "user" });
					await live.whenIdle();
				}
			};
		}
		let stored;
		try {
			stored = await deps.persistence()?.stat(sessionId);
		} catch {
			return report("unresumable");
		}
		if (stored === void 0) return report("unavailable");
		if (!compatible(stored.header)) return report("incompatible");
		if (deps.isArchived(sessionId)) return report("archived");
		if (deps.agents.get(sessionId) !== void 0) return report("busy");
		try {
			return await deps.agents.resume({
				resumeSessionId: sessionId,
				...options.agentOptions !== void 0 ? { agentOptions: options.agentOptions } : {},
				...options.setup !== void 0 ? { setup: options.setup } : {}
			});
		} catch {
			return report("unresumable");
		}
	};
}
//#endregion
export { scheduledSessionResumer };

//# sourceMappingURL=scheduled-session.js.map