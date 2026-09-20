import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, statSync } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { readTextOutput, terminalToolResult } from "../../src/agent/runtime/tool-output.js";

vi.mock("../../src/agent/tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/agent/tools.js")>(),
  handleToolCallback: vi.fn(),
}));
import { handleToolCallback } from "../../src/agent/tools.js";
import { createBossmodeSdkTools } from "../../src/agent/runtime/tools.js";

const temporaryFiles = new Set<string>();
function inspect(result: ReturnType<typeof terminalToolResult>) {
  const path = result.details.fullOutputPath;
  if (typeof path === "string") temporaryFiles.add(path);
  return JSON.parse(result.content[0].text);
}
beforeEach(() => vi.mocked(handleToolCallback).mockReset());
afterEach(() => { for (const path of temporaryFiles) rmSync(path, { force: true }); temporaryFiles.clear(); });

describe("Pi read output limits", () => {
  it("counts UTF-8 bytes, returns whole lines and provides a lossless continuation", () => {
    const lines = Array.from({ length: 70 }, (_, i) => `${i}: ${"界😀".repeat(200)}`);
    const text = lines.join("\n");
    let offset = 1;
    const collected: string[] = [];
    do {
      const result = readTextOutput(text, "/tmp/source.txt", offset);
      const details = result.details;
      const content = details.truncation?.content ?? result.text;
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(content).not.toContain("�");
      collected.push(content);
      if (details.nextOffset === undefined) break;
      expect(details.nextOffset).toBe(offset + details.lines);
      offset = details.nextOffset;
    } while (true);
    expect(collected.join("\n")).toBe(text);
  });

  it("keeps a line exactly at the byte boundary and guides oversized-line reads without skipping it", () => {
    const text = "x".repeat(DEFAULT_MAX_BYTES);
    expect(readTextOutput(text, "/tmp/source", 1).text).toBe(text);
    const result = readTextOutput(`${text}x\nnext`, "/tmp/it's a file", 1, 1);
    expect(result.details.truncation?.firstLineExceedsLimit).toBe(true);
    expect(result.details.nextOffset).toBeUndefined();
    expect(result.text).toContain("sed -n '1p' '/tmp/it'\\''s a file' | head -c 51200");
    expect(readTextOutput(`${text}x\nnext`, "/tmp/source", 2, 1).text).toBe("next");
  });

  it("reports user-limited continuation, EOF and empty files", () => {
    expect(readTextOutput("a\nb\nc", "file", 2, 1)).toMatchObject({ text: expect.stringContaining("offset=3"), details: { lines: 1, nextOffset: 3 } });
    expect(readTextOutput("", "file", 1)).toMatchObject({ text: "", details: { lines: 1 } });
    expect(() => readTextOutput("a\nb", "file", 3)).toThrow("beyond end of file");
  });
});

describe("terminal output snapshots", () => {
  it("leaves small output and status/error metadata unchanged and removes the old 25000-character cutoff", () => {
    for (const value of [
      { ok: false, error: "Terminal not found" },
      { ok: true, exec: "e1", status: "done", exitCode: 7, lineStart: 2, lineEnd: 2, output: "x".repeat(30_000) },
      { ok: true, status: "done", lines: [], truncated: false },
    ]) {
      const result = terminalToolResult(value);
      expect(inspect(result)).toEqual(value);
      expect(result.details).toEqual({});
    }
    expect(temporaryFiles.size).toBe(0);
  });

  it.each(["界😀".repeat(20_000), '"\\\t\u0001'.repeat(30_000)])("bounds even a single multibyte/JSON-escaped line without breaking JSON or UTF-8 (%#)", output => {
    const result = terminalToolResult({ ok: true, exec: "e2", status: "done", exitCode: 9, lineStart: 1, lineEnd: 1, output });
    const data = inspect(result);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(data).toMatchObject({ ok: true, exec: "e2", status: "done", exitCode: 9, lineStart: 1, lineEnd: 1, outputTruncated: true, fullOutputWorkspace: "original" });
    expect(data.output.length).toBeGreaterThan(0);
    expect(output.endsWith(data.output)).toBe(true);
    expect(data.output).not.toContain("�");
    expect(result.details).toMatchObject({ truncation: { truncated: true, lastLinePartial: true }, fullOutputPath: data.fullOutputPath });
    expect(readFileSync(data.fullOutputPath, "utf8")).toBe(output);
    expect(statSync(data.fullOutputPath).mode & 0o777).toBe(0o600);
  });

  it("keeps tail line numbers and the ring truncation flag while spilling every selected line", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `${100 + i}: line-${i}`);
    const result = terminalToolResult({ ok: true, status: "running", lineStart: 100, lineEnd: 3099, lines, truncated: true });
    const data = inspect(result);
    expect(data).toMatchObject({ status: "running", lineStart: 100, lineEnd: 3099, truncated: true, outputTruncated: true });
    expect(data.lines.length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(data.lines.at(-1)).toBe(lines.at(-1));
    expect(data.lines).toEqual(lines.slice(-data.lines.length));
    expect(readFileSync(data.fullOutputPath, "utf8")).toBe(lines.join("\n"));
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });

  it.each(["terminal_exec", "terminal_read", "terminal_wait"])("applies the limit at the %s SDK boundary, preserving signals and metadata", async name => {
    const output = Array.from({ length: 3000 }, (_, i) => `line-${i}-${"界".repeat(30)}`).join("\n");
    const data = name === "terminal_read"
      ? { ok: true, status: "running", lineStart: 1, lineEnd: 3000, lines: output.split("\n"), truncated: false }
      : { ok: true, exec: "e3", status: "running", outputSoFar: output, note: "Still running" };
    vi.mocked(handleToolCallback).mockResolvedValue(data);
    const tool = createBossmodeSdkTools({ memberId: "mem-test", resolveSourceRef: () => null }).find(tool => tool.name === name)!;
    const signal = new AbortController().signal;
    const result = await tool.execute("call", { terminalId: "s1", exec: "e3" }, signal) as ReturnType<typeof terminalToolResult>;
    const parsed = inspect(result);
    expect(parsed).toMatchObject({ ok: true, status: "running", outputTruncated: true });
    expect(parsed.outputNotice).toContain("workspace=original");
    expect(readFileSync(parsed.fullOutputPath, "utf8")).toBe(output);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(handleToolCallback).toHaveBeenCalledWith(name, "", "mem-test", expect.anything(), { memberId: "mem-test", signal });
    expect(result.content[0].text).not.toContain("Use a more specific query");
  });

  it("passes file/image tool results through rather than applying terminal limits globally", async () => {
    const image = { content: [{ type: "image", data: "a".repeat(90_000), mimeType: "image/png" }], details: { path: "image.png" } };
    vi.mocked(handleToolCallback).mockResolvedValue(image);
    const tool = createBossmodeSdkTools({ memberId: "mem-test", resolveSourceRef: () => null }).find(tool => tool.name === "read")!;
    expect(await tool.execute("read", { path: "image.png" })).toBe(image);
  });
});
