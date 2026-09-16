import { type Credential, type CredentialInfo, type CredentialStore, type ModelsStore, type ModelsStoreEntry } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

class NoopCredentialStore implements CredentialStore {
  async read(): Promise<Credential | undefined> { return undefined; }
  async list(): Promise<readonly CredentialInfo[]> { return []; }
  async modify(_providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> { return fn(undefined); }
  async delete(): Promise<void> {}
}

let catalogRegistryPromise: Promise<ModelRegistry> | null = null;

let catalogRegistrySync: ModelRegistry | null = null;

let catalogRuntimeSync: ModelRuntime | null = null;

export async function ensureCatalogRegistry(): Promise<ModelRegistry> {
  if (catalogRegistrySync) return catalogRegistrySync;
  if (!catalogRegistryPromise) {
    catalogRegistryPromise = ModelRuntime.create({ credentials: new NoopCredentialStore(), modelsPath: null, allowModelNetwork: false })
      .then((runtime) => {
        const registry = new ModelRegistry(runtime);
        catalogRuntimeSync = runtime;
        catalogRegistrySync = registry;
        return registry;
      })
      .catch((err) => {
        catalogRegistryPromise = null;
        throw err;
      });
  }
  return catalogRegistryPromise;
}

export function getCatalogRegistrySync(): ModelRegistry | null {
  return catalogRegistrySync;
}

export function getCatalogRuntimeSync(): ModelRuntime | null {
  return catalogRuntimeSync;
}

export async function ensureCatalogRegistryRuntime(): Promise<ModelRuntime> {
  await ensureCatalogRegistry();
  if (!catalogRuntimeSync) throw new Error("pi model catalog is unavailable");
  return catalogRuntimeSync;
}

export class DatabaseModelsStore implements ModelsStore {
  constructor(private readonly repository: { overlays(): Record<string, unknown>; importOverlay(provider: string, entry: any): void; deleteOverlay(provider: string): void }) {}
  async read(providerId: string): Promise<ModelsStoreEntry | undefined> { return this.repository.overlays()[providerId] as ModelsStoreEntry | undefined; }
  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> { this.repository.importOverlay(providerId,{...entry,models:[...entry.models]}); }
  async delete(providerId: string): Promise<void> { this.repository.deleteOverlay(providerId); }
}
