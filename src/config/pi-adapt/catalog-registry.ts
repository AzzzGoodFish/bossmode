// pi SDK catalog registry (config's marked adapter zone, P5).
// Credential-less registry used only for static catalog metadata; not for real request auth.
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
class NoopCredentialStore implements CredentialStore {
  async read(): Promise<Credential | undefined> { return undefined; }
  async list(): Promise<readonly CredentialInfo[]> { return []; }
  async modify(_providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> { return fn(undefined); }
  async delete(): Promise<void> {}
}

// Credential-less registry used only for static catalog metadata (model list, provider display
// names, OAuth-provider ids) — not for real request auth. ModelRuntime.create() is async, but the
// many callers below (validateInput, sanitizeProfile, etc.) are synchronous; the cache is warmed
// once (lazily, or eagerly via ensurePiCatalogWarm() at server startup) and read synchronously
// afterward. Before the cache is warm, callers fall back to their pre-existing empty/default
// behavior (unchanged from before this migration).
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
