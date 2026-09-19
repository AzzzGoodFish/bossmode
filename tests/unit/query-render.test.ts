import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {coreFixture} from "../helpers/core-fixture.js";
import {getDefaultConfig,writeConfig} from "../../src/config/settings.js";
import {renderQueryRowForMember,renderQueryRowsForMember} from "../../src/agent/tools.js";

let fixture:ReturnType<typeof coreFixture>;
beforeEach(()=>{fixture=coreFixture();writeConfig({...getDefaultConfig(),auth:{username:"fish",passwordHash:"fixture-only"}},fixture.db);});
afterEach(()=>fixture.close());

describe("query renderer (member view)",()=>{
  it("renders sequence, reply, content, attachment and unavailable variants",()=>{
    const text=renderQueryRowForMember({seq:42,sender:"qa",content:"report done",ts:1780000000000,
      replyTo:{seq:40,messageId:"m40",sender:"pm",excerpt:"please run checks"},
      attachments:[{originalFilename:"report.md",path:"/x/report.md"}]});
    expect(text).toContain("[No.42 · qa · ");
    expect(text).toContain('[In reply to msg:#40 from pm]: "please run checks"');
    expect(text).toContain("Attachment: [original filename: report.md](/x/report.md)");
    const lost=renderQueryRowForMember({seq:43,sender:"qa",content:"hmm",replyTo:{seq:1,messageId:"gone",unavailable:true},
      attachments:[{originalFilename:"gone.md",unavailable:true}]});
    expect(lost).toContain("[In reply to msg:#1 — original not visible in this context]");
    expect(lost).toContain("Attachment unavailable: gone.md");
    expect(renderQueryRowsForMember([])).toBe("No messages found.");
  });

  it("maps the human sender through configured login without changing member names",()=>{
    const human=renderQueryRowForMember({seq:7,sender:"user",content:"from the human",ts:1780000000000,
      replyTo:{seq:6,messageId:"m6",sender:"user",excerpt:"earlier human line"}});
    expect(human).toContain("[No.7 · fish · ");
    expect(human).toContain('[In reply to msg:#6 from fish]: "earlier human line"');
    expect(human).not.toContain("· user ·");
    const member=renderQueryRowForMember({seq:8,sender:"qa",content:"member line",replyTo:{seq:7,messageId:"m7",sender:"pm",excerpt:"pm line"}});
    expect(member).toContain("[No.8 · qa]");
    expect(member).toContain('[In reply to msg:#7 from pm]: "pm line"');
  });
});
