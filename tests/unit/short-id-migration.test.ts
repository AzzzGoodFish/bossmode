import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRenameOps,
  assignShortIds,
  clearShortIdJournal,
  isExcludedRelPath,
  mapCompositeString,
  planFilesystemRenames,
  readShortIdJournal,
  renameSegment,
  replayShortIdJournal,
  writeShortIdJournal,
  type ShortIdMapping,
} from "../../src/storage/short-id-migration.js";

const M1 = "mem_11111111-1111-4111-8111-111111111111";
const M2 = "mem_22222222-2222-4222-8222-222222222222";
const R1 = "aaaaaaaa-1111-4111-8111-111111111111";
const LEGACY_RECORD = "rm_0b5ee480-9212-4aef-8ebc-1711ad951f9f";

const fixtureMapping = (): ShortIdMapping => ({
  members: new Map([
    [M1, "mem_aaaaaaaaaa"],
    [M2, "mem_bbbbbbbbbb"],
  ]),
  rooms: new Map([[R1, "rm_cccccccccc"]]),
});

const tmpRoots: string[] = [];
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "sid-migration-"));
  tmpRoots.push(root);
  return root;
};
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("assignShortIds", () => {
  it("assigns fresh ids and retries on collisions", () => {
    let memberCalls = 0;
    const mapping = assignShortIds([M1, M2], [R1], {
      member: () => (++memberCalls === 1 ? M1 : `mem_${"a".repeat(9)}${memberCalls - 1}`),
      room: () => "rm_bbbbbbbbb1",
    });
    expect(mapping.members.get(M1)).toBe("mem_aaaaaaaaa1"); // first candidate collided, retried
    expect(mapping.members.get(M2)).toBe("mem_aaaaaaaaa2");
    expect(mapping.rooms.get(R1)).toBe("rm_bbbbbbbbb1");
    const assigned = [...mapping.members.values(), ...mapping.rooms.values()];
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.some((id) => [M1, M2, R1].includes(id))).toBe(false);
  });

  it("throws when the generator keeps colliding", () => {
    expect(() => assignShortIds([M1], [], { member: () => M1 })).toThrow(/kept colliding/);
  });
});

describe("renameSegment", () => {
  const mapping = fixtureMapping();

  it("renames exact member/room ids and their prefixed forms", () => {
    expect(renameSegment(M1, mapping)).toBe("mem_aaaaaaaaaa");
    expect(renameSegment(R1, mapping)).toBe("rm_cccccccccc");
    expect(renameSegment(`dm:${M2}`, mapping)).toBe("dm:mem_bbbbbbbbbb");
    expect(renameSegment(`room_${R1}`, mapping)).toBe("room_rm_cccccccccc");
    expect(renameSegment(`${M1}.jsonl`, mapping)).toBe("mem_aaaaaaaaaa.jsonl");
    expect(renameSegment(`${M1}.stats.json`, mapping)).toBe("mem_aaaaaaaaaa.stats.json");
  });

  it("recomputes mm pairs when the canonical order flips with new ids", () => {
    const flipped: ShortIdMapping = {
      members: new Map([
        [M1, "mem_zzzzzzzzzz"],
        [M2, "mem_aaaaaaaaaa"],
      ]),
      rooms: new Map(),
    };
    expect(renameSegment(`mm:${M1}-${M2}`, flipped)).toBe("mm:mem_aaaaaaaaaa-mem_zzzzzzzzzz");
  });

  it("renames room-<id> segments and embedded forms, never bare uuids", () => {
    expect(renameSegment(`room-${R1}`, mapping)).toBe("room-rm_cccccccccc");
    expect(renameSegment(`scopes-room-${R1}.md`, mapping)).toBe("scopes-room-rm_cccccccccc.md");
    expect(renameSegment(`mainline-room-${R1}.md`, mapping)).toBe("mainline-room-rm_cccccccccc.md");
    expect(renameSegment("room-abc", mapping)).toBeNull(); // prefix without a mapped id
    expect(renameSegment("room-99999999-1111-4111-8111-111111111111", mapping)).toBeNull(); // a different id stays
  });

  it("never touches unmapped legacy records or unrelated names", () => {
    expect(renameSegment(LEGACY_RECORD, mapping)).toBeNull();
    expect(renameSegment("sessions", mapping)).toBeNull();
    expect(renameSegment(`dm:${LEGACY_RECORD}`, mapping)).toBeNull();
    expect(renameSegment(`mm:${M1}-${LEGACY_RECORD}`, mapping)).toBeNull();
    expect(renameSegment("mem_active", mapping)).toBeNull();
  });
});

describe("mapCompositeString", () => {
  const mapping = fixtureMapping();

  it("rebuilds mm pairs canonically inside composite strings", () => {
    const flipped: ShortIdMapping = {
      members: new Map([
        [M1, "mem_zzzzzzzzzz"],
        [M2, "mem_aaaaaaaaaa"],
      ]),
      rooms: new Map(),
    };
    expect(mapCompositeString(`message:mm:${M1}-${M2}:msg-1`, flipped)).toBe("message:mm:mem_aaaaaaaaaa-mem_zzzzzzzzzz:msg-1");
  });

  it("rewrites colon-delimited room scopes (dedupe keys)", () => {
    expect(mapCompositeString(`message:${R1}:msg-004a07d4`, mapping)).toBe("message:rm_cccccccccc:msg-004a07d4");
    expect(mapCompositeString(`scope-notification:${R1}:task-ui:msg-1`, mapping)).toBe("scope-notification:rm_cccccccccc:task-ui:msg-1");
  });

  it("keeps legacy room-tree member segments old while the room parts follow", () => {
    expect(mapCompositeString(`rooms/${R1}/memory/members/${M1}/mainline.md`, mapping)).toBe(`rooms/rm_cccccccccc/memory/members/${M1}/mainline.md`);
    expect(mapCompositeString(`rooms/${R1}/memory/members/${M1}/history/mainline/x.md`, mapping)).toBe(`rooms/rm_cccccccccc/memory/members/${M1}/history/mainline/x.md`);
    expect(mapCompositeString(`members/${M1}/memory/scopes/room-${R1}/mainline.md`, mapping)).toBe(`members/mem_aaaaaaaaaa/memory/scopes/room-rm_cccccccccc/mainline.md`);
  });

  it("never touches unmapped legacy records", () => {
    expect(mapCompositeString(`dm:${LEGACY_RECORD}`, mapping)).toBe(`dm:${LEGACY_RECORD}`);
  });
});

describe("isExcludedRelPath", () => {
  it("matches the exclusion zones and leaves live paths alone", () => {
    expect(isExcludedRelPath("backups/x/y.jsonl")).toBe(true);
    expect(isExcludedRelPath("a/backups/b")).toBe(true);
    expect(isExcludedRelPath("pi-agent/runtime/.migration-snapshots/x")).toBe(true);
    expect(isExcludedRelPath("migration-backup-1/x")).toBe(true);
    expect(isExcludedRelPath("members.json")).toBe(true);
    expect(isExcludedRelPath("foo/bar.pre-1")).toBe(true);
    expect(isExcludedRelPath("members/mem_x/persona.md")).toBe(false);
    expect(isExcludedRelPath("rooms/rm_x/agent-events/mem_y.jsonl")).toBe(false);
  });
});

describe("planFilesystemRenames + applyRenameOps", () => {
  it("plans and executes renames idempotently across the surface roots", () => {
    const root = makeRoot();
    // Members tree, including a legacy per-scope session path with a room id.
    mkdirSync(join(root, "members", M1, "sessions", "2026-09-11", "rooms", R1), { recursive: true });
    writeFileSync(join(root, "members", M1, "persona.md"), "p");
    writeFileSync(join(root, "members", M1, "sessions", "2026-09-11", "rooms", R1, "s.jsonl"), "{}");
    // Room tree: agent-event file (id in name) + legacy principles tree.
    mkdirSync(join(root, "rooms", R1, "agent-events"), { recursive: true });
    writeFileSync(join(root, "rooms", R1, "agent-events", `${M1}.jsonl`), "{}");
    mkdirSync(join(root, "rooms", R1, "memory", "members", M1), { recursive: true });
    writeFileSync(join(root, "rooms", R1, "memory", "members", M1, "principles.md"), "x");
    mkdirSync(join(root, "rooms", `dm:${M2}`), { recursive: true });
    // pi-agent runtime: exclusions must stay put.
    mkdirSync(join(root, "pi-agent", "runtime", ".migration-snapshots", M1), { recursive: true });
    mkdirSync(join(root, "pi-agent", "runtime", `room_${R1}`, M2), { recursive: true });
    writeFileSync(join(root, "pi-agent", "runtime", `room_${R1}`, M2, "settings.json"), "{}");

    const mapping = fixtureMapping();
    const ops = planFilesystemRenames(root, mapping);
    const froms = ops.map((op) => op.from);
    expect(froms).toContain(`members/${M1}/sessions/2026-09-11/rooms/${R1}`);
    expect(froms).toContain(`members/${M1}`);
    expect(froms).toContain(`rooms/${R1}/agent-events/${M1}.jsonl`);
    expect(froms).toContain(`rooms/${R1}`);
    expect(froms).toContain(`rooms/dm:${M2}`);
    expect(froms).toContain(`pi-agent/runtime/room_${R1}`);
    expect(froms).not.toContain(`rooms/${R1}/memory/members/${M1}`); // legacy archive segment kept
    expect(froms.some((from) => from.includes(".migration-snapshots"))).toBe(false);
    // Post-order: children before their directory.
    expect(froms.indexOf(`rooms/${R1}/agent-events/${M1}.jsonl`)).toBeLessThan(froms.indexOf(`rooms/${R1}`));

    const result = applyRenameOps(root, ops);
    expect(result.failures).toEqual([]);
    expect(result.done).toBe(ops.length);
    expect(existsSync(join(root, "members", "mem_aaaaaaaaaa", "sessions", "2026-09-11", "rooms", "rm_cccccccccc", "s.jsonl"))).toBe(true);
    expect(existsSync(join(root, "rooms", "rm_cccccccccc", "agent-events", "mem_aaaaaaaaaa.jsonl"))).toBe(true);
    expect(existsSync(join(root, "rooms", "rm_cccccccccc", "memory", "members", M1, "principles.md"))).toBe(true);
    expect(existsSync(join(root, "rooms", `dm:mem_bbbbbbbbbb`))).toBe(true);
    expect(existsSync(join(root, "pi-agent", "runtime", "room_rm_cccccccccc", "mem_bbbbbbbbbb", "settings.json"))).toBe(true);
    expect(existsSync(join(root, "pi-agent", "runtime", ".migration-snapshots", M1))).toBe(true);

    // Second pass over the already-renamed tree plans nothing.
    expect(planFilesystemRenames(root, mapping)).toEqual([]);
  });
});

describe("journal", () => {
  it("writes, reads, and replays; replay is idempotent and clears the journal", () => {
    const root = makeRoot();
    mkdirSync(join(root, "members", M1), { recursive: true });
    const mapping = fixtureMapping();
    const ops = planFilesystemRenames(root, mapping);
    expect(ops.length).toBeGreaterThan(0);

    writeShortIdJournal(root, ops);
    const journal = readShortIdJournal(root);
    expect(journal?.ops).toEqual(ops);

    // Replay before any rename: applies everything, then clears the journal.
    const first = replayShortIdJournal(root);
    expect(first.status).toBe("replayed");
    expect(existsSync(join(root, "members", "mem_aaaaaaaaaa"))).toBe(true);
    expect(readShortIdJournal(root)).toBeNull();

    expect(replayShortIdJournal(root)).toEqual({ status: "none" });
  });

  it("skips already-applied renames on replay", () => {
    const root = makeRoot();
    mkdirSync(join(root, "members", M1), { recursive: true });
    const mapping = fixtureMapping();
    const ops = planFilesystemRenames(root, mapping);
    applyRenameOps(root, ops);
    writeShortIdJournal(root, ops);
    const replay = replayShortIdJournal(root);
    expect(replay.status).toBe("replayed");
    if (replay.status === "replayed") {
      expect(replay.done).toBe(0);
      expect(replay.skipped).toBe(ops.length);
    }
    clearShortIdJournal(root);
  });

  it("replays nested ops whose parent already moved (crash before journal clear)", () => {
    const root = makeRoot();
    mkdirSync(join(root, "rooms", R1, "agent-events"), { recursive: true });
    writeFileSync(join(root, "rooms", R1, "agent-events", `${M1}.jsonl`), "{}");
    const mapping = fixtureMapping();
    const ops = planFilesystemRenames(root, mapping);
    expect(ops.length).toBe(2); // child file op + parent room op
    applyRenameOps(root, ops); // everything applied…
    writeShortIdJournal(root, ops); // …then a crash before the journal is cleared

    // Without the mapping the nested op cannot be folded to its final path — the
    // replay reports it rather than guessing (documents why the caller passes it).
    const blind = replayShortIdJournal(root);
    expect(blind.status).toBe("failed");
    if (blind.status === "failed") expect(blind.failures.length).toBe(1);

    // With the mapping the fold resolves the final location: replayed, all skipped.
    const replay = replayShortIdJournal(root, () => mapping);
    expect(replay.status).toBe("replayed");
    if (replay.status === "replayed") {
      expect(replay.done).toBe(0);
      expect(replay.skipped).toBe(ops.length);
    }
    expect(readShortIdJournal(root)).toBeNull();
    expect(existsSync(join(root, "rooms", "rm_cccccccccc", "agent-events", "mem_aaaaaaaaaa.jsonl"))).toBe(true);
  });
});
