import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { coreFixture } from "../helpers/core-fixture.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixture: ReturnType<typeof coreFixture>;

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.dir,
  ensureBossmodeDir: () => mkdirSync(state.dir, { recursive: true }),
  readConfig: () => ({ runtime: {}, defaults: {} }),
  writeConfig: vi.fn(),
}));

import {
  scopeIdOf,
  parseScopeId,
  parseInstanceKey,
  instanceKey,
  scopeDirName,
} from "../../src/shared/conversation-ref.js";
import {
  createTopic,
  getTopic,
  listTopics,
  readAllTopicMessages,
  resolveTopicRoomId,
  buildTopicGuideText,
} from "../../src/workspace/topic-store.js";
import { postMessage } from "../../src/communication/message-bus.js";
import * as messageStore from "../../src/workspace/message-store.js";
import { compileMemberPromptForScope } from "../../src/engine/prompt-compiler.js";
import type { Room } from "../../src/shared/types.js";

function seedRoom(roomId: string, name = "Test Room"): Room {
  const room: Room = {
    id: roomId,
    name,
    cwd: "/tmp",
    members: ["pm", "developer"],
    roomMembers: [
      { id: "mem_pm", name: "pm", sourceAgent: "pm", createdAt: 1, updatedAt: 1 },
      { id: "mem_dev", name: "developer", sourceAgent: "developer", createdAt: 1, updatedAt: 1 },
    ],
    createdAt: 1,
  } as Room;
  for (const member of room.roomMembers ?? []) {
    new MembersRepository(fixture.db).insert({ id: member.id, name: member.name, agentTemplate: member.sourceAgent,
      global: {}, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
  }
  room.globalMemberIds = room.roomMembers!.map(m => m.id);
  new ConversationsRepository(fixture.db).upsertRoom(room);
  return room;
}

describe("conversation-ref topic kind", () => {
  it("scopeIdOf / parseScopeId / instanceKey round-trip", () => {
    const id = scopeIdOf({ kind: "topic", topicId: "topic_abc", roomId: "room1" });
    expect(id).toBe("topic:topic_abc");
    const parsed = parseScopeId(id);
    expect(parsed?.kind).toBe("topic");
    if (parsed?.kind === "topic") expect(parsed.topicId).toBe("topic_abc");
    expect(scopeDirName(id)).toBe("topic-topic_abc");
    const key = instanceKey(id, "mem_dev");
    expect(key).toBe("topic:topic_abc:mem_dev");
    expect(parseInstanceKey(key)).toEqual({ scopeId: "topic:topic_abc", memberId: "mem_dev" });
  });
});

describe("topic-store + message isolation", () => {
  beforeEach(() => {
    fixture = coreFixture();
    state.dir = fixture.root;
  });
  afterEach(() => {
    fixture.close();
  });

  it("creates topic, routes messages to topic store only", () => {
    const room = seedRoom("roomA");
    // Seed an anchor message in the room
    const anchor = messageStore.addMessage(room.id, {
      sender: "user",
      content: "Please investigate the flaky test",
      mentions: [],
    });

    const topic = createTopic({
      roomId: room.id,
      title: "Flaky test",
      anchorMessageId: anchor.id,
      anchorSeq: anchor.seq,
      seedMode: "fresh",
      guideText: buildTopicGuideText({
        title: "Flaky test",
        roomName: room.name,
        roomId: room.id,
        anchorExcerpt: anchor.content,
        seedMode: "fresh",
      }),
    });

    expect(getTopic(room.id, topic.id)?.title).toBe("Flaky test");
    expect(resolveTopicRoomId(topic.id)).toBe(room.id);
    expect(listTopics(room.id)).toHaveLength(1);

    const roomCountBefore = messageStore.readAllMessages(room.id).length;

    // Post into topic scope
    const scopeId = `topic:${topic.id}`;
    const tmsg = postMessage(scopeId, "developer", "I will dig in", ["pm"]);
    expect(tmsg.seq).toBe(1);
    expect(readAllTopicMessages(room.id, topic.id)).toHaveLength(1);

    // Parent room stream unchanged (no leak)
    expect(messageStore.readAllMessages(room.id)).toHaveLength(roomCountBefore);
  });

  it("guide text is English and carries parent room scope", () => {
    const g = buildTopicGuideText({
      title: "T",
      roomName: "dev",
      roomId: "r1",
      anchorExcerpt: "hello",
      seedMode: "fresh",
    });
    expect(g).toMatch(/Topic guide/);
    expect(g).toMatch(/room:r1/);
    expect(g).toMatch(/query_room_messages/);
    expect(g).toMatch(/Concurrency: this topic runs in parallel/);
    expect(g).toMatch(/mainline mutations/);
    const fork = buildTopicGuideText({
      title: "T",
      roomName: "dev",
      roomId: "r1",
      anchorExcerpt: "hello",
      seedMode: "fork",
    });
    expect(fork).toMatch(/Concurrency: this topic runs in parallel/);
  });
});

describe("prompt cache invariant (topic == parent room compile)", () => {
  beforeEach(() => {
    fixture = coreFixture();
    state.dir = fixture.root;
    // Minimal memory dirs
    mkdirSync(join(state.dir, "members"), { recursive: true });
  });
  afterEach(() => {
    fixture.close();
  });

  it("compileMemberPromptForScope topic shares Member+Communication with room (cache invariant)", () => {
    const room = seedRoom("roomB", "Boss Room");
    const docsRoot = join(state.dir, "docs");
    mkdirSync(docsRoot, { recursive: true });

    const roomCompiled = compileMemberPromptForScope({
      scopeId: `room:${room.id}`,
      memberId: "mem_dev",
      memberName: "developer",
      room,
      docsRoot,
    });
    const topic = createTopic({ roomId: room.id, title: "xyz", anchorMessageId: "", seedMode: "fresh" });
    const topicCompiled = compileMemberPromptForScope({
      scopeId: `topic:${topic.id}`,
      memberId: "mem_dev",
      memberName: "developer",
      room,
      docsRoot,
      topicTitle: "xyz",
    });

    // Spec 1.4: ①② byte-identical; Environment first line is topic-scoped.
    const roomMember = roomCompiled.sections.find((s) => s.id === "member")!.content;
    const topicMember = topicCompiled.sections.find((s) => s.id === "member")!.content;
    const roomComm = roomCompiled.sections.find((s) => s.id === "communication")!.content;
    const topicComm = topicCompiled.sections.find((s) => s.id === "communication")!.content;
    expect(topicMember).toBe(roomMember);
    expect(topicComm).toBe(roomComm);
    expect(topicCompiled.contractFingerprint).toBe(roomCompiled.contractFingerprint);
    expect(topicCompiled.envPrompt).toContain('topic "xyz"');
  });
});
