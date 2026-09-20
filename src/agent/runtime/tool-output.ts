import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { writeTemporaryText } from "../../files/io.js";

// Keep the SDK dependency at the runtime boundary. These are Pi's limits, not
// file-size/scan limits or a global tool-result policy.
export const TOOL_OUTPUT_LIMIT = `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first)`;

/** Pi read semantics: select a window, keep complete head lines, then explain continuation. */
export function readTextOutput(text: string, path: string, offset: number, limit?: number) {
  const lines = text.split("\n");
  const start = offset - 1;
  if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
  const selected = lines.slice(start, limit === undefined ? undefined : start + limit);
  const truncation = truncateHead(selected.join("\n"));
  let output = truncation.content;
  let nextOffset: number | undefined;
  if (truncation.firstLineExceedsLimit) {
    const quotedPath = `'${path.replaceAll("'", "'\\''")}'`;
    output = `[Line ${offset} is ${formatSize(Buffer.byteLength(lines[start], "utf8"))}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use terminal_exec in this file's workspace: sed -n '${offset}p' ${quotedPath} | head -c ${DEFAULT_MAX_BYTES}]`;
  } else if (truncation.truncated) {
    nextOffset = offset + truncation.outputLines;
    output += `\n\n[Showing lines ${offset}-${nextOffset - 1} of ${lines.length}${truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : ""}. Use offset=${nextOffset} to continue.]`;
  } else if (start + selected.length < lines.length) {
    nextOffset = offset + selected.length;
    output += `\n\n[${lines.length - start - selected.length} more lines in file. Use offset=${nextOffset} to continue.]`;
  }
  return {
    text: output,
    details: {
      lines: truncation.truncated ? truncation.outputLines : selected.length,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      ...(truncation.truncated ? { truncation } : {}),
    },
  };
}

/**
 * Tool-layer snapshots, like Pi's truncated custom-tool example. Persistent
 * terminal execution/storage is untouched: truncation never stops a command.
 * Full snapshots survive terminal close and are readable on original even
 * when the command ran over SSH. No private SDK accumulator imports.
 */
export function terminalToolResult(value: unknown) {
  const data = value as Record<string, unknown>;
  const field = typeof data?.output === "string" ? "output"
    : typeof data?.outputSoFar === "string" ? "outputSoFar"
    : Array.isArray(data?.lines) ? "lines" : undefined;
  const result = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
  if (!field) return result(JSON.stringify(value, null, 2));
  const output = field === "lines" ? (data.lines as string[]).join("\n") : data[field] as string;
  let truncation = truncateTail(output);
  const preview = () => ({ ...data, [field]: field === "lines"
    ? (truncation.content ? truncation.content.split("\n") : []) : truncation.content });
  const initial = JSON.stringify(preview(), null, 2);
  if (!truncation.truncated && Buffer.byteLength(initial, "utf8") <= DEFAULT_MAX_BYTES) return result(initial);

  // Save before returning any truncated result; write failures must surface.
  const fullOutputPath = writeTemporaryText(output, "bossmode-terminal", ".log");
  const serialize = () => JSON.stringify({
    ...preview(),
    outputTruncated: true,
    fullOutputPath,
    fullOutputWorkspace: "original",
    outputNotice: `Showing the tail (${truncation.outputLines} of ${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}${truncation.lastLinePartial ? "; first shown line is partial" : ""}). Full output snapshot: use read with workspace=original and the fullOutputPath above.`,
  }, null, 2);
  let serialized = serialize();
  // Preserve valid JSON and status/exit/line metadata, while accounting for
  // JSON escaping and envelope bytes rather than cutting serialized JSON.
  while (Buffer.byteLength(serialized, "utf8") > DEFAULT_MAX_BYTES && truncation.outputBytes > 0) {
    const maxBytes = Math.min(truncation.outputBytes - 1, Math.floor(truncation.outputBytes * DEFAULT_MAX_BYTES / Buffer.byteLength(serialized, "utf8")));
    truncation = truncateTail(output, { maxBytes });
    serialized = serialize();
  }
  return result(serialized, { truncation, fullOutputPath, fullOutputWorkspace: "original" });
}
