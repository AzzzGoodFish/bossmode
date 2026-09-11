import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("authenticated layout shell anchoring", () => {
  it("anchors the authenticated app shell to the viewport instead of the document flow", () => {
    const layout = source("web/src/pages/Layout.tsx");
    const shell = [...layout.matchAll(/className="([^"]+)"/g)].find((match) =>
      match[1].split(/\s+/).includes("bm-app-shell"),
    );
    expect(shell).toBeDefined();
    for (const token of [
      "fixed",
      "inset-x-0",
      "top-0",
      "h-[100dvh]",
      "bg-surface-0",
      "text-ink-1",
      "flex",
    ])
      expect(shell![1].split(/\s+/)).toContain(token);
  });

  it("does not restore a global document scroll lock or touch the Login page", () => {
    const css = source("web/src/index.css");
    expect(css).not.toMatch(/html,\s*body,\s*#root/);
    const login = source("web/src/pages/Login.tsx");
    expect(login).toContain("min-h-screen");
  });
});
