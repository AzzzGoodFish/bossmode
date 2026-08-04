import { describe, it, expect } from "vitest";

/**
 * Tests that the attachment GET auth bypass regex correctly identifies attachment URLs.
 * The actual middleware is in src/api/index.ts — we test the regex pattern in isolation.
 */
describe("attachment auth bypass", () => {
  const pattern = /^\/api\/(rooms|dm)\/[^/]+\/attachments\//;

  it("matches valid attachment GET URLs (room + DM)", () => {
    expect(pattern.test("/api/rooms/bff2f08a-1234/attachments/9fcbdf0a8f31.png")).toBe(true);
    expect(pattern.test("/api/rooms/abc/attachments/file.pdf")).toBe(true);
    // DM attachments are member-owned (0.20 rc.5) — same sha256 unguessable naming.
    expect(pattern.test("/api/dm/mem_2a510c12-1234/attachments/9fcbdf0a8f31.png")).toBe(true);
  });

  it("does not match non-attachment API routes", () => {
    expect(pattern.test("/api/rooms/abc/messages")).toBe(false);
    expect(pattern.test("/api/rooms/abc/tasks")).toBe(false);
    expect(pattern.test("/api/dm/mem_abc/messages")).toBe(false);
    expect(pattern.test("/api/auth/login")).toBe(false);
    expect(pattern.test("/api/rooms")).toBe(false);
    expect(pattern.test("/api/dm/mem_abc/upload")).toBe(false);
  });

  it("does not match routes outside the attachment namespace", () => {
    // Path traversal is handled by the route handler (basename check), not the regex
    expect(pattern.test("/internal/rooms/abc/attachments/file")).toBe(false);
    expect(pattern.test("/rooms/abc/attachments/file")).toBe(false);
    expect(pattern.test("/api/attachments/file")).toBe(false);
  });
});
