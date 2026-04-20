// Summarizer — AI-driven topic-based message summarization
// Spawns a temporary agent process via RuntimeRegistry to generate summaries.

import { logger } from "../foundation/logger.js";
import { getMemberByName, saveMember } from "../workforce/member-store.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { getUnsummarizedMessages, readAllMessages } from "../workspace/message-store.js";
import { postMessage, onMessage } from "../communication/message-bus.js";
import { getRegistry } from "./agent-manager.js";
import { readConfig } from "../shared/config.js";
import type { AgentMemberConfig, RoomMessage } from "../shared/types.js";

// -- State tracking --

const summarizingRooms = new Set<string>();

export function isSummarizing(roomId: string): boolean {
  return summarizingRooms.has(roomId);
}

// -- Summarizer member auto-creation --

export function getOrCreateSummarizerMember(): AgentMemberConfig {
  const existing = getMemberByName("summarizer");
  if (existing) return existing;

  logger.info("summarizer", "auto-creating summarizer member");
  return saveMember({
    name: "summarizer",
    agent: "summarizer",
    model: "sonnet",
    runtime: "claude-cli",
    thinkingLevel: "off",
  });
}

// -- Preview (for confirmation dialog) --

export function getSummarizePreview(roomId: string, keepCount: number = 50): {
  available: boolean;
  toSummarize: number;
  toKeep: number;
  isSummarizing: boolean;
} {
  if (summarizingRooms.has(roomId)) {
    return { available: false, toSummarize: 0, toKeep: 0, isSummarizing: true };
  }

  const unsummarized = getUnsummarizedMessages(roomId, keepCount);
  return {
    available: unsummarized.length > 0,
    toSummarize: unsummarized.length,
    toKeep: keepCount,
    isSummarizing: false,
  };
}

// -- Core summarize flow --

export async function summarizeRoom(roomId: string, keepCount: number = 50): Promise<void> {
  if (summarizingRooms.has(roomId)) {
    throw new Error("Summarization already in progress for this room");
  }

  const messages = getUnsummarizedMessages(roomId, keepCount);
  if (messages.length === 0) {
    throw new Error("No messages to summarize");
  }

  const registry = getRegistry();
  if (!registry) {
    throw new Error("Runtime registry not initialized");
  }

  const member = getOrCreateSummarizerMember();
  const agentDef = loadAgentDefinition("summarizer");
  if (!agentDef) {
    throw new Error("Summarizer agent template not found");
  }

  const runtime = registry.get(member.runtime);
  if (!runtime) {
    throw new Error(`Runtime "${member.runtime}" not available`);
  }

  const startIdx = readAllMessages(roomId).length;

  summarizingRooms.add(roomId);
  postMessage(roomId, "system", `Summarizing ${messages.length} messages...`);

  let handle: any = null;
  try {
    // Format messages with IDs for the summarizer
    const formattedMessages = messages
      .map((m) => `[${m.id}] ${m.sender}: ${m.content}`)
      .join("\n");

    handle = await runtime.createAgent({
      cwd: process.cwd(),
      roomId,
      member,
      agentPrompt: agentDef.systemPrompt,
      envPrompt: "",
      skillPaths: [],
      roomMembers: [],
      callbacks: {
        onChat: async () => {},
        onMention: async () => {},
      },
    });

    const prompt = `Analyze the following messages and create topic-based summaries using the write_summary tool.\n\n${formattedMessages}`;

    await handle.prompt(prompt);
    await handle.waitForIdle();

    const newMessages = readAllMessages(roomId).slice(startIdx);
    const summaryCount = newMessages.filter((m) => m.type === "summary").length;

    if (summaryCount === 0) {
      postMessage(
        roomId,
        "system",
        "Summarization produced no summaries. The model may have failed to call write_summary. Try again or switch to a stronger model (e.g. sonnet).",
      );
      logger.warn("summarizer", "zero summaries produced", { roomId, messageCount: messages.length });
    } else {
      postMessage(roomId, "system", `Summarization complete: ${messages.length} messages condensed into ${summaryCount} summaries.`);
      logger.info("summarizer", "summarization complete", { roomId, messageCount: messages.length, summaryCount });
    }
  } catch (err: any) {
    logger.error("summarizer", "summarization failed", { roomId, error: err.message || String(err) });
    postMessage(roomId, "system", `Summarization failed: ${err.message || String(err)}`);
  } finally {
    if (handle) {
      try { handle.destroy(); } catch {}
    }
    summarizingRooms.delete(roomId);
  }
}

// -- Auto-summary (P1) --

const messageCounters = new Map<string, number>();
let autoSummaryUnsubscribe: (() => void) | null = null;

export function initAutoSummary(): () => void {
  let config;
  try { config = readConfig(); } catch { return () => {}; }
  const summaryConfig = config.summary;
  if (!summaryConfig?.autoEnabled) {
    return () => {};
  }

  const threshold = summaryConfig.threshold || 200;
  const keepCount = summaryConfig.keepCount || 50;

  autoSummaryUnsubscribe = onMessage((roomId, _message) => {
    const count = (messageCounters.get(roomId) || 0) + 1;
    messageCounters.set(roomId, count);

    if (count >= threshold && !summarizingRooms.has(roomId)) {
      messageCounters.set(roomId, 0);
      // Fire and forget — async trigger
      summarizeRoom(roomId, keepCount).catch((err) => {
        logger.error("summarizer", "auto-summary failed", { roomId, error: String(err) });
      });
    }
  });

  logger.info("summarizer", "auto-summary initialized", { threshold, keepCount });

  return () => {
    if (autoSummaryUnsubscribe) {
      autoSummaryUnsubscribe();
      autoSummaryUnsubscribe = null;
    }
    messageCounters.clear();
  };
}
