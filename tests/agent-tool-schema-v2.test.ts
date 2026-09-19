import {describe,expect,it} from "vitest";
import {DIRECT_TOOL_SPECS,GATEWAY_TOOL_SPECS} from "../src/agent/tools.js";

function descriptions(spec:{parameters:unknown}):Record<string,string>{
  const properties=(spec.parameters as {properties:Record<string,{description?:string}>}).properties;
  return Object.fromEntries(Object.entries(properties).map(([name,value])=>[name,value.description??""]));
}

describe("member tool parameter descriptions v2",()=>{
  it("describes overloaded names in the owning tool's terms",()=>{
    const gateway=(name:string)=>GATEWAY_TOOL_SPECS.find(spec=>spec.name===name)!;
    const direct=(name:string)=>DIRECT_TOOL_SPECS.find(spec=>spec.name===name)!;
    expect(descriptions(gateway("chat_create")).name).toBe("Group chat name.");
    expect(descriptions(gateway("chat_edit")).name).toBe("Group chat name.");
    expect(descriptions(gateway("profile_update")).name).toBe("New member name.");
    expect(descriptions(direct("terminal_create")).name).toContain("terminal");
    expect(descriptions(direct("workspace_create"))).toMatchObject({
      id:"Workspace id — letters, digits, dot, dash, underscore.",
      description:"Short human-readable description.",
    });
  });

  it("keeps exec and wait block budgets distinct",()=>{
    const direct=(name:string)=>DIRECT_TOOL_SPECS.find(spec=>spec.name===name)!;
    expect(descriptions(direct("terminal_exec")).blockSeconds).toContain("Default 10");
    expect(descriptions(direct("terminal_wait")).blockSeconds).toContain("Default 30");
    expect(descriptions(direct("terminal_wait")).blockSeconds).toContain("0 waits until completion");
  });

  it("uses owning-tool semantics for list, chat, file, and terminal fields",()=>{
    const direct=(name:string)=>DIRECT_TOOL_SPECS.find(spec=>spec.name===name)!;
    expect(descriptions(direct("chat_list"))).toMatchObject({query:"Keyword filter.",limit:"Max entries to return (default 50).",offset:"Skip this many entries (for paging)."});
    expect(descriptions(direct("chat_send"))).toMatchObject({to:expect.stringContaining("Target chat"),message:expect.stringContaining("@name"),attachments:expect.stringContaining("copied")});
    expect(descriptions(direct("read"))).toMatchObject({path:expect.stringContaining("File path"),offset:expect.stringContaining("1-indexed"),limit:expect.stringContaining("lines")});
    expect(descriptions(direct("terminal_read"))).toMatchObject({terminalId:expect.stringContaining("Terminal id"),exec:expect.stringContaining("Exec id"),fromLine:expect.stringContaining("First absolute"),toLine:expect.stringContaining("Last absolute")});
  });
});
