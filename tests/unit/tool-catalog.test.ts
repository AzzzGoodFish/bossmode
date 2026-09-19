import {describe,it,expect} from "vitest";
import {DIRECT_TOOL_SPECS,GATEWAY_TOOL_SPECS,PARAM_DESCRIPTIONS} from "../../src/agent/tools.js";

const direct=["chat_send","chat_read","chat_search","chat_list","bossmode","workspace_list","workspace_create","workspace_use","workspace_remove","read","write","edit","terminal_create","terminal_exec","terminal_read","terminal_wait","terminal_list","terminal_close","reload"];
const gateway=["chat_info","chat_create","chat_edit","member_list","member_info","profile_read","profile_update"];

describe("tool catalog",()=>{
  it("covers the public direct and gateway tools exactly once",()=>{
    expect(DIRECT_TOOL_SPECS.map(spec=>spec.name)).toEqual(direct);
    expect(GATEWAY_TOOL_SPECS.map(spec=>spec.name)).toEqual(gateway);
    expect(new Set([...direct,...gateway]).size).toBe(direct.length+gateway.length);
  });

  it("gives every tool and parameter a usable public contract",()=>{
    for(const spec of [...DIRECT_TOOL_SPECS,...GATEWAY_TOOL_SPECS]){
      expect(spec.label.length,spec.name).toBeGreaterThan(0);
      expect(spec.description.length,spec.name).toBeGreaterThan(20);
      const schema=spec.parameters as {type?:string;properties?:Record<string,{description?:string}>};
      expect(schema.type,spec.name).toBe("object");
      for(const [name,value] of Object.entries(schema.properties??{})){if(spec.name==="edit"&&name==="edits")continue;expect(value.description,`${spec.name}.${name}`).toEqual(expect.any(String));expect(value.description!.length,`${spec.name}.${name}`).toBeGreaterThan(5);}
    }
    for(const [name,value] of Object.entries(PARAM_DESCRIPTIONS))expect(value.length,name).toBeGreaterThan(5);
  });

  it("contains no retired task, summary, memory, or legacy query tools",()=>{
    const serialized=JSON.stringify([...DIRECT_TOOL_SPECS,...GATEWAY_TOOL_SPECS]);
    expect(serialized).not.toMatch(/write_summary|summarizer|create_task|list_tasks|read_memory|write_memory|edit_memory|query_room_messages|list_scopes/);
    for(const retired of ["summaryTitle","taskTitle","taskId","scope","type"])expect(PARAM_DESCRIPTIONS).not.toHaveProperty(retired);
  });
});
