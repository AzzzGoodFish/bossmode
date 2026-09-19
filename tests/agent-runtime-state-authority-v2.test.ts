import {afterEach,describe,expect,it} from "vitest";
import {refreshAgentContextUsage} from "../src/agent/controls.js";
import {contextUsageCache,instanceKey,instances,type AgentInstance} from "../src/agent/instance.js";
import {MockAgentHandle} from "./helpers/mock-runtime.js";
import type {ContextUsage} from "../src/agent/types.js";

afterEach(()=>{instances.clear();contextUsageCache.clear();});
function runtime(handle:MockAgentHandle):AgentInstance{return {
  handle,activeSourceRef:null,memberId:"mem_state",agentName:"State",status:"idle",dispatchState:"idle",promptInFlight:false,
  hadErrorInTurn:false,lastTurnError:null,pendingErrorNotice:null,lastMessageEndWasLength:false,lengthContinuationPending:false,
  lengthContinuationAttempted:false,compacting:false,turnActive:false,sessionSources:{compiled:{agentPrompt:"",appendSystemPrompt:[]}},
  unsubscribe(){},eventBuffer:[],appliedModel:"fake:model",pendingReload:null,
};}

describe("agent runtime state authority",()=>{
  it("refreshes and caches context usage inside agent controls",async()=>{
    const handle=new MockAgentHandle(),usage:ContextUsage={totalTokens:42,rawMaxTokens:100,percentage:42,model:"fake:model"};
    handle.getContextUsage=async()=>usage;instances.set(instanceKey("mem_state"),runtime(handle));
    await expect(refreshAgentContextUsage("mem_state")).resolves.toEqual(usage);
    expect(contextUsageCache.get(instanceKey("mem_state"))).toEqual(usage);
  });

  it("does not publish an async result from a replaced runtime",async()=>{
    let resolve!:(usage:ContextUsage)=>void;const pending=new Promise<ContextUsage>(done=>{resolve=done;});
    const handle=new MockAgentHandle();handle.getContextUsage=()=>pending;const first=runtime(handle);instances.set(instanceKey("mem_state"),first);
    const refresh=refreshAgentContextUsage("mem_state");instances.set(instanceKey("mem_state"),runtime(new MockAgentHandle()));
    resolve({totalTokens:1,rawMaxTokens:10,percentage:10,model:"old"});
    await expect(refresh).resolves.toBeNull();expect(contextUsageCache.has(instanceKey("mem_state"))).toBe(false);
  });
});
