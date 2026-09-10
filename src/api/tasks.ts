// Task HTTP adapters; business mutation/identity/outbox ownership is in task-service.
import type { ServerResponse } from "node:http";
import { addRoute,sendJson,parseBody } from "./index.js";
import * as taskStore from "../workspace/task-store.js";
import * as roomStore from "../workspace/room-store.js";
import { queryRoomTasks } from "../workspace/db/tasks-index.js";
import * as tasks from "../services/task-service.js";
function failure(res:ServerResponse,error:unknown):void {
  const status=error instanceof tasks.TaskScopeNotFoundError?404:error instanceof tasks.TaskInputError?400:500;
  sendJson(res,status,{error:String((error as Error)?.message||error)});
}

// -- Global --

addRoute("GET", "/api/tasks", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const opts: Parameters<typeof taskStore.listAllTasks>[0] = {
    status: (url.searchParams.get("status") as any) || undefined,
    query: url.searchParams.get("query") || undefined,
  };
  sendJson(res, 200, taskStore.listAllTasks(opts));
});

// -- Per-room --

addRoute("GET", "/api/rooms/:id/tasks", async (req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const url = new URL(req.url || "", "http://localhost");
  const status = (url.searchParams.get("status") as any) || undefined;
  const assignee = url.searchParams.get("assignee") || undefined;
  const q = url.searchParams.get("q") || undefined;
  const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined;
  const offset = url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : undefined;
  const wantsQuery = Boolean(status || assignee || q || limit !== undefined || offset !== undefined);

  if (wantsQuery) {
    sendJson(res,200,queryRoomTasks(params.id,{status,assignee,q,limit,offset}));
    return;
  }
  sendJson(res, 200, taskStore.listTaskSummaries(params.id));
});

addRoute("GET", "/api/rooms/:id/tasks/:taskId", async (_req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const task = taskStore.getTask(params.id, params.taskId);
  if (!task) { sendJson(res, 404, { error: "Task not found" }); return; }
  sendJson(res, 200, task);
});

addRoute("POST","/api/rooms/:id/tasks",async(req,res,params)=>{
  try {
    const body=await parseBody(req) as any;
    sendJson(res,200,tasks.createTask(params.id,body,{name:String(body?.createdBy||"user")}));
  }catch(error){failure(res,error);}
});
addRoute("PATCH","/api/rooms/:id/tasks/:taskId",async(req,res,params)=>{
  try {
    const body=await parseBody(req) as any;
    const task=tasks.updateTask(params.id,params.taskId,body,{name:String(body?.updatedBy||"user")});
    if(!task){sendJson(res,404,{error:"Task not found"});return;}
    sendJson(res,200,task);
  }catch(error){failure(res,error);}
});
addRoute("POST","/api/rooms/:id/tasks/:taskId/comments",async(req,res,params)=>{
  try {
    const body=await parseBody(req) as any;
    const result=tasks.commentTask(params.id,params.taskId,String(body?.comment||""),{name:String(body?.author||"user")});
    if(!result){sendJson(res,404,{error:"Task not found"});return;}
    sendJson(res,200,result.task);
  }catch(error){failure(res,error);}
});
addRoute("DELETE","/api/rooms/:id/tasks/:taskId",async(req,res,params)=>{
  try {
    const body=await parseBody(req) as any;
    if(!tasks.deleteTask(params.id,params.taskId,{name:String(body?.deletedBy||"user")})){sendJson(res,404,{error:"Task not found"});return;}
    sendJson(res,200,{ok:true});
  }catch(error){failure(res,error);}
});
