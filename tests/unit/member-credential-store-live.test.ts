import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreFixture } from "../helpers/core-fixture.js";
import { importModelProfile } from "../../src/config/models.js";
let fixture: ReturnType<typeof coreFixture>;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function setup() {
  const credentials = await import("../../src/config/models.js"); const credentialsBridge = await import("../../src/config/pi-adapt/credentials.js");
  const { ModelCredentialBinding } = await import("../../src/agent/runtime/model-credential-binding.js");
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const profiles = ["A", "B"].map((id) => ({
    id, name: id, enabled: true, isDefault: false, providerSlug: "test-auth", profileKind: "custom_endpoint",
    protocol: "openai-responses", baseUrl: "http://127.0.0.1:1", authType: "oauth", requestProfile: "standard",
    oauthCredentials: { access: `${id}-old`, refresh: `${id}-refresh`, expires: Date.now() - 60_000 },
    models: [], createdAt: Date.now(), updatedAt: Date.now(),
  }));
  for (const profile of profiles) importModelProfile(profile as any, undefined, fixture.db);
  const binding = new ModelCredentialBinding(profiles[0]);
  const runtime = await ModelRuntime.create({ credentials: binding, modelsPath: null, allowModelNetwork: false });
  binding.attach(runtime);
  const refresh = vi.fn(async (credential: any) => ({
    ...credential, access: credential.refresh + "-rotated", expires: Date.now() + 10 * 60_000,
  }));
  runtime.models.setProvider({
    id: "test-auth", getModels: () => [],
    auth: { oauth: { refresh, toAuth: async (credential: any) => ({ apiKey: credential.access }) } },
  } as any);
  const model = { provider: "test-auth", id: "sample", api: "openai-responses" } as any;
  const a = binding.bind(model, profiles[0]);
  const b = binding.bind(model, profiles[1]);
  let current = a;
  binding.followSession(() => current);
  return { credentials, binding, runtime, refresh, a, b, switchToB: () => { current = b; } };
}

describe("model snapshot credentials through real SDK getAuth", () => {
  beforeEach(() => {
    fixture = coreFixture();
  });
  afterEach(() => { fixture.close(); });

  it("keeps A across read/modify while B authenticates, and writes each rotation to its own profile", async () => {
    const { binding, runtime, refresh, credentials, a, b, switchToB } = await setup();
    const entered = gate();
    const resume = gate();
    const read = binding.read.bind(binding);
    let paused = false;
    binding.read = async (provider) => {
      const value = await read(provider);
      if (value?.type === "oauth" && value.access === "A-old" && !paused) {
        paused = true;
        entered.release();
        await resume.promise;
      }
      return value;
    };
    const oldRequest = runtime.getAuth(a);
    await entered.promise;
    switchToB();
    expect((await runtime.getAuth(b))?.auth.apiKey).toBe("B-refresh-rotated");
    resume.release();
    expect((await oldRequest)?.auth.apiKey).toBe("A-refresh-rotated");
    expect(refresh.mock.calls.map(([credential]) => credential.refresh)).toEqual(["B-refresh", "A-refresh"]);
    expect(credentials.getModelCredentialProfile("A")?.oauthCredentials?.access).toBe("A-refresh-rotated");
    expect(credentials.getModelCredentialProfile("B")?.oauthCredentials?.access).toBe("B-refresh-rotated");
  });

  it("the SDK model assignment selects the account immediately, while old snapshots remain usable", async () => {
    const { binding, runtime, a, b, switchToB } = await setup();
    switchToB(); // SDK assigns state.model before awaiting model_select handlers.
    expect(await binding.read("test-auth")).toMatchObject({ access: "B-old" });
    expect((await runtime.getAuth(a))?.auth.apiKey).toBe("A-refresh-rotated");
    expect((await runtime.getAuth(b))?.auth.apiKey).toBe("B-refresh-rotated");
  });

  it("serializes same-account rotations and returns current when the SDK declines a second refresh", async () => {
    // pi ≥0.83 refreshes OAuth tokens with less than five minutes of remaining validity
    // proactively (the refresh mock therefore returns 10 minutes), so a second
    // concurrent getAuth on the same account sees a fresh credential and does not rotate again.
    const { runtime, refresh, a } = await setup();
    const results = await Promise.all([runtime.getAuth(a), runtime.getAuth(a)]);
    expect(results.map((result) => result?.auth.apiKey)).toEqual(["A-refresh-rotated", "A-refresh-rotated"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "another-provider"])("stops reading a bound profile after it becomes %s", async (change) => {
    const credentials = await import("../../src/config/models.js"); const credentialsBridge = await import("../../src/config/pi-adapt/credentials.js");
    const input = {
      profileKind: "custom_endpoint" as const, name: "Account", providerSlug: "fixture-provider",
      protocol: "openai-responses" as const, baseUrl: "http://127.0.0.1:1", authType: "api_key" as const,
      apiKey: "fixture-key", models: [{ id: "fixture-model" }],
    };
    const profile = await credentials.saveModelCredentialProfile(input);
    const store = credentialsBridge.createCredentialStore(profile);
    expect(await store.read(profile.providerSlug)).toEqual({ type: "api_key", key: "fixture-key" });
    await credentials.saveModelCredentialProfile({
      ...input, id: profile.id,
      ...(change === "disabled" ? { enabled: false } : { providerSlug: "another-provider" }),
    });
    expect(await store.read(profile.providerSlug)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("does not infer a credential for an unbound model", async () => {
    const { runtime, a } = await setup();
    expect(() => runtime.getAuth({ ...a })).toThrow("Model has no credential binding");
  });
});
