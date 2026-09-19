import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {coreFixture} from "../helpers/core-fixture.js";
import {disableDeferredMcpCapabilities,filterMcpConfigForServers,getAssignableMcpServerNames,importMcpConfiguration,readMcpConfiguration,restoreRedactedMcpConfig} from "../../src/member/mcp.js";

let fixture:ReturnType<typeof coreFixture>;
beforeEach(()=>{fixture=coreFixture();});afterEach(()=>fixture.close());

describe("MCP configuration",()=>{
  const config={imports:["vscode"],settings:{timeout:1000,sampling:true,nested:{elicitation:{mode:"url"}}},mcpServers:{
    playwright:{url:"http://127.0.0.1:8931/mcp",directTools:true},github:{command:"node",args:["server.mjs"]},invalid:{},badUrl:{url:"not a url"}}};

  it("persists the global SQL authority and filters member-assigned servers",()=>{
    importMcpConfiguration(config);expect(readMcpConfiguration()).toEqual(config);
    const scoped=filterMcpConfigForServers(readMcpConfiguration(),["playwright","invalid","missing"]);
    expect(Object.keys((scoped as any).mcpServers)).toEqual(["playwright","invalid"]);
    expect((scoped as any).imports).toBeUndefined();expect((scoped as any).settings.timeout).toBe(1000);
  });

  it("returns only assignable HTTP and stdio servers",()=>{
    expect(getAssignableMcpServerNames(config)).toEqual(["playwright","github"]);
  });

  it("disables deferred capabilities and restores redacted secrets",()=>{
    const disabled=disableDeferredMcpCapabilities(config) as any;
    expect(disabled.settings.sampling).toBe(false);expect(disabled.settings.nested.elicitation).toBe(false);expect(disabled.mcpServers.playwright.directTools).toBe(false);
    const existing={mcpServers:{private:{url:"https://old.test",bearerToken:"secret",headers:{Authorization:"Bearer secret"}}}};
    expect(restoreRedactedMcpConfig({mcpServers:{private:{url:"https://new.test",bearerToken:"[REDACTED]",headers:{Authorization:"[REDACTED]"}}}},existing)).toEqual({mcpServers:{private:{url:"https://new.test",bearerToken:"secret",headers:{Authorization:"Bearer secret"}}}});
  });
});
