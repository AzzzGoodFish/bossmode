import {describe,expect,it} from "vitest";
import {setupTestWorkspace} from "../helpers/test-server.js";
import {createMember} from "../../src/app/member-actions.js";
import {getMemberActiveTools} from "../../src/agent/controls.js";

setupTestWorkspace();

describe("member active tools",()=>{
  it("returns an explicit empty session for an idle member",()=>{
    const member=createMember({name:"tools-idle"});
    expect(getMemberActiveTools(member.id)).toEqual({sessionActive:false,tools:[],message:expect.stringMatching(/Start or Reload/i)});
  });
});
