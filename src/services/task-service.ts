import {getDatabase} from "../storage/database.js";
import {enqueueScopeNotification} from "../storage/notification-repository.js";
import {postMessage} from "../communication/message-bus.js";
import * as taskStore from "../workspace/task-store.js";
import * as roomStore from "../workspace/room-store.js";
import {logger} from "../foundation/logger.js";
import type {RoomMemberRecord,Task,TaskEventMeta,TaskStatus,TaskPriority} from "../shared/types.js";

export class TaskInputError extends Error {}
export class TaskScopeNotFoundError extends Error {}
export interface TaskActor { name:string; memberId?:string }
function actorName(roomId:string,actor:TaskActor):string {
  if(!roomStore.getRoom(roomId))throw new TaskScopeNotFoundError("Room not found");
  if(actor.memberId){
    const member=roomStore.resolveRoomMemberRef(roomId,actor.memberId);
    if(!member || member.id!==actor.memberId)throw new TaskInputError("Actor is not a room member");
    return member.name;
  }
  const name=actor.name.trim();if(!name)throw new TaskInputError("author is required");return name;
}
function request(raw:unknown):Record<string,any> {
  if(!raw || typeof raw!=="object" || Array.isArray(raw))throw new TaskInputError("Task input must be an object");
  return raw as Record<string,any>;
}
function status(value:unknown):TaskStatus {
  if(typeof value!=="string" || !["todo","in-progress","review","done"].includes(value))throw new TaskInputError("Invalid task status");
  return value as TaskStatus;
}
function priority(value:unknown):TaskPriority {
  if(typeof value!=="string" || !["P0","P1","P2"].includes(value))throw new TaskInputError("Invalid task priority");
  return value as TaskPriority;
}

/** Trim a body of text to a one-line-ish chat snippet. */
function toSnippet(text: string | undefined, max = 280): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

function resolveTaskAssignee(roomId: string, value: unknown): { name: string; memberId: string } | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const member = roomStore.resolveRoomMemberRef(roomId, raw);
  if (!member) throw new TaskInputError(`Assignee is not a room member: ${raw}`);
  return { name: member.name, memberId: member.id };
}

function resolveTaskSubscribers(roomId: string, values: unknown): { names: string[]; memberIds: string[] } | undefined {
  if (!Array.isArray(values)) return undefined;
  const members: RoomMemberRecord[] = [];
  let includesUser = false;
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    if (raw === "user") {
      includesUser = true;
      continue;
    }
    const member = roomStore.resolveRoomMemberRef(roomId, raw);
    if (!member) throw new TaskInputError(`Subscriber is not a room member: ${raw}`);
    if (!members.some((entry) => entry.id === member.id)) members.push(member);
  }
  return { names: [...(includesUser ? ["user"] : []), ...members.map((member) => member.name)], memberIds: members.map((member) => member.id) };
}

/** Emit a structured task_event system message + ws broadcast. */
function emitTaskEvent(
  roomId: string,
  action: TaskEventMeta["action"],
  task: Task,
  actor: string,
  opts: { commentId?: string } = {},
): void {
  // Inline snippet: surface the actual content into chat so the timeline
  // stays informative without forcing a jump to the task page.
  let snippet: string | undefined;
  if (action === "created") {
    snippet = toSnippet(task.description);
  } else if (action === "commented" && opts.commentId) {
    const comment = task.comments?.find((c) => c.id === opts.commentId);
    snippet = toSnippet(comment?.content);
  }

  const meta: TaskEventMeta = {
    action,
    taskId: task.id,
    taskTitle: task.title,
    newStatus: action === "status_changed" ? task.status : undefined,
    commentId: opts.commentId,
    actor,
    snippet,
  };

  // Human-readable system message
  const verb =
    action === "created" ? "created task" :
    action === "deleted" ? "deleted task" :
    action === "status_changed" ? `moved task to ${task.status}` :
    action === "commented" ? "commented on task" :
    "updated task";
  const content = `[Task] ${actor} ${verb}: **${task.title}**`;

  // Task assignment is metadata only. Activation happens exclusively through chat @mentions.
  const message = postMessage(roomId, "system", content, [], {
    type: "task_event",
    task_event_meta: meta,
  });

  // Also broadcast dedicated ws event for real-time UI updates (no message stream)
  const wsType = action === "deleted" ? "task:deleted" :
    action === "created" ? "task:created" : "task:updated";

  enqueueScopeNotification(roomId,`task-ui:${message.id}`,wsType === "task:deleted"
    ? {type:"task:deleted",roomId,taskId:task.id}
    : {type:wsType as "task:created"|"task:updated",roomId,task});
  getDatabase().afterCommit(()=>logger.info("task-service","task event",{roomId,action,taskId:task.id,actor}));
}

/** Classification, mutation, timeline event and UI outbox commit together. */
export function createTask(roomId:string,raw:unknown,actor:TaskActor):Task {
  return getDatabase().transaction(()=>{
    const creator=actorName(roomId,actor);const input=request(raw);
    const title=input.title?String(input.title).trim():"";
    if(!title)throw new TaskInputError("title is required");
    const assignee=resolveTaskAssignee(roomId,input.assignee);
    const subscribers=resolveTaskSubscribers(roomId,input.subscribers);
    const task=taskStore.createTask(roomId,{
      title,createdBy:creator,status:status(input.status??"todo"),priority:priority(input.priority??"P1"),
      assignee:assignee?.name,assigneeMemberId:assignee?.memberId,
      description:input.description?String(input.description):undefined,
      references:Array.isArray(input.references)?input.references.map(String):undefined,
      subscribers:subscribers?.names,subscriberMemberIds:subscribers?.memberIds,
    });
    emitTaskEvent(roomId,"created",task,creator);return task;
  });
}
export function updateTask(roomId:string,taskId:string,raw:unknown,actor:TaskActor):Task|null {
  return getDatabase().transaction(()=>{
    const author=actorName(roomId,actor);const input=request(raw);
    const before=taskStore.getTask(roomId,taskId);if(!before)return null;
    const patch:Parameters<typeof taskStore.updateTask>[2]={};
    if(input.title!==undefined)patch.title=String(input.title);
    if(input.status!==undefined)patch.status=status(input.status);
    if(input.priority!==undefined)patch.priority=priority(input.priority);
    if(input.assignee!==undefined){const assignee=resolveTaskAssignee(roomId,input.assignee);patch.assignee=assignee?.name??null;patch.assigneeMemberId=assignee?.memberId??null;}
    if(input.description!==undefined)patch.description=String(input.description);
    if(input.references!==undefined)patch.references=Array.isArray(input.references)?input.references.map(String):[];
    if(input.subscribers!==undefined){const subscribers=resolveTaskSubscribers(roomId,input.subscribers)??{names:[],memberIds:[]};patch.subscribers=subscribers.names;patch.subscriberMemberIds=subscribers.memberIds;}
    const task=taskStore.updateTask(roomId,taskId,patch)!;
    emitTaskEvent(roomId,before.status!==task.status?"status_changed":"updated",task,author);return task;
  });
}
export function commentTask(roomId:string,taskId:string,content:string,actor:TaskActor):ReturnType<typeof taskStore.addTaskComment> {
  return getDatabase().transaction(()=>{
    const author=actorName(roomId,actor);if(!content.trim())throw new TaskInputError("comment is required");
    const result=taskStore.addTaskComment(roomId,taskId,{author,content});
    if(result)emitTaskEvent(roomId,"commented",result.task,author,{commentId:result.comment.id});return result;
  });
}
export function deleteTask(roomId:string,taskId:string,actor:TaskActor):boolean {
  return getDatabase().transaction(()=>{
    const author=actorName(roomId,actor);const task=taskStore.getTask(roomId,taskId);if(!task)return false;
    if(!taskStore.deleteTask(roomId,taskId))return false;
    emitTaskEvent(roomId,"deleted",task,author);return true;
  });
}
