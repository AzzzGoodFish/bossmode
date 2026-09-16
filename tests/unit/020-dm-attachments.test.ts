import type { coreFixture } from "../helpers/core-fixture.js";
/**
 * DM attachments (fish 2026-08-04: DM chat essentials align with room).
 * DM upload stores member-owned under members/<id>/dm-attachments/; the DM
 * message store persists structured attachments on the RoomMessage shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

let fixture: ReturnType<typeof coreFixture>;
let dir: string;

vi.mock("../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

describe("DM attachments", () => {
  beforeEach(async () => {
    vi.resetModules();
    fixture = (await import("../helpers/core-fixture.js")).coreFixture();
    dir = fixture.root;
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
  });

  afterEach(() => {
    fixture.close();
  });

  it("streamToDmAttachment stores member-owned with hash naming + traversal protection", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const member = reg.createMember({ name: "archie", agentTemplate: "archie" });
    const store = await import("../../src/files/attachment-store.js");

    const stored = await store.streamToDmAttachment(Readable.from(["DM-FILE-CONTENT"]), member.id, "notes.txt");
    expect(stored.storedFilename.endsWith(".txt")).toBe(true);
    expect(stored.size).toBe(15);
    expect(stored.absolutePath).toContain(join("members", member.id, "dm-attachments"));
    expect(readFileSync(stored.absolutePath, "utf-8")).toBe("DM-FILE-CONTENT");

    expect(store.dmAttachmentExists(member.id, stored.storedFilename)).toBe(true);
    expect(store.dmAttachmentExists(member.id, "nope.txt")).toBe(false);
    expect(() => store.getDmAttachmentPath(member.id, "../escape.txt")).toThrow(/Invalid filename/);
  });

  it("DM message store persists structured attachments on the RoomMessage shape", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const member = reg.createMember({ name: "archie", agentTemplate: "archie" });
    const dm = await import("../../src/chat/dm-message-store.js");

    const attachments = [{ storedFilename: "abc123.txt", originalFilename: "notes.txt", size: 15 }];
    const msg = dm.addDmMessage(member.id, { sender: "user", content: "see attached", mentions: [], attachments } as any);
    expect(msg.attachments).toHaveLength(1);
    expect((msg.attachments as any[])[0].originalFilename).toBe("notes.txt");

    fixture.reopen();
    const back = dm.readAllDmMessages(member.id);
    expect(back).toHaveLength(1);
    expect((back[0].attachments as any[])[0].storedFilename).toBe("abc123.txt");
  });
});
