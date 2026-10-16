# External task provider extension contract

Provider registration is defined in `src/host/external-providers.ts`; the framework-neutral contract and registry are in `src/host/external-provider.ts`. Public descriptor/configuration types live in `src/shared/external.ts` and contain no runtime host dependencies.

## Responsibilities

```ts
interface ExternalTaskProvider {
  test(signal: AbortSignal): Promise<void>
  getItems(projectId: string, signal: AbortSignal, context?: ExternalReadContext): Promise<ExternalItem[]>
  getItem?(projectId: string, type: string, id: string, signal: AbortSignal): Promise<ExternalItem | undefined>
  listProjects?(signal: AbortSignal): Promise<ExternalProject[]>
  getAccount?(signal: AbortSignal): Promise<ExternalAccount>
}
```

Providers own authentication, read-only HTTP, all pagination, field normalization and external link generation. They never write TaskStore. The sync engine owns project mapping, composite identities, deletion exclusions, merging, conflicts, cancellation, polling and atomic persistence of tasks with non-secret sync metadata in the ledger. Optional read context supplies existing source snapshots and a metadata-only hint for terminal cards; adapters may use it to avoid unnecessary detail requests while retaining closure/reassignment checks.

`getItems` must complete a scan or throw. Never return a partial page set as success. Missing records are not interpreted as deletion. Preserve IDs as strings, reject unsafe numeric IDs, verify response scopes and never include credentials or response bodies in errors. Return the full relevant status/assignee range so already-imported work items still reflect closure and reassignment.

`ExternalItem.assignees` optionally carries exact normalized accounts; the engine uses it when present and otherwise matches `assignedTo` exactly. Preserve the raw display value in `assignedTo`. Unsupported priorities should remain available in `priority` while mapping local urgency conservatively.

## Registering a provider

Add an adapter module, then register one definition in `createBuiltinProviders()`:

```ts
registry.register({
  descriptor: {
    id: 'example',
    name: 'Example Tracker',
    scopeLabel: 'Repository ID',
    defaultBaseUrl: 'https://tracker.example.com',
    authModes: [{
      id: 'api-key', label: 'API Key',
      fields: [{ key: 'apiKey', label: 'API Key' }],
    }],
    capabilities: {
      itemTypes: ['ticket'], projectDiscovery: false,
      accountDiscovery: false, pagination: 'page', incremental: false,
    },
  },
  create: config => new ExampleProvider(config),
  validate: config => { /* platform-specific scope/settings checks */ },
})
```

No switch statement or additional frontend component is required. Authentication fields, optional `settingsFields`, item checkboxes and discovery actions render from descriptors. Labels may be existing translation keys or plain strings; unknown item types display their raw names. Optional provider-specific settings are declared with a key, label and default value. Only declared credentials/settings survive normalization.

Registration is a host integration point, not a runtime marketplace or an arbitrary-code upload endpoint. External consumers cannot import this as a separately versioned npm subpath API yet. Additions are compiled with the plugin.

## Capabilities

- `itemTypes`: supported normalized work item types; empty or unknown selections are rejected.
- `projectDiscovery`: expose `listProjects` through the setup UI. Users can always enter a scope ID manually.
- `accountDiscovery`: expose `getAccount` only when authentication reliably identifies the human assignee. ZenTao and TAPD currently declare false, so the user must explicitly enter an account/nickname. API service accounts must not be mistaken for developers.
- `pagination`: page or cursor traversal implemented by the adapter.
- `incremental`: whether the adapter supports modified-time incremental reads. Current built-ins declare false and perform scans with content-based incremental writes. The engine does not manage a modified-time watermark protocol in this version.

Changing credential mode clears credential reuse but retains source identity when provider/server/assignee remain unchanged. Changing provider/server/assignee creates a new source identity. ZenTao only accepts username/password configuration. Token-only configurations are rejected, without migration.

## Routes

- `GET /dsh-taskboard/external`: public config, descriptors, presence flags and status; fields explicitly declared `secret: false` (such as the login username) may be returned in `credentialValues`. Passwords/tokens never appear there.
- `POST /external/config`: validate and save a connection, with the standard `/dsh-taskboard` prefix.
- `POST /external/projects`: discover using the current form, including an empty mapping list; does not save it.
- `POST /external/account`: discover an account from the saved connection only if capability and method are available.
- `POST /external/test`, `/external/sync`, `/external/cancel`, `/external/resolve`, `/external/ignored/clear`: shared existing connection actions.

All mutations require the existing JSON request fence. Secret credential values remain in the host-only connection file and are excluded from task exports. Blank credential fields reuse saved values only within the same provider/server/assignee/authentication scope.

## Required validation

An adapter should cover authentication headers, success-envelope validation, pagination boundaries/non-advancement, string IDs, selected types, assignee matching, status/priority mapping, scope validation and error redaction. Integration tests must exercise the registry, configuration, real HTTP provider, host routes and TaskStore together. UI changes should preserve descriptor-driven behavior and old connection migration.


