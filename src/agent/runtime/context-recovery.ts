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

/** The complete work log remains on disk; only its active context is replaced. */
export function recoveryPrompt(sessionFile: string, sourceRef: string | null, boundaryId: string): string {
  const chat = sourceRef ? ` for ${JSON.stringify(sourceRef)}` : " for your current task";
  return "Your context window reached its limit; no summary was generated. " +
    `Review your earlier work in ${JSON.stringify(sessionFile)} before entry ${JSON.stringify(boundaryId)} using read with workspace \"original\" and bounded line ranges, ` +
    `and the relevant chat history${chat} using chat_read or chat_search, ` +
    "verify what has already completed, and continue the unfinished task without repeating completed actions.";
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
