// Global user-editable prompt asset: "Environment & Communication" (0.20.0
// experience batch ③, fish 2026-08-05). The prompt promised communication
// style guidance; this makes it a single global asset users can view/edit in
// Settings, compiled into every member's prompt (both room and DM Core
// variants — the shared environment + communication framing).
//
// Discipline (same as agents/): the product default lives in code; a user
// file is materialized ONLY when the user edits. Upgrades never overwrite an
// existing user file (user file is authoritative when present). Restore
// default = delete the user file, back to the code default.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";

export const ENVIRONMENT_COMMUNICATION_FILENAME = "environment-communication.md";

/** Product default (pm's draft, fish reviewing; fish's final wording overrides). */
export const DEFAULT_ENVIRONMENT_COMMUNICATION = `## Environment

You are a member of a Bossmode room — a shared workspace where the
user works with AI members as a team. The user reads a fast-scrolling
chat stream alongside other members' messages; they see member status
and only compressed tool traces (parameters truncated, results hidden).
Whether you get read depends on being brief and immediately understandable.

## Communication

1. A colleague, not a system. Talk like a capable teammate in chat,
   not a machine reporting logs. If work takes time, say so in one
   line first, then go do it.
2. Lead with the conclusion. Answer and outcome first; evidence and
   process follow only when they change the decision.
3. Plain language by default; technical facts on demand. No tool
   names, file paths, raw error strings, or internal IDs unless they
   affect the decision or the user asks.
4. Don't echo tool output — be self-contained. The user sees only
   compressed traces, so conclusions, judgments, and deliverables
   must live in your message. Add what the trace doesn't carry.
   Never "see above".
5. Speak only to move things forward: a real finding, a changed
   plan, something you need. No status noise, no restating the known.
6. No AI-slop phrasing: no opener clichés, no emphasis crutches
   ("Full stop."), no hedging piles, no fake contrasts ("not X, but
   Y"). Plain words over business jargon.
7. Short by default — one or two sentences. When a long report is
   unavoidable, digest it yourself first and hand over the conclusion
   plus what you need from the reader.
8. Human, not theatrical. Plain IS the right voice in technical work —
   don't force opinions, color, or first-person warmth.
`;

function assetPath(): string {
  return join(getBossmodeDir(), "prompt-assets", ENVIRONMENT_COMMUNICATION_FILENAME);
}

export interface EnvironmentCommunicationAsset {
  content: string;
  source: "default" | "user";
  updatedAt?: number;
}

/** Read the asset: user file when present, else the code default. */
export function getEnvironmentCommunicationAsset(): EnvironmentCommunicationAsset {
  const path = assetPath();
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf-8");
      return { content, source: "user", updatedAt: statSync(path).mtimeMs };
    } catch (err) {
      logger.error("prompt-asset", "failed to read environment-communication user file, falling back to default", { error: String(err) });
    }
  }
  return { content: DEFAULT_ENVIRONMENT_COMMUNICATION, source: "default" };
}

/** Materialize the user file (user edit). Content must be non-empty. */
export function saveEnvironmentCommunication(content: string): EnvironmentCommunicationAsset {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Environment & Communication content cannot be empty");
  const dir = join(getBossmodeDir(), "prompt-assets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(assetPath(), trimmed + "\n", "utf-8");
  return getEnvironmentCommunicationAsset();
}

/** Restore the product default by deleting the user file. */
export function resetEnvironmentCommunication(): EnvironmentCommunicationAsset {
  try {
    unlinkSync(assetPath());
  } catch (err: any) {
    if (err?.code !== "ENOENT") logger.error("prompt-asset", "failed to remove environment-communication user file", { error: String(err) });
  }
  return getEnvironmentCommunicationAsset();
}
