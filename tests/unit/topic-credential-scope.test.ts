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

    mkdirSync(join(dir, "rooms", "roomA"), { recursive: true });
    writeFileSync(join(dir, "rooms", "roomA", "room.json"), JSON.stringify({
      id: "roomA",
      name: "R",
      cwd: "/tmp",
      members: ["alice"],
      roomMembers: [{
        id: "mem_alice",
        name: "alice",
        sourceAgent: "pm",
        roomId: "roomA",
        credentialId: profile.id,
        model: "qa-custom/cust-model-a",
        config: { credentialId: profile.id, model: "qa-custom/cust-model-a" },
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

    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    const bound = resolveRoomMember("roomA", "mem_alice");
    expect(bound?.credentialId).toBe(profile.id);
    expect(creds.getModelCredentialProfile(profile.id)?.providerSlug).toBe(profile.providerSlug);

    const store = creds.createMemberCredentialStore(`topic:${topic.id}`, "mem_alice");
    expect(await store.read(profile.providerSlug)).toEqual({ type: "api_key", key: "sk-topic-test" });
    expect(await store.read("anthropic")).toBeUndefined();
  });
});
