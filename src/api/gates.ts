// Gate API — artifact gate (stage approval) endpoints + event emission.
//
// Gates are stage checkpoints: an agent finishes a deliverable (requirement
// doc, architecture design, ...) and requests user approval before the
// pipeline continues. Approval posts a user message that @mentions the
// handoff target, so activation reuses the existing router path untouched.
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { addRoute, sendJson, parseBody } from "./index.js";
import * as gateStore from "../workspace/gate-store.js";
import * as roomStore from "../workspace/room-store.js";
import * as knowledgeStore from "../knowledge/store.js";
import { postMessage } from "../communication/message-bus.js";
import { logger } from "../foundation/logger.js";
import { checkPath } from "../shared/path-security.js";
import type { Gate, GateEventMeta, Room } from "../shared/types.js";

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function normalizeArtifactRef(input: string): { originalPath: string; path: string } {
  const originalPath = input.trim();
  return { originalPath, path: originalPath.replace(/^docs\//, "") };
}

function safeRealpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function isValidUrlArtifact(artifact: string): boolean {
  if (!URL_SCHEME_RE.test(artifact)) return false;
  try {
    // URL artifacts are references only; do not fetch during gate submission.
    new URL(artifact);
    return true;
  } catch {
    throw new Error(`Invalid artifact URL: ${artifact}`);
  }
}

function validateLocalArtifact(room: Room, artifact: string): void {
  const normalized = normalizeArtifactRef(artifact);
  const allowedPrefixes = [
    safeRealpath(knowledgeStore._internal.docsRoot()),
    safeRealpath(resolve(room.cwd)),
  ].filter((p): p is string => !!p);

  if (normalized.path.toLowerCase().endsWith(".md") && knowledgeStore.getEntry(normalized.path)) return;

  const candidates: string[] = [knowledgeStore._internal.absDocPath(normalized.path)];
  if (!normalized.originalPath.startsWith("/")) {
    candidates.push(resolve(room.cwd, normalized.originalPath));
    if (normalized.path !== normalized.originalPath) candidates.push(resolve(room.cwd, normalized.path));
  } else {
    candidates.push(normalized.originalPath);
  }

  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    const check = checkPath(candidate, { allowedPrefixes });
    if (!check.ok) {
      throw new Error(`Artifact path is not accessible: ${normalized.originalPath}. ${check.error}`);
    }
    return;
  }

  throw new Error(`Artifact not found: ${normalized.originalPath}. Fix the artifact path and submit the approval again.`);
}

function validateGateArtifacts(room: Room, artifacts?: string[]): void {
  for (const raw of artifacts || []) {
    const artifact = String(raw).trim();
    if (!artifact) continue;
    if (isValidUrlArtifact(artifact)) continue;
    validateLocalArtifact(room, artifact);
  }
}

/** Emit a structured gate_event system message into the room stream. */
export function emitGateEvent(
  roomId: string,
  action: GateEventMeta["action"],
  gate: Gate,
): void {
  const meta: GateEventMeta = {
    action,
    gateId: gate.id,
    gateTitle: gate.title,
    requestedBy: gate.requestedBy,
    handoffTo: gate.handoffTo,
    summary: action === "requested" ? gate.summary : undefined,
    artifacts: action === "requested" ? gate.artifacts : undefined,
    decisionNote: gate.decisionNote,
  };

  const content =
    action === "requested"
      ? `[Gate] ${gate.requestedBy} 提交了阶段交付待验收: **${gate.title}**`
      : action === "approved"
        ? `[Gate] 已批准: **${gate.title}**`
        : `[Gate] 已打回: **${gate.title}**`;

  postMessage(roomId, "system", content, [], {
    type: "gate_event",
    gate_event_meta: meta,
  });
  logger.info("gate-api", "gate event", { roomId, action, gateId: gate.id });
}

/**
 * Create a gate (agent-side, via request_approval tool callback).
 * Shared by api route and engine tools.
 */
export function createGateAndAnnounce(
  roomId: string,
  data: { title: string; summary: string; artifacts?: string[]; requestedBy: string; handoffTo?: string },
): Gate {
  const room = roomStore.getRoom(roomId);
  if (!room) throw new Error("Room not found");
  // Validate handoff target is a room member (prevents dead-end pipelines).
  if (data.handoffTo && !room.members.includes(data.handoffTo)) {
    throw new Error(
      `handoff_to "${data.handoffTo}" is not a member of this room. Members: ${room.members.join(", ")}`,
    );
  }
  validateGateArtifacts(room, data.artifacts);
  const gate = gateStore.createGate(roomId, data);
  emitGateEvent(roomId, "requested", gate);
  return gate;
}

// -- Routes --

addRoute("GET", "/api/rooms/:id/gates", async (_req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  sendJson(res, 200, gateStore.listGates(params.id));
});

addRoute("POST", "/api/rooms/:id/gates", async (req, res, params) => {
  const body = (await parseBody(req)) as any;
  if (!body?.title || !body?.summary) {
    sendJson(res, 400, { error: "title and summary are required" });
    return;
  }
  try {
    const gate = createGateAndAnnounce(params.id, {
      title: String(body.title),
      summary: String(body.summary),
      artifacts: Array.isArray(body.artifacts) ? body.artifacts.map(String) : undefined,
      requestedBy: String(body.requestedBy || "user"),
      handoffTo: body.handoffTo ? String(body.handoffTo) : undefined,
    });
    sendJson(res, 200, gate);
  } catch (err: any) {
    sendJson(res, err?.message === "Room not found" ? 404 : 400, { error: String(err?.message || err) });
  }
});

addRoute("POST", "/api/rooms/:id/gates/:gateId/decision", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) { sendJson(res, 404, { error: "Room not found" }); return; }
  const body = (await parseBody(req)) as any;
  const action = body?.action;
  if (action !== "approve" && action !== "reject") {
    sendJson(res, 400, { error: 'action must be "approve" or "reject"' });
    return;
  }
  const note = body?.note ? String(body.note) : undefined;

  let gate: Gate | null;
  try {
    gate = gateStore.decideGate(params.id, params.gateId, action, note);
  } catch (err: any) {
    sendJson(res, 409, { error: String(err?.message || err) });
    return;
  }
  if (!gate) { sendJson(res, 404, { error: "Gate not found" }); return; }

  // 1. Structured event card (audit trail in the timeline).
  emitGateEvent(params.id, action === "approve" ? "approved" : "rejected", gate);

  // 2. Drive the pipeline through the existing mention-activation path:
  //    approve → activate handoff target; reject → reactivate requester with feedback.
  if (action === "approve") {
    if (gate.handoffTo) {
      const noteText = note ? `\n\n备注: ${note}` : "";
      postMessage(
        params.id,
        "user",
        `@${gate.handoffTo} 「${gate.title}」已验收通过,交接给你继续。请基于交付物开展下一阶段工作:${gate.artifacts.length ? "\n" + gate.artifacts.map((a) => `- ${a}`).join("\n") : "(见上方交付说明)"}${noteText}`,
        [gate.handoffTo],
      );
    }
  } else {
    // Reject always goes back to the requester.
    if (room.members.includes(gate.requestedBy)) {
      postMessage(
        params.id,
        "user",
        `@${gate.requestedBy} 「${gate.title}」被打回,请根据意见修改后重新提交验收。${note ? `\n\n意见: ${note}` : ""}`,
        [gate.requestedBy],
      );
    }
  }

  sendJson(res, 200, gate);
});
