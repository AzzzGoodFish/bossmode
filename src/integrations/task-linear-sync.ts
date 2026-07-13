import { broadcastToRoom } from "../communication/ws.js";
import { logger } from "../foundation/logger.js";
import * as taskStore from "../workspace/task-store.js";
import { updateRoomLinearIntegration } from "../workspace/room-store.js";
import type { Task, TaskEventMeta } from "../shared/types.js";
import { getLinearApiKey, getRoomLinearIntegration } from "./linear-settings.js";
import { LinearClient, linearPriority, resolveLinearStateId } from "./linear-client.js";

function sanitize(err: unknown): string {
  return String((err as any)?.message || err || "Unknown Linear sync error").replace(/lin_api_[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

function issueDescription(task: Task): string | undefined {
  const parts = [task.description || "", ...(task.references?.length ? ["\nReferences:\n" + task.references.map((r) => `- ${r}`).join("\n")] : [])];
  return parts.join("\n").trim() || undefined;
}

export async function syncTaskEventToLinear(args: {
  roomId: string;
  action: TaskEventMeta["action"];
  task: Task;
  actor: string;
  commentId?: string;
}): Promise<void> {
  if (args.action === "deleted") return;
  const apiKey = getLinearApiKey();
  const roomConfig = getRoomLinearIntegration(args.roomId);
  if (!apiKey || !roomConfig || roomConfig.enabled === false) return;

  try {
    const client = new LinearClient(apiKey);
    const team = await client.getTeamDetails(roomConfig.teamId);
    if (!team) throw new Error(`Linear team not found: ${roomConfig.teamName}`);
    const stateId = resolveLinearStateId(args.task.status, team.states || []);
    let task = taskStore.getTask(args.roomId, args.task.id) || args.task;
    let issue = task.linearIssueId ? { id: task.linearIssueId, identifier: task.linearIssueIdentifier || "Linear", url: task.linearIssueUrl || "" } : null;

    if (!issue) {
      issue = await client.createIssue({
        teamId: roomConfig.teamId,
        projectId: roomConfig.projectId,
        title: task.title,
        description: issueDescription(task),
        priority: linearPriority(task.priority),
        ...(stateId ? { stateId } : {}),
      });
      task = taskStore.updateTaskLinearMetadata(args.roomId, task.id, {
        linearIssueId: issue.id,
        linearIssueIdentifier: issue.identifier,
        linearIssueUrl: issue.url,
        linearSyncedAt: Date.now(),
        linearSyncError: undefined,
      }) || task;
    }

    if (args.action === "updated" || args.action === "status_changed") {
      issue = await client.updateIssue(issue.id, {
        title: task.title,
        description: issueDescription(task),
        priority: linearPriority(task.priority),
        ...(stateId ? { stateId } : {}),
      });
    }

    if (args.action === "commented") {
      const comment = task.comments?.find((c) => c.id === args.commentId) || task.comments?.[task.comments.length - 1];
      if (comment) await client.createComment(issue.id, `**${args.actor} via Bossmode**\n\n${comment.content}`);
    }

    const syncedAt = Date.now();
    const updated = taskStore.updateTaskLinearMetadata(args.roomId, task.id, {
      linearIssueId: issue.id,
      linearIssueIdentifier: issue.identifier,
      linearIssueUrl: issue.url,
      linearSyncedAt: syncedAt,
      linearSyncError: undefined,
    });
    updateRoomLinearIntegration(args.roomId, { ...roomConfig, lastSyncAt: syncedAt, lastSyncError: undefined, syncCount: (roomConfig.syncCount || 0) + 1 });
    if (updated) broadcastToRoom(args.roomId, { type: "task:updated", roomId: args.roomId, task: updated });
    logger.info("linear", "task synced", { roomId: args.roomId, taskId: task.id, issue: issue.identifier });
  } catch (err) {
    const error = sanitize(err);
    taskStore.updateTaskLinearMetadata(args.roomId, args.task.id, { linearSyncError: error });
    updateRoomLinearIntegration(args.roomId, { ...roomConfig, lastSyncError: error });
    logger.warn("linear", "task sync failed", { roomId: args.roomId, taskId: args.task.id, error });
  }
}
