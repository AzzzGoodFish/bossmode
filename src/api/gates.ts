// Gate API — artifact gate (stage approval) endpoints + event emission.
//
// Gates are stage checkpoints: an agent finishes a deliverable (requirement
// doc, architecture design, ...) and requests user approval before the
// pipeline continues. Approval posts a user message that @mentions the
// handoff target, so activation reuses the existing router path untouched.
import { addRoute, sendJson, parseBody } from "./index.js";
import * as gateStore from "../workspace/gate-store.js";
import * as roomStore from "../workspace/room-store.js";
import { postMessage } from "../communication/message-bus.js";
import { logger } from "../foundation/logger.js";
import type { Gate, GateEventMeta } from "../shared/types.js";

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
