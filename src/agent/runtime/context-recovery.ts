import { accessSync, constants } from "node:fs";
import {
  type AgentSession,
  type CompactionEntry,
  type ExtensionContext,
  type ExtensionFactory,
  type ResourceLoader,
  type SessionBeforeCompactEvent,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_NAME = "bossmode-context-recovery";
const BOUNDARY_KIND = "bossmode-context-recovery-v1";

type ContextMessages = Parameters<AgentSession["agent"]["convertToLlm"]>[0];
type RecoveryHookResult = { cancel?: boolean; compaction?: Awaited<ReturnType<AgentSession["compact"]>> };

/** The complete work log remains on disk; only its active context is replaced.
 * Wrapped in a platform_directive element (spec unified-user-prompt v1.6) so
 * recovery is structurally distinguishable from real chat traffic. The
 * chat_id attribute is derived locally — runtime must not depend on the chat
 * layer for it (mm refs keep their canonical form; tools still resolve it). */
function recoveryChatAttr(sourceRef: string | null): string {
  if (!sourceRef) return "";
  if (sourceRef.startsWith("room:")) return ` chat_id="${sourceRef.slice(5)}"`;
  const dm = /^dm:mem_([A-Za-z0-9-]+)$/.exec(sourceRef);
  if (dm) return ` chat_id="dm_${dm[1]}"`;
  return ` chat_id="${sourceRef}"`;
}
export function recoveryPrompt(sessionFile: string, sourceRef: string | null, boundaryId: string): string {
  const chat = sourceRef ? ` for ${JSON.stringify(sourceRef)}` : " for your current task";
  return `<platform_directive kind="context_recovery" boundary="${boundaryId}"${recoveryChatAttr(sourceRef)}>\n` +
    "Internal context recovery: your active context was reset; no summary was generated. " +
    "Recover silently. Do not send a greeting, a recovery announcement, a check-in, or a request to restate an already recorded task. " +
    `First inspect a small relevant window of chat history${chat} using chat_read or chat_search. ` +
    "If execution history is needed, read bossmode-guide at the guide path in Assets, then its references/sessions.md, using workspace \"original\". " +
    "Use the guide's scripts/session-search.mjs through a terminal in workspace \"original\", with your absolute member directory from Assets as --member-dir. " +
    `Consult only entries before ${JSON.stringify(boundaryId)} in the work log ${JSON.stringify(sessionFile)}. ` +
    "Start with list/search metadata and short summaries; expand only task-relevant entries with a small --before/--after window. " +
    "Pass --max-bytes 8192 on every command (8 KiB per call). If output contains nextCursor, use --cursor with the same action and filters only when more information is necessary. " +
    "Never automatically drain pages or reconstruct oversized tool results. Never read or print the entire session JSONL, and never dump raw tool results. Line ranges alone are not safe: one JSONL line can be huge. " +
    "Stop recovering once you know the task, completed work, constraints and next action. Verify completion against current files or task state, " +
    "then continue the unfinished task without repeating completed actions. Speak in chat only for a substantive result, blocker, or necessary clarification." +
    `\n</platform_directive>`;
}

export function isRecoveryBoundary(entry: CompactionEntry | undefined): boolean {
  const details = entry?.details as { kind?: unknown } | undefined;
  return details?.kind === BOUNDARY_KIND;
}

/**
 * Uses the SDK's append-only context boundary, not its summary generator.
 * The guard runs last and always cancels on failure: ExtensionRunner normally
 * swallows handler errors, which would otherwise fall back to model compaction.
 */
export class ContextRecovery {
  private failure: Error | undefined;
  readonly extension: { name: string; factory: ExtensionFactory };

  constructor(
    private readonly manager: SessionManager,
    private readonly sourceRef: () => string | null,
  ) {
    this.extension = {
      name: EXTENSION_NAME,
      factory: (api) => {
        api.on("session_before_compact", (event, ctx) => this.beforeCompact(event, ctx));
      },
    };
  }

  assertInstalled(loader: ResourceLoader): void {
    const last = loader.getExtensions().extensions.at(-1);
    if (last?.path !== `<inline:${EXTENSION_NAME}>` || !last.handlers.get("session_before_compact")?.length) {
      throw new Error("Context recovery policy must be loaded last before starting the runtime");
    }
  }

  install(session: AgentSession): void {
    const convert = session.agent.convertToLlm.bind(session.agent);
    // This public conversion boundary runs after extension context transforms.
    // Unlike an extension handler, a conversion failure is not swallowed by the
    // runner, so neither a recovery failure nor a misleading summary can escape.
    session.agent.convertToLlm = (messages) => {
      this.throwIfFailed();
      return convert(this.projectContext(messages));
    };
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  currentBoundary(): CompactionEntry | undefined {
    const entry = this.manager.getBranch().reverse().find((item) => item.type === "compaction");
    return entry?.type === "compaction" ? entry : undefined;
  }

  private beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): RecoveryHookResult | undefined {
    if (event.reason === "manual") return undefined;
    if (event.signal.aborted) return { cancel: true };
    try {
      const file = this.manager.getSessionFile();
      if (!file) throw new Error("The session has no persistent work log");
      accessSync(file, constants.R_OK);
      // A real non-context entry allows the SDK to retain zero historical
      // messages without an invalid/synthetic firstKeptEntryId or a new branch.
      const markerId = this.manager.appendCustomEntry(BOUNDARY_KIND, {
        reason: event.reason,
        sessionId: this.manager.getSessionId(),
      });
      return {
        compaction: {
          summary: recoveryPrompt(file, this.sourceRef(), markerId),
          firstKeptEntryId: markerId,
          tokensBefore: event.preparation.tokensBefore,
          details: { kind: BOUNDARY_KIND, sessionFile: file, markerId },
        },
      };
    } catch (error) {
      this.failure = new Error(`Context recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      // Do not throw from an extension: the SDK would catch it and summarize.
      try { ctx.abort(); }
      catch (abortError) {
        this.failure = new AggregateError([this.failure, abortError], "Context recovery failed and cancellation failed");
      }
      return { cancel: true };
    }
  }

  projectContext(messages: ContextMessages): ContextMessages {
    const boundary = this.currentBoundary();
    if (!isRecoveryBoundary(boundary)) return messages;
    return messages.map((message) => {
      if (message.role !== "compactionSummary" || message.summary !== boundary!.summary ||
          message.timestamp !== Date.parse(boundary!.timestamp)) return message;
      return {
        role: "custom" as const,
        customType: BOUNDARY_KIND,
        content: boundary!.summary,
        display: false,
        timestamp: message.timestamp,
      };
    });
  }
}
