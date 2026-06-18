import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeTestServer, createTestServer, jsonRequest, setupConfigMock } from "../helpers/test-server.js";

setupConfigMock();

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

  it("normalizes docs/ markdown refs and reads html artifacts from room cwd", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const token = await login(ts.port);

    const roomStore = await import("../../src/workspace/room-store.js");
    const knowledgeStore = await import("../../src/knowledge/store.js");

    const cwd = mkdtempSync(join(tmpdir(), "bossmode-artifact-preview-"));
    mkdirSync(join(cwd, "design-prototype"), { recursive: true });
    writeFileSync(join(cwd, "design-prototype/demo.html"), "<h1>Demo</h1>", "utf8");

    const room = roomStore.createRoom("Preview", cwd, ["pm"]);
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
  });

  it("returns original and tried paths for missing artifacts", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const token = await login(ts.port);
    const roomStore = await import("../../src/workspace/room-store.js");
    const cwd = mkdtempSync(join(tmpdir(), "bossmode-artifact-preview-"));
    const room = roomStore.createRoom("Preview", cwd, ["pm"]);

    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/artifact-preview?path=${encodeURIComponent("docs/missing.md")}`, { token });
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("docs/missing.md");
    expect(body.error).toContain("missing.md");
    expect(body.error).toContain("tried");
  });
});
