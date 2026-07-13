import { describe, expect, it } from "vitest";
import { getLibraryFileFormat } from "../../web/src/utils/library-file-format";

describe("library file format labels", () => {
  it("labels supported Library file formats for visible badges", () => {
    expect(getLibraryFileFormat("docs/plan.md")).toMatchObject({ kind: "md", label: "MD", description: "Markdown" });
    expect(getLibraryFileFormat("docs/PLAN.MARKDOWN")).toMatchObject({ kind: "md", label: "MD" });
    expect(getLibraryFileFormat("site/index.html")).toMatchObject({ kind: "html", label: "HTML" });
    expect(getLibraryFileFormat("site/partial.htm")).toMatchObject({ kind: "html", label: "HTML" });
    expect(getLibraryFileFormat("images/hero.png")).toMatchObject({ kind: "png", label: "PNG" });
    expect(getLibraryFileFormat("data/sample.json")).toMatchObject({ kind: "json", label: "JSON" });
    expect(getLibraryFileFormat("notes/todo.txt")).toMatchObject({ kind: "txt", label: "TXT" });
    expect(getLibraryFileFormat("archive/blob.bin")).toMatchObject({ kind: "file", label: "FILE" });
  });
});
