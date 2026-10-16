import { ExternalProviderRegistry } from "./external-provider.js";
import { ZentaoProvider } from "./zentao.js";
import { TapdProvider } from "./tapd.js";
//#region src/host/external-providers.ts
const validateNumericProjects = (config) => {
	if (config.mappings.some((m) => !/^\d+$/.test(m.projectId))) throw new Error("provider requires numeric project IDs");
};
/** Add new providers here; synchronization and UI consume descriptors without platform branches. */
function createBuiltinProviders() {
	return new ExternalProviderRegistry().register({
		descriptor: {
			id: "zentao",
			name: "ZenTao",
			scopeLabel: "ext.product",
			defaultBaseUrl: "",
			settingsFields: [{
				key: "requestIntervalMs",
				label: "ext.requestInterval",
				defaultValue: "200"
			}],
			authModes: [{
				id: "password",
				label: "ext.usernamePassword",
				fields: [{
					key: "username",
					label: "ext.username",
					secret: false
				}, {
					key: "password",
					label: "ext.password"
				}]
			}],
			capabilities: {
				itemTypes: ["bug"],
				projectDiscovery: true,
				accountDiscovery: false,
				pagination: "page",
				incremental: false
			}
		},
		validate: (config) => {
			validateNumericProjects(config);
			const interval = Number(config.settings.requestIntervalMs ?? 200);
			if (!Number.isInteger(interval) || interval < 0 || interval > 1e4) throw new Error("request interval must be 0–10000 milliseconds");
		},
		create: (config) => new ZentaoProvider(config)
	}).register({
		descriptor: {
			id: "tapd",
			name: "TAPD",
			scopeLabel: "ext.projectId",
			defaultBaseUrl: "https://api.tapd.cn",
			authModes: [{
				id: "basic",
				label: "Basic Auth",
				fields: [{
					key: "apiUser",
					label: "ext.apiUser"
				}, {
					key: "apiPassword",
					label: "ext.apiPassword"
				}]
			}, {
				id: "bearer",
				label: "Bearer Token",
				fields: [{
					key: "accessToken",
					label: "Access Token"
				}]
			}],
			settingsFields: [
				{
					key: "companyId",
					label: "ext.companyId",
					defaultValue: ""
				},
				{
					key: "terminalStatuses",
					label: "ext.terminalStatuses",
					defaultValue: "closed,resolved,done,rejected"
				},
				{
					key: "urgentPriorities",
					label: "ext.urgentPriorities",
					defaultValue: "urgent,high,紧急,高"
				},
				{
					key: "relaxedPriorities",
					label: "ext.relaxedPriorities",
					defaultValue: "low,nice to have,低"
				}
			],
			capabilities: {
				itemTypes: [
					"bug",
					"story",
					"task"
				],
				projectDiscovery: true,
				accountDiscovery: false,
				pagination: "cursor",
				incremental: false
			}
		},
		validate: (config) => {
			validateNumericProjects(config);
			if (config.settings.companyId && !/^\d+$/.test(config.settings.companyId)) throw new Error("invalid company ID");
			if (config.authMode === "basic" && config.credentials.apiUser?.includes(":")) throw new Error("API username cannot contain a colon");
		},
		create: (config) => new TapdProvider(config)
	});
}
//#endregion
export { createBuiltinProviders };

//# sourceMappingURL=external-providers.js.map