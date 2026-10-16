//#region src/host/external-provider.ts
/** Registration is explicit and rejects ambiguous IDs. No platform switches in the sync engine. */
var ExternalProviderRegistry = class {
	definitions = /* @__PURE__ */ new Map();
	register(definition) {
		const { descriptor } = definition;
		if (!/^[a-z][a-z0-9-]*$/.test(descriptor.id) || this.definitions.has(descriptor.id)) throw new Error("invalid or duplicate provider ID");
		if (!descriptor.authModes.length || !descriptor.capabilities.itemTypes.length) throw new Error("provider must declare authentication and item types");
		this.definitions.set(descriptor.id, {
			...definition,
			descriptor: structuredClone(descriptor)
		});
		return this;
	}
	get(id) {
		const definition = this.definitions.get(id);
		if (!definition) throw new Error("unsupported external provider");
		return definition;
	}
	list() {
		return [...this.definitions.values()].map((d) => structuredClone(d.descriptor));
	}
	create(config) {
		const definition = this.get(config.provider);
		definition.validate?.(config);
		return definition.create(config);
	}
};
//#endregion
export { ExternalProviderRegistry };

//# sourceMappingURL=external-provider.js.map