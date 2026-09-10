import { createMember, findMemberByName } from "../../src/workspace/member-registry.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeTestServer, createMockRoom, createTestServer, jsonRequest, setupTestWorkspace } from "../helpers/test-server.js";

setupTestWorkspace();

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", { body: { username: "testuser", password: "testpass" } });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

describe("artifact preview API", () => {
  const servers: Awaited<ReturnType<typeof createTestServer>>[] = [];

  afterEach(async () => {
    while (servers.length) await closeTestServer(servers.pop()!);
  });

  it("normalizes docs/ references and reads artifacts from current member asset roots", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const token = await login(ts.port);

    const roomStore = await import("../../src/workspace/room-store.js");
    const knowledgeStore = await import("../../src/knowledge/store.js");

    // Batch 7 P3: rooms no longer bind a cwd — artifacts resolve against room
    // members' asset roots (home + workspaces). Seed under the pm member's dir.
    const { getTestBossmodeDir } = await import("../helpers/test-server.js");
    const room = await createMockRoom(ts.port, token, "Preview", ["pm"]);
    const pmDir = join(getTestBossmodeDir(), "members", room.globalMemberIds![0]);
    mkdirSync(join(pmDir, "design-prototype"), { recursive: true });
    writeFileSync(join(pmDir, "design-prototype/demo.html"), "<h1>Demo</h1>", "utf8");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    writeFileSync(join(pmDir, "design-prototype/demo.png"), png);

    knowledgeStore.addEntry("Plan", "# Plan\n\nBody", "test", "vulnhunt-srv/plan.md");

    const md = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/artifact-preview?path=${encodeURIComponent("docs/vulnhunt-srv/plan.md")}`, { token });
    expect(md.status).toBe(200);
    const mdBody = JSON.parse(md.body);
    expect(mdBody).toEqual(expect.objectContaining({
      type: "md",
      originalPath: "docs/vulnhunt-srv/plan.md",
      path: "vulnhunt-srv/plan.md",
      title: "Plan",
    }));
    expect(mdBody.content).toContain("# Plan");
    expect(mdBody.content).toContain("Body");

    const html = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/artifact-preview?path=${encodeURIComponent("design-prototype/demo.html")}`, { token });
    expect(html.status).toBe(200);
    expect(JSON.parse(html.body)).toEqual(expect.objectContaining({
      type: "html",
      originalPath: "design-prototype/demo.html",
      content: "<h1>Demo</h1>",
    }));

    const pngPreview = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/artifact-preview?path=${encodeURIComponent("design-prototype/demo.png")}`, { token });
    expect(pngPreview.status).toBe(200);
    const pngPreviewBody = JSON.parse(pngPreview.body);
    expect(pngPreviewBody.type).toBe("image");
    expect(pngPreviewBody.content).toMatch(/^data:image\/png;base64,/);

    const raw = await fetch(`http://127.0.0.1:${ts.port}/api/rooms/${room.id}/artifact-raw?path=${encodeURIComponent("design-prototype/demo.png")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await raw.arrayBuffer()).equals(png)).toBe(true);
  });

  it("returns a non-technical missing artifact message", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const token = await login(ts.port);
    const roomStore = await import("../../src/workspace/room-store.js");
    const cwd = mkdtempSync(join(tmpdir(), "bossmode-artifact-preview-"));
    const room = roomStore.createRoom("Preview", cwd, [(findMemberByName("pm") ?? createMember({ name: "pm" })).id]);

    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/artifact-preview?path=${encodeURIComponent("docs/missing.md")}`, { token });
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Artifact not found: docs/missing.md");
    expect(body.error).not.toContain("tried");
  });
});
