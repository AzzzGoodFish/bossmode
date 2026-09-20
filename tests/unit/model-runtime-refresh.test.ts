import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { importModelProfile, type ModelCredentialProfile } from "../../src/config/models.js";
import { createDatabaseModelRuntime, ModelCredentialBinding, refreshDatabaseModelRuntime } from "../../src/config/pi-adapt/credentials.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { fixture.close(); });
function profile(id: string, providerSlug = "test-switch"): ModelCredentialProfile {
  return {
    id, name: id, enabled: true, isDefault: false, providerSlug, profileKind: "custom_endpoint",
    protocol: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", authType: "api_key", requestProfile: "standard",
    apiKey: `key-${id}`, models: [{ id: "one" }, { id: "two" }], createdAt: 1, updatedAt: 1,
  };
}

describe("model switch catalog synchronization", () => {
  it("does no registration or catalog refresh for unchanged models or same-endpoint accounts", async () => {
    const a = profile("A"), b = profile("B");
    importModelProfile(a); importModelProfile(b);
    const binding = new ModelCredentialBinding(a);
    const runtime = await createDatabaseModelRuntime(binding, a.id);
    binding.attach(runtime);
    const register = vi.spyOn(runtime, "registerProvider");
    const refresh = vi.spyOn(runtime, "refresh");
    await binding.runProfile(b, () => refreshDatabaseModelRuntime(runtime, b.id, { skipUnchanged: true }));
    expect(register).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    const first = binding.bind(runtime.getModel("test-switch", "one")!, a);
    const second = binding.bind(runtime.getModel("test-switch", "two")!, b);
    expect((await runtime.getAuth(first))?.auth.apiKey).toBe("key-A");
    expect((await runtime.getAuth(second))?.auth.apiKey).toBe("key-B");
    // Explicit catalog refresh still consumes new SQL catalog snapshots.
    await refreshDatabaseModelRuntime(runtime, b.id);
    expect(register).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("updates changed endpoints, clears removed fields and supports switching back", async () => {
    const a = { ...profile("A"), headers: { "x-test": "A" } };
    const b = { ...profile("B"), baseUrl: "http://127.0.0.1:2/v1" };
    const unrelated = profile("C", "other-provider");
    importModelProfile(a); importModelProfile(b); importModelProfile(unrelated);
    const binding = new ModelCredentialBinding(a);
    const runtime = await createDatabaseModelRuntime(binding, a.id);
    binding.attach(runtime);
    const register = vi.spyOn(runtime, "registerProvider");
    await binding.runProfile(b, () => refreshDatabaseModelRuntime(runtime, b.id, { skipUnchanged: true }));
    expect(register.mock.calls.map(([id]) => id)).toEqual(["test-switch"]);
    expect(runtime.getModel("test-switch", "one")?.baseUrl).toBe(b.baseUrl);
    await binding.runProfile(a, () => refreshDatabaseModelRuntime(runtime, a.id, { skipUnchanged: true }));
    expect(runtime.getModel("test-switch", "one")?.baseUrl).toBe(a.baseUrl);
    importModelProfile({ ...a, headers: undefined });
    importModelProfile({ ...b, enabled: false });
    await refreshDatabaseModelRuntime(runtime, a.id, { skipUnchanged: true });
    expect(runtime.getModel("test-switch", "one")?.headers?.["x-test"]).toBeUndefined();
    importModelProfile({ ...a, enabled: false });
    await refreshDatabaseModelRuntime(runtime, a.id, { skipUnchanged: true });
    expect(runtime.getModel("test-switch", "one")).toBeUndefined();
    expect(runtime.getModel("other-provider", "two")).toBeDefined();
  });
});
