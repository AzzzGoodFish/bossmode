import { describe, expect, it } from "vitest";
import { normalizeKnowledgeMarkdownRef } from "../../web/src/utils/knowledge-path";

describe("normalizeKnowledgeMarkdownRef", () => {
  it("strips one leading docs/ from markdown refs", () => {
    expect(normalizeKnowledgeMarkdownRef("docs/vulnhunt-srv/architecture/plan.md")).toEqual({
      originalPath: "docs/vulnhunt-srv/architecture/plan.md",
      path: "vulnhunt-srv/architecture/plan.md",
      changed: true,
    });
    expect(normalizeKnowledgeMarkdownRef("docs/docs/a.md").path).toBe("docs/a.md");
  });

  it("does not rewrite urls, absolute paths, or non-markdown refs", () => {
    expect(normalizeKnowledgeMarkdownRef("https://example.com/docs/a.md").path).toBe("https://example.com/docs/a.md");
    expect(normalizeKnowledgeMarkdownRef("/tmp/docs/a.md").path).toBe("/tmp/docs/a.md");
    expect(normalizeKnowledgeMarkdownRef("docs/folder").path).toBe("docs/folder");
  });
});
