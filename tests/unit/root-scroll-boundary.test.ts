import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("root scroll boundary", () => {
  it("keeps the document root viewport-sized, themed, and non-scrollable", () => {
    const css = source("web/src/index.css");
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*height:\s*100%;[^}]*background:\s*var\(--surface-0\);[^}]*overflow:\s*hidden;/s);
  });

  it("contains Sidebar scrolling instead of chaining it to the document", () => {
    const sidebar = source("web/src/components/Sidebar.tsx");
    expect(sidebar).toContain("flex-1 overflow-y-auto overscroll-contain min-h-0 p-2");
  });

  it("keeps the login page scrollable inside the locked document root", () => {
    const login = source("web/src/pages/Login.tsx");
    expect(login).toContain('className="h-full overflow-y-auto bg-surface-0 flex items-center justify-center px-4 py-4"');
  });
});
