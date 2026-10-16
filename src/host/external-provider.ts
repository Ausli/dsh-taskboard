import type { ExternalAccount, ExternalConfig, ExternalItem, ExternalProject, ProviderDescriptor } from '../shared/external.ts'

/** Providers own transport, platform authentication and normalization, never TaskStore writes. */
export type ExternalReadContext = { existing: ReadonlyMap<string, { item: ExternalItem; metadataOnly: boolean }> }
export interface ExternalTaskProvider {
  test(signal: AbortSignal): Promise<void>
  getItems(projectId: string, signal: AbortSignal, context?: ExternalReadContext): Promise<ExternalItem[]>
  getItem?(projectId: string, type: string, id: string, signal: AbortSignal): Promise<ExternalItem | undefined>
  listProjects?(signal: AbortSignal): Promise<ExternalProject[]>
  getAccount?(signal: AbortSignal): Promise<ExternalAccount>
}
export type ProviderDefinition = {
  descriptor: ProviderDescriptor
  create: (config: ExternalConfig) => ExternalTaskProvider
  validate?: (config: ExternalConfig) => void
}

/** Registration is explicit and rejects ambiguous IDs. No platform switches in the sync engine. */
export class ExternalProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>()
  register(definition: ProviderDefinition): this {
    const { descriptor } = definition
    if (!/^[a-z][a-z0-9-]*$/.test(descriptor.id) || this.definitions.has(descriptor.id)) throw new Error('invalid or duplicate provider ID')
    if (!descriptor.authModes.length || !descriptor.capabilities.itemTypes.length) throw new Error('provider must declare authentication and item types')
    this.definitions.set(descriptor.id, { ...definition, descriptor: structuredClone(descriptor) })
    return this
  }
  get(id: string): ProviderDefinition {
    const definition = this.definitions.get(id)
    if (!definition) throw new Error('unsupported external provider')
    return definition
  }
  list(): ProviderDescriptor[] { return [...this.definitions.values()].map(d => structuredClone(d.descriptor)) }
  create(config: ExternalConfig): ExternalTaskProvider {
    const definition = this.get(config.provider)
    definition.validate?.(config)
    return definition.create(config)
  }
}
