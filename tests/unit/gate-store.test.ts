import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-gate-test-"));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
  ensureBossmodeDir: () => {},
  writePidFile: () => {},
  removePidFile: () => {},
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } }),
  configExists: () => true,
}));

function ensureRoom(roomId: string, members: string[] = ["pm", "architect", "developer"]) {
  const dir = join(tmpDir, "rooms", roomId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "room.json"), JSON.stringify({
    id: roomId, name: `Room ${roomId}`, cwd: "/tmp", members, createdAt: Date.now(),
  }), "utf-8");
}

describe("gate-store", () => {
  it("creates a pending gate with normalized fields", async () => {
    const { createGate, getGate } = await import("../../src/workspace/gate-store.js");
    ensureRoom("g1");
    const gate = createGate("g1", {
      title: "  需求细则 v1  ",
      summary: "完成需求拆解",
      artifacts: ["bossmode/prds/spec.md", "", "  https://example.com  "],
      requestedBy: "pm",
      handoffTo: "architect",
    });
    expect(gate.id).toMatch(/^gate-/);
    expect(gate.title).toBe("需求细则 v1");
    expect(gate.status).toBe("pending");
    expect(gate.artifacts).toEqual(["bossmode/prds/spec.md", "https://example.com"]);
    expect(gate.handoffTo).toBe("architect");

    const found = getGate("g1", gate.id);
    expect(found?.title).toBe("需求细则 v1");
  });

  it("lists gates newest-first with status filter", async () => {
    const { createGate, listGates, decideGate } = await import("../../src/workspace/gate-store.js");
    ensureRoom("g2");
    const a = createGate("g2", { title: "A", summary: "s", requestedBy: "pm" });
    const b = createGate("g2", { title: "B", summary: "s", requestedBy: "pm" });
    decideGate("g2", a.id, "approve");

    const all = listGates("g2");
    expect(all.length).toBe(2);
    const pending = listGates("g2", { status: "pending" });
    expect(pending.map((g) => g.id)).toEqual([b.id]);
  });

  it("approve and reject record decision metadata", async () => {
    const { createGate, decideGate } = await import("../../src/workspace/gate-store.js");
    ensureRoom("g3");
    const a = createGate("g3", { title: "A", summary: "s", requestedBy: "pm" });
    const approved = decideGate("g3", a.id, "approve", "LGTM");
    expect(approved?.status).toBe("approved");
    expect(approved?.decisionNote).toBe("LGTM");
    expect(approved?.decidedAt).toBeGreaterThan(0);

    const b = createGate("g3", { title: "B", summary: "s", requestedBy: "pm" });
    const rejected = decideGate("g3", b.id, "reject", "缺少验收标准");
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.decisionNote).toBe("缺少验收标准");
  });

  it("throws when deciding an already-decided gate", async () => {
    const { createGate, decideGate } = await import("../../src/workspace/gate-store.js");
    ensureRoom("g4");
    const a = createGate("g4", { title: "A", summary: "s", requestedBy: "pm" });
    decideGate("g4", a.id, "approve");
    expect(() => decideGate("g4", a.id, "reject")).toThrow(/already approved/);
  });

  it("returns null for unknown gate", async () => {
    const { decideGate } = await import("../../src/workspace/gate-store.js");
    ensureRoom("g5");
    expect(decideGate("g5", "gate-nope", "approve")).toBeNull();
  });
});

describe("gate API behaviors (createGateAndAnnounce + decision messaging)", () => {
  it("rejects handoff to a non-member", async () => {
    const { createGateAndAnnounce } = await import("../../src/api/gates.js");
    ensureRoom("g6", ["pm", "developer"]);
    expect(() =>
      createGateAndAnnounce("g6", { title: "T", summary: "s", requestedBy: "pm", handoffTo: "ghost" }),
    ).toThrow(/not a member/);
  });

  it("announces a gate_event message into the room stream", async () => {
    const { createGateAndAnnounce } = await import("../../src/api/gates.js");
    const messageStore = await import("../../src/workspace/message-store.js");
    ensureRoom("g7");
    const gate = createGateAndAnnounce("g7", {
      title: "架构设计", summary: "见文档", artifacts: ["bossmode/architecture/x.md"],
      requestedBy: "architect", handoffTo: "developer",
    });
    const messages = messageStore.getMessages("g7");
    const gateMsg = messages.find((m) => m.type === "gate_event");
    expect(gateMsg).toBeTruthy();
    expect(gateMsg!.gate_event_meta?.action).toBe("requested");
    expect(gateMsg!.gate_event_meta?.gateId).toBe(gate.id);
    expect(gateMsg!.gate_event_meta?.summary).toBe("见文档");
    expect(gateMsg!.gate_event_meta?.handoffTo).toBe("developer");
  });
});
