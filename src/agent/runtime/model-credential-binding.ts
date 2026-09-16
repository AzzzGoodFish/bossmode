import { AsyncLocalStorage } from "node:async_hooks";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCredentialStore } from "../../config/pi-adapt/credentials.js";

type Profile = Parameters<typeof createCredentialStore>[0];

/** Each SDK model snapshot owns a fixed profile. Only secrets are read live.
 * An auth operation retains that store across the SDK's read/modify awaits. */
export class ModelCredentialBinding implements CredentialStore {
  private readonly request = new AsyncLocalStorage<CredentialStore>();
  private readonly models = new WeakMap<object, CredentialStore>();
  private readonly initial: CredentialStore;
  private currentModel: () => object | undefined = () => undefined;

  constructor(profile: Profile) {
    this.initial = createCredentialStore(profile);
  }

  bind<T extends object>(model: T, profile: Profile): T {
    // Same model + another account still needs a distinct request snapshot.
    const bound = { ...model };
    this.models.set(bound, createCredentialStore(profile));
    return bound;
  }

  followSession(getModel: () => object | undefined): void {
    this.currentModel = getModel;
  }

  private forModel(model: object): CredentialStore {
    const store = this.models.get(model);
    if (!store) throw new Error("Model has no credential binding");
    return store;
  }

  private current(): CredentialStore {
    const scoped = this.request.getStore();
    if (scoped) return scoped;
    const model = this.currentModel();
    return model ? this.forModel(model) : this.initial;
  }

  run<T>(model: object | undefined, fn: () => T): T {
    return this.request.run(model ? this.forModel(model) : this.current(), fn);
  }

  runProfile<T>(profile: Profile, fn: () => T): T {
    return this.request.run(createCredentialStore(profile), fn);
  }

  /** SDK request and catalog entry points; no SDK history/state replacement. */
  attach(runtime: ModelRuntime): void {
    const getAuth = runtime.getAuth.bind(runtime);
    runtime.getAuth = (model, overrides) => this.run(
      typeof model === "string" ? undefined : model,
      () => typeof model === "string" ? getAuth(model, overrides) : getAuth(model, overrides),
    );
    const refresh = runtime.refresh.bind(runtime);
    runtime.refresh = (options) => this.run(undefined, () => refresh(options));
    const checkAuth = runtime.checkAuth.bind(runtime);
    runtime.checkAuth = (provider) => this.run(undefined, () => checkAuth(provider));
  }

  read(...args: Parameters<CredentialStore["read"]>): ReturnType<CredentialStore["read"]> {
    return this.current().read(...args);
  }
  list(): ReturnType<CredentialStore["list"]> { return this.current().list(); }
  modify(...args: Parameters<CredentialStore["modify"]>): ReturnType<CredentialStore["modify"]> {
    return this.current().modify(...args);
  }
  delete(...args: Parameters<CredentialStore["delete"]>): ReturnType<CredentialStore["delete"]> {
    return this.current().delete(...args);
  }
}
