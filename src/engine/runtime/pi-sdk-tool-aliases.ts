import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function pathFrom(params: Record<string, any>): string {
  const value = params.file_path ?? params.path;
  if (typeof value !== "string" || value.length === 0) throw new Error("Missing required file path: provide file_path or path.");
  return value;
}

function editPairFrom(params: Record<string, any>): { oldText: string; newText: string } {
  const oldText = params.old_string ?? params.oldText;
  const newText = params.new_string ?? params.newText;
  if (typeof oldText !== "string" || typeof newText !== "string") {
    throw new Error("Missing required edit strings: provide old_string and new_string.");
  }
  return { oldText, newText };
}

function multiEditPairsFrom(params: Record<string, any>): Array<{ oldText: string; newText: string }> {
  const edits = params.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("MultiEdit requires a non-empty edits array.");
  return edits.map((edit, index) => {
    if (!edit || typeof edit !== "object") throw new Error(`MultiEdit edit ${index + 1} must be an object.`);
    return editPairFrom(edit as Record<string, any>);
  });
}

export function createClaudeCodeToolAliases(cwd: string): ToolDefinition[] {
  const bash = createBashToolDefinition(cwd);
  const read = createReadToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);

  return [
    defineTool({
      name: "Bash",
      label: "Bash",
      description: "Compatibility alias for bash. Prefer bash when choosing tools.",
      parameters: Type.Object({
        command: Type.String({ description: "Bash command to execute" }),
        description: Type.Optional(Type.String({ description: "Optional command description" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
      }),
      execute: async (id, params, signal, onUpdate, ctx) => {
        const p = params as any;
        return (bash.execute as any)(id, { command: p.command, timeout: p.timeout }, signal, onUpdate, ctx);
      },
    }),
    defineTool({
      name: "Read",
      label: "Read",
      description: "Compatibility alias for read. Prefer read when choosing tools.",
      parameters: Type.Object({
        file_path: Type.Optional(Type.String({ description: "File path to read" })),
        path: Type.Optional(Type.String({ description: "File path to read" })),
        offset: Type.Optional(Type.Number({ description: "Starting line offset" })),
        limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
      }),
      execute: async (id, params, signal, onUpdate, ctx) => {
        const p = params as Record<string, any>;
        return (read.execute as any)(id, { path: pathFrom(p), offset: p.offset, limit: p.limit }, signal, onUpdate, ctx);
      },
    }),
    defineTool({
      name: "Write",
      label: "Write",
      description: "Compatibility alias for write. Prefer write when choosing tools.",
      parameters: Type.Object({
        file_path: Type.Optional(Type.String({ description: "File path to write" })),
        path: Type.Optional(Type.String({ description: "File path to write" })),
        content: Type.String({ description: "File content" }),
      }),
      execute: async (id, params, signal, onUpdate, ctx) => {
        const p = params as Record<string, any>;
        return (write.execute as any)(id, { path: pathFrom(p), content: p.content }, signal, onUpdate, ctx);
      },
    }),
    defineTool({
      name: "Edit",
      label: "Edit",
      description: "Compatibility alias for edit. Prefer edit when choosing tools.",
      parameters: Type.Object({
        file_path: Type.Optional(Type.String({ description: "File path to edit" })),
        path: Type.Optional(Type.String({ description: "File path to edit" })),
        old_string: Type.Optional(Type.String({ description: "Text to replace" })),
        new_string: Type.Optional(Type.String({ description: "Replacement text" })),
        oldText: Type.Optional(Type.String({ description: "Text to replace" })),
        newText: Type.Optional(Type.String({ description: "Replacement text" })),
        replace_all: Type.Optional(Type.Boolean({ description: "Not supported by this compatibility alias" })),
      }),
      execute: async (id, params, signal, onUpdate, ctx) => {
        const p = params as Record<string, any>;
        if (p.replace_all === true) throw new Error("Edit replace_all is not supported. Use exact unique old_string or MultiEdit with explicit replacements.");
        return (edit.execute as any)(id, { path: pathFrom(p), edits: [editPairFrom(p)] }, signal, onUpdate, ctx);
      },
    }),
    defineTool({
      name: "MultiEdit",
      label: "MultiEdit",
      description: "Compatibility alias for edit with multiple replacements. Prefer edit when choosing tools.",
      parameters: Type.Object({
        file_path: Type.Optional(Type.String({ description: "File path to edit" })),
        path: Type.Optional(Type.String({ description: "File path to edit" })),
        edits: Type.Array(Type.Object({
          old_string: Type.Optional(Type.String({ description: "Text to replace" })),
          new_string: Type.Optional(Type.String({ description: "Replacement text" })),
          oldText: Type.Optional(Type.String({ description: "Text to replace" })),
          newText: Type.Optional(Type.String({ description: "Replacement text" })),
        }), { description: "One or more exact replacements" }),
      }),
      execute: async (id, params, signal, onUpdate, ctx) => {
        const p = params as Record<string, any>;
        return (edit.execute as any)(id, { path: pathFrom(p), edits: multiEditPairsFrom(p) }, signal, onUpdate, ctx);
      },
    }),
  ];
}

export const CLAUDE_CODE_TOOL_ALIAS_NAMES = ["Bash", "Read", "Edit", "Write", "MultiEdit"] as const;
