/**
 * Member credential store — applied-binding semantics
 * (design-model-switch-single-path-v1 §4):
 * - No live instance → reads the member's GLOBAL config credential.
 * - A live instance answers with its APPLIED binding; a plain config save
 *   does not change what an existing session authenticates with.
 * - During a switch, the instance's switch TARGET credential answers for the
 *   new provider (setModel's auth check) while the old applied credential
 *   still answers for the old provider.
 * - Request pinning: a profile resolved by read() is the profile modify()
 *   writes back to (OAuth rotation cannot land on a different account).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

/** Fake live-instance surface the store resolves through agent-manager. */
const state = vi.hoisted(() => ({ instance: null as null | { appliedCredentialId?: string; switchTargetCredentialId?: string } }));

vi.mock("../../src/engine/agent-manager.js", () => ({
  getAgentInstanceForScope: (_scopeId: string, _memberId: string) => state.instance,
}));

async function seedTwoKeys() {
  const mod = await import("../../src/engine/model-credentials.js");
  await mod.ensurePiCatalogWarm();
  mod.setPiCatalogModelsForTests([
    { provider: "anthropic", id: "claude-a", name: "Claude A", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, input: ["text"] },
    { provider: "openai", id: "gpt-a", name: "GPT A", api: "openai-completions", baseUrl: "https://api.openai.com/v1", contextWindow: 200000, input: ["text"] },
  ]);
  const anthropicA = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-AAA", name: "Key A" });
  const anthropicB = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-BBB", name: "Key B" });
  const openai = mod.connectBuiltinProviderApiKey({ providerSlug: "openai", apiKey: "sk-OOO", name: "Key O" });
  return { mod, anthropicA, anthropicB, openai };
}

describe("member credential store — applied binding", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-member-cred-"));
    state.instance = null;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no live instance → reads the member's global config credential (live)", async () => {
    const { mod, anthropicA, anthropicB } = await seedTwoKeys();
    const { createMember, updateMember } = await import("../../src/workspace/member-registry.js");
    const m = createMember({ name: "dev", agentTemplate: "pm" });
    updateMember(m.id, { global: { credentialId: anthropicA.id } });

    const store = mod.createMemberCredentialStore("room-1", m.id);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-AAA" });
    expect(await store.read("openai")).toBeUndefined();

    // A config save changes what the NEXT session reads (no live instance).
    updateMember(m.id, { global: { credentialId: anthropicB.id } });
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-BBB" });
    mod.setPiCatalogModelsForTests(null);
  });

  it("live instance: the APPLIED binding wins over a later global save", async () => {
    const { mod, anthropicA, anthropicB } = await seedTwoKeys();
    const { createMember, updateMember } = await import("../../src/workspace/member-registry.js");
    const m = createMember({ name: "dev", agentTemplate: "pm" });
    updateMember(m.id, { global: { credentialId: anthropicA.id } });

    state.instance = { appliedCredentialId: anthropicA.id };
    const store = mod.createMemberCredentialStore("room-1", m.id);

    // Config saved to B after the session was built — the session still reads A.
    updateMember(m.id, { global: { credentialId: anthropicB.id } });
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-AAA" });
    mod.setPiCatalogModelsForTests(null);
  });

  it("mid-switch: the target credential answers the new provider, the applied one still answers the old", async () => {
    const { mod, anthropicA, openai } = await seedTwoKeys();
    state.instance = { appliedCredentialId: anthropicA.id, switchTargetCredentialId: openai.id };
    const store = mod.createMemberCredentialStore("room-1", "rm_dev");

    expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-OOO" });
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-AAA" });
    mod.setPiCatalogModelsForTests(null);
  });

  it("request pinning: modify writes back to the profile the request started with, not the current binding", async () => {
    const { mod, anthropicA, anthropicB } = await seedTwoKeys();
    const { createMember, updateMember, getMember } = await import("../../src/workspace/member-registry.js");
    const m = createMember({ name: "dev", agentTemplate: "pm" });
    updateMember(m.id, { global: { credentialId: anthropicA.id } });

    state.instance = { appliedCredentialId: anthropicA.id };
    const store = mod.createMemberCredentialStore("room-1", m.id);

    // Request starts: read pins profile A.
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-AAA" });

    // The switch completes mid-request (applied flips to B).
    state.instance = { appliedCredentialId: anthropicB.id };
    updateMember(m.id, { global: { credentialId: anthropicB.id } });

    // The OAuth-style rotation from the started request lands on A, not B.
    await store.modify("anthropic", async () => ({ type: "api_key" as const, key: "sk-ROTATED" }));
    expect(getMember(m.id)!.global!.credentialId).toBe(anthropicB.id); // binding untouched
    const a = mod.getModelCredentialProfile(anthropicA.id)!;
    const b = mod.getModelCredentialProfile(anthropicB.id)!;
    expect((a as any).apiKey).toBe("sk-ROTATED");
    expect((b as any).apiKey).toBe("sk-BBB");
    mod.setPiCatalogModelsForTests(null);
  });
});
