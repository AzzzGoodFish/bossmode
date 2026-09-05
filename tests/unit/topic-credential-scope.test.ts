import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

describe("MemberCredentialStore topic: scope", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-topic-cred-"));
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the parent-room binding when roomId is topic:<id>", async () => {
    const creds = await import("../../src/engine/model-credentials.js");
    const topicStore = await import("../../src/workspace/topic-store.js");
    const profile = creds.saveModelCredentialProfile({
      name: "QA custom",
      providerSlug: "qa-custom",
      protocol: "openai-completions",
      baseUrl: "http://127.0.0.1:9",
      authType: "api_key",
      apiKey: "sk-topic-test",
      requestProfile: "standard",
      enabled: true,
      isDefault: true,
      models: [{ id: "cust-model-a", contextWindow: 8000, input: ["text"] }],
    });

    const { createMember, updateMember } = await import("../../src/workspace/member-registry.js");
    const alice = createMember({ name: "alice", agentTemplate: "pm" });
    updateMember(alice.id, { global: { credentialId: profile.id } });

    mkdirSync(join(dir, "rooms", "roomA"), { recursive: true });
    writeFileSync(join(dir, "rooms", "roomA", "room.json"), JSON.stringify({
      id: "roomA",
      name: "R",
      cwd: "/tmp",
      members: ["alice"],
      roomMembers: [{
        id: alice.id,
        name: "alice",
        sourceAgent: "pm",
        roomId: "roomA",
        createdAt: 1,
        updatedAt: 1,
      }],
      createdAt: 1,
    }), "utf-8");

    const topic = topicStore.createTopic({
      roomId: "roomA",
      title: "fork-me",
      anchorMessageId: "m1",
      seedMode: "fork",
    });

    // Single-path credentials (design-model-switch-single-path-v1 §4): scope
    // shape no longer matters — the store resolves the member's GLOBAL config
    // binding (or the live instance's applied binding), never the parent-room
    // legacy binding.
    const store = creds.createMemberCredentialStore(`topic:${topic.id}`, alice.id);
    expect(await store.read(profile.providerSlug)).toEqual({ type: "api_key", key: "sk-topic-test" });
    expect(await store.read("anthropic")).toBeUndefined();
  });
});
