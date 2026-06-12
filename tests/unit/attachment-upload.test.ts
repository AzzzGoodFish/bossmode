import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

/**
 * Unit tests for attachment upload feature:
 * 1. Hash-based filename generation
 * 2. Attachment line format parsing
 * 3. Path traversal protection
 * 4. MIME type mapping
 * 5. Clipboard filename generation
 */

// -- Hash-based filename generation (mirrors workspace.ts logic) --

function generateStoredFilename(buffer: Buffer, originalFilename: string): string {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const lastDot = originalFilename.lastIndexOf(".");
  const ext = lastDot !== -1 ? originalFilename.slice(lastDot) : ".bin";
  return `${hash}${ext}`;
}

describe("generateStoredFilename", () => {
  it("produces sha256 hash prefix + original extension", () => {
    const buf = Buffer.from("hello world");
    const result = generateStoredFilename(buf, "screenshot.png");
    expect(result).toMatch(/^[a-f0-9]{12}\.png$/);
  });

  it("same content produces same hash", () => {
    const buf = Buffer.from("identical content");
    expect(generateStoredFilename(buf, "a.jpg")).toBe(generateStoredFilename(buf, "b.jpg").replace(/\.jpg$/, ".jpg"));
    // Actually verify same hash prefix
    const r1 = generateStoredFilename(buf, "a.jpg");
    const r2 = generateStoredFilename(buf, "b.png");
    expect(r1.slice(0, 12)).toBe(r2.slice(0, 12));
  });

  it("different content produces different hash", () => {
    const r1 = generateStoredFilename(Buffer.from("aaa"), "f.png");
    const r2 = generateStoredFilename(Buffer.from("bbb"), "f.png");
    expect(r1).not.toBe(r2);
  });

  it("preserves various extensions", () => {
    const buf = Buffer.from("data");
    expect(generateStoredFilename(buf, "doc.pdf")).toMatch(/\.pdf$/);
    expect(generateStoredFilename(buf, "image.jpeg")).toMatch(/\.jpeg$/);
    expect(generateStoredFilename(buf, "archive.zip")).toMatch(/\.zip$/);
  });

  it("defaults to .bin for no extension", () => {
    const buf = Buffer.from("data");
    expect(generateStoredFilename(buf, "noext")).toMatch(/\.bin$/);
  });
});

// -- Attachment line format parsing (mirrors MessageBubble.tsx logic) --

const ATTACHMENT_RE = /^Attachment: \[original filename: ([^\]]+)\]\(([^)]+)\)$/;

function parseAttachmentLine(line: string): { originalName: string; path: string } | null {
  const match = line.match(ATTACHMENT_RE);
  if (!match) return null;
  return { originalName: match[1], path: match[2] };
}

describe("parseAttachmentLine", () => {
  it("parses standard attachment line", () => {
    const line = "Attachment: [original filename: screenshot.png](/home/user/.bossmode/rooms/abc/attachments/a1b2c3d4e5f6.png)";
    const result = parseAttachmentLine(line);
    expect(result).toEqual({
      originalName: "screenshot.png",
      path: "/home/user/.bossmode/rooms/abc/attachments/a1b2c3d4e5f6.png",
    });
  });

  it("parses clipboard image filename", () => {
    const line = "Attachment: [original filename: clipboard-20260401-143022.png](/tmp/abc.png)";
    const result = parseAttachmentLine(line);
    expect(result).toEqual({
      originalName: "clipboard-20260401-143022.png",
      path: "/tmp/abc.png",
    });
  });

  it("handles filenames with spaces", () => {
    const line = "Attachment: [original filename: my document.pdf](/path/to/hash.pdf)";
    const result = parseAttachmentLine(line);
    expect(result?.originalName).toBe("my document.pdf");
  });

  it("returns null for non-attachment lines", () => {
    expect(parseAttachmentLine("Hello world")).toBeNull();
    expect(parseAttachmentLine("@agent do something")).toBeNull();
    expect(parseAttachmentLine("")).toBeNull();
  });

  it("returns null for malformed attachment lines", () => {
    expect(parseAttachmentLine("Attachment: [wrong format](path)")).toBeNull();
    expect(parseAttachmentLine("Attachment: [original filename: ]()")).toBeNull();
  });
});

// -- Content segment parsing (multiple attachments + text) --

function parseContentSegments(content: string): Array<{ type: "text"; text: string } | { type: "attachment"; originalName: string; path: string }> {
  const lines = content.split("\n");
  const segments: Array<{ type: "text"; text: string } | { type: "attachment"; originalName: string; path: string }> = [];
  let textBuffer: string[] = [];

  for (const line of lines) {
    const match = line.match(ATTACHMENT_RE);
    if (match) {
      if (textBuffer.length > 0) {
        segments.push({ type: "text", text: textBuffer.join("\n") });
        textBuffer = [];
      }
      segments.push({ type: "attachment", originalName: match[1], path: match[2] });
    } else {
      textBuffer.push(line);
    }
  }

  if (textBuffer.length > 0) {
    const text = textBuffer.join("\n");
    if (text.trim()) segments.push({ type: "text", text });
  }

  return segments;
}

describe("parseContentSegments", () => {
  it("text only → single text segment", () => {
    const segments = parseContentSegments("hello world");
    expect(segments).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("attachment only → single attachment segment", () => {
    const segments = parseContentSegments("Attachment: [original filename: f.png](/path/f.png)");
    expect(segments).toEqual([{ type: "attachment", originalName: "f.png", path: "/path/f.png" }]);
  });

  it("text + attachment", () => {
    const content = "Check this out\nAttachment: [original filename: img.jpg](/p/img.jpg)";
    const segments = parseContentSegments(content);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: "text", text: "Check this out" });
    expect(segments[1]).toEqual({ type: "attachment", originalName: "img.jpg", path: "/p/img.jpg" });
  });

  it("multiple attachments", () => {
    const content = [
      "Attachment: [original filename: a.png](/p/a.png)",
      "Attachment: [original filename: b.pdf](/p/b.pdf)",
    ].join("\n");
    const segments = parseContentSegments(content);
    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe("attachment");
    expect(segments[1].type).toBe("attachment");
  });

  it("text + multiple attachments + text", () => {
    const content = "Before\nAttachment: [original filename: f.png](/p/f.png)\nAfter";
    const segments = parseContentSegments(content);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "text", text: "Before" });
    expect(segments[1].type).toBe("attachment");
    expect(segments[2]).toEqual({ type: "text", text: "After" });
  });

  it("skips empty text segments", () => {
    const content = "Attachment: [original filename: f.png](/p/f.png)\n  \n";
    const segments = parseContentSegments(content);
    // trailing whitespace-only text should be omitted
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("attachment");
  });
});

// -- Path traversal protection (mirrors workspace.ts logic) --

function isFilenameValid(filename: string): boolean {
  const safe = filename.split("/").pop() || "";
  return safe === filename && !filename.includes("..");
}

describe("path traversal protection", () => {
  it("accepts simple filenames", () => {
    expect(isFilenameValid("a1b2c3d4e5f6.png")).toBe(true);
    expect(isFilenameValid("file.pdf")).toBe(true);
  });

  it("rejects directory traversal", () => {
    expect(isFilenameValid("../etc/passwd")).toBe(false);
    expect(isFilenameValid("../../secret.txt")).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isFilenameValid("/etc/passwd")).toBe(false);
  });

  it("rejects filenames with path separators", () => {
    expect(isFilenameValid("subdir/file.txt")).toBe(false);
  });
});

// -- MIME type mapping --

const ATTACHMENT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

describe("MIME type mapping", () => {
  it("maps common image types", () => {
    expect(ATTACHMENT_MIME[".png"]).toBe("image/png");
    expect(ATTACHMENT_MIME[".jpg"]).toBe("image/jpeg");
    expect(ATTACHMENT_MIME[".gif"]).toBe("image/gif");
    expect(ATTACHMENT_MIME[".webp"]).toBe("image/webp");
  });

  it("maps document types", () => {
    expect(ATTACHMENT_MIME[".pdf"]).toBe("application/pdf");
    expect(ATTACHMENT_MIME[".txt"]).toBe("text/plain");
    expect(ATTACHMENT_MIME[".json"]).toBe("application/json");
  });

  it("returns undefined for unknown extensions", () => {
    expect(ATTACHMENT_MIME[".exe"]).toBeUndefined();
    expect(ATTACHMENT_MIME[".dll"]).toBeUndefined();
  });
});

// -- Clipboard filename format --

function clipboardFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `clipboard-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`;
}

describe("clipboardFilename", () => {
  it("generates correct format", () => {
    const d = new Date(2026, 3, 1, 14, 30, 22); // April 1, 2026 14:30:22
    expect(clipboardFilename(d)).toBe("clipboard-20260401-143022.png");
  });

  it("pads single-digit months and days", () => {
    const d = new Date(2026, 0, 5, 9, 3, 7); // Jan 5, 2026 09:03:07
    expect(clipboardFilename(d)).toBe("clipboard-20260105-090307.png");
  });
});

// -- Image extension detection (mirrors MessageBubble.tsx) --

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

describe("isImagePath", () => {
  it("detects image paths", () => {
    expect(isImagePath("/path/to/file.png")).toBe(true);
    expect(isImagePath("/path/to/file.jpg")).toBe(true);
    expect(isImagePath("/path/to/file.jpeg")).toBe(true);
    expect(isImagePath("/path/to/file.gif")).toBe(true);
    expect(isImagePath("/path/to/file.webp")).toBe(true);
    expect(isImagePath("/path/to/file.svg")).toBe(true);
  });

  it("rejects non-image paths", () => {
    expect(isImagePath("/path/to/file.pdf")).toBe(false);
    expect(isImagePath("/path/to/file.txt")).toBe(false);
    expect(isImagePath("/path/to/file.zip")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isImagePath("/path/to/file.PNG")).toBe(true);
    expect(isImagePath("/path/to/file.JPG")).toBe(true);
  });
});

// -- Room-keyed in-memory attachment draft store --

describe("attachment draft store", () => {
  it("preserves pending files by room key and isolates rooms", async () => {
    const mod = await import("../../web/src/hooks/useUpload.js");
    mod.clearAttachmentDraftForTests("room:a");
    mod.clearAttachmentDraftForTests("room:b");

    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });

    mod.addAttachmentDraftFilesForTests("room:a", [fileA]);
    mod.addAttachmentDraftFilesForTests("room:b", [fileB]);

    expect(mod.getAttachmentDraftItemsForTests("room:a").map((i) => i.file.name)).toEqual(["a.txt"]);
    expect(mod.getAttachmentDraftItemsForTests("room:b").map((i) => i.file.name)).toEqual(["b.txt"]);

    mod.clearAttachmentDraftForTests("room:a");
    expect(mod.getAttachmentDraftItemsForTests("room:a")).toHaveLength(0);
    expect(mod.getAttachmentDraftItemsForTests("room:b").map((i) => i.file.name)).toEqual(["b.txt"]);

    mod.clearAttachmentDraftForTests("room:b");
  });
});
