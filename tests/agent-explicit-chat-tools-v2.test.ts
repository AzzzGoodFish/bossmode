import {afterEach,describe,expect,it,vi} from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { storeRoom } from "../src/chat/conversations.js";
import {importMessage,readMessages} from "../src/chat/messages.js";
import {storeAttachment,inferAttachmentPreviewType} from "../src/files/attachments.js";
import {getMemberCursor} from "../src/chat/cursors.js";
import {Readable} from "node:stream";
import {existsSync,readFileSync} from "node:fs";
import { createBossmodeSdkTools } from "../src/agent/runtime/tools.js";
import {initializeMemberRuntime,wireChatHttp} from "../src/app/wire.js";
import {loadAgentMemberSnapshot} from "../src/app/member-actions.js";
import {shutdownAll} from "../src/agent/controls.js";
import {MockRuntime,mockPromptFn,resetMocks} from "./helpers/mock-runtime.js";
import {saveModelCredentialProfile} from "../src/config/models.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(async()=>{await shutdownAll();for(const fixture of fixtures.splice(0))fixture.close();});

function setup() {
  const fixture = coreFixture(); fixtures.push(fixture);
  fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "mem_tools", "Tools", "tools", "general", "{}", 1, 1,
  );
  storeRoom({ id: "rm_tools", name: "Tools room", memberIds: ["mem_tools"], promptLeaderMemberId: "mem_tools", createdAt: 1 }, fixture.db);
  return fixture;
}

describe("explicit chat tools without current source v2", () => {
  it("authorizes an explicit target independently and rejects only implicit-current calls", async () => {
    const fixture = setup();
    const disconnect = wireChatHttp();
    const tools = createBossmodeSdkTools({ memberId: "mem_tools", resolveSourceRef: () => null });
    const send = tools.find(tool => tool.name === "chat_send")!;
    const read = tools.find(tool => tool.name === "chat_read")!;

    await expect(send.execute("send", { to: "room:rm_tools", message: "explicit target" } as any)).resolves.toBeTruthy();
    await expect(read.execute("read", { chat: "room:rm_tools", limit: 10 } as any)).resolves.toBeTruthy();
    expect(fixture.db.get<{ content: string }>("SELECT content FROM messages WHERE scope_id='rm_tools' ORDER BY seq DESC LIMIT 1")?.content).toBe("explicit target");
    await expect(send.execute("implicit", { message: "no current chat" } as any)).rejects.toThrow("current chat or an explicit target");
    disconnect();
  });

  it("preserves member status and first private-chat jump notification",async()=>{
    const fixture=setup();fixture.db.run(
      "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      "mem_peer","Peer","peer","general","{}",1,1,
    );
    const profile=saveModelCredentialProfile({name:"Mock",providerSlug:"mock",protocol:"openai-responses",baseUrl:"https://mock.invalid/v1",authType:"api_key",apiKey:"test",requestProfile:"standard",enabled:true,isDefault:true,models:[{id:"model",contextWindow:4096}]});
    const binding=JSON.stringify({model:"mock/model",credentialId:profile.id,thinkingLevel:"off"});fixture.db.run("UPDATE members SET global_json=? WHERE id IN (?,?)",binding,"mem_tools","mem_peer");
    resetMocks();initializeMemberRuntime(new MockRuntime("pi-cli"),loadAgentMemberSnapshot);
    const postCommitWarnings=vi.spyOn(console,"warn"),disconnect=wireChatHttp();
    try{
      const tools=createBossmodeSdkTools({memberId:"mem_tools",resolveSourceRef:()=>"room:rm_tools"}),gateway=tools.find(tool=>tool.name==="bossmode")!,send=tools.find(tool=>tool.name==="chat_send")!;
      const info=await gateway.execute("info",{action:"call",tool:"member_info",args:{member:"Peer"}} as any);expect((info as any).content[0].text).toContain('"status": "inactive"');
      await send.execute("first",{to:"Peer",message:"hello privately"} as any);await send.execute("second",{to:"Peer",message:"again"} as any);
      await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));
      expect(postCommitWarnings.mock.calls.filter(args=>String(args[0]).includes("post-commit observer failed"))).toEqual([]);
      const notices=readMessages("dm:mem_peer",fixture.db).filter(message=>message.member_chat_meta);
      expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({sender:"system",member_chat_meta:{fromMemberId:"mem_tools",toMemberId:"mem_peer"}});
      expect(notices[0].content).toContain("started a private chat");
    }finally{postCommitWarnings.mockRestore();disconnect();}
  });

  it("honors sequence/time windows and renders reply, attachment, and file views",async()=>{
    const fixture=setup(),now=Date.now(),location={kind:"room" as const,roomId:"rm_tools"};
    const stored=await storeAttachment(Readable.from(["attachment body"]),location,"evidence.txt");
    const add=(message:any)=>importMessage(fixture.db,"room:rm_tools",{mentions:[],...message});
    add({id:"m1",seq:1,ts:now-3000,sender:"user",content:"anchor"});
    add({id:"m2",seq:2,ts:now-2000,sender:"system",content:"hidden notice"});
    add({id:"m3",seq:3,ts:now-1000,sender:"Tools",senderMemberId:"mem_tools",content:"reply with attachment",replyTo:{messageId:"m1",seq:1},attachments:[{
      id:stored.storedFilename,storedFilename:stored.storedFilename,originalFilename:stored.originalFilename,size:stored.size,previewType:inferAttachmentPreviewType(stored.originalFilename),
    }]});
    add({id:"m4",seq:4,ts:now,sender:"user",content:"tail"});
    add({id:"m5",seq:5,ts:now+1,sender:"user",content:"missing attachment",attachments:[{id:"missing.txt",storedFilename:"missing.txt",originalFilename:"missing.txt",previewType:"text"}]});
    const disconnect=wireChatHttp();
    try{
      const tools=createBossmodeSdkTools({memberId:"mem_tools",resolveSourceRef:()=>null}),read=tools.find(tool=>tool.name==="chat_read")!,search=tools.find(tool=>tool.name==="chat_search")!;
      const around=await read.execute("around",{chat:"room:rm_tools",around_seq:3,limit:3} as any),text=(around as any).content[0].text as string;
      expect(text).toContain("No.1");expect(text).toContain("No.3");expect(text).toContain("No.4");expect(text).not.toContain("hidden notice");
      expect(text).toContain("In reply to msg:#1");expect(text).toContain("evidence.txt");expect(text).toContain(stored.storedFilename);
      const after=await read.execute("after",{chat:"room:rm_tools",from_seq:1,limit:1} as any);
      expect((after as any).content[0].text).toContain("No.3");
      const found=await search.execute("search",{chat:"room:rm_tools",query:"reply",after:"1h"} as any),foundText=(found as any).content[0].text as string;
      expect(foundText).toContain("reply with attachment");expect(foundText).not.toContain("In reply to");expect(foundText).not.toContain("Attachment:");
      const unavailable=await read.execute("missing",{chat:"room:rm_tools",limit:1} as any);expect((unavailable as any).content[0].text).toContain("Attachment unavailable: missing.txt");
      const output=await read.execute("file",{chat:"room:rm_tools",from_seq:0,output:"file"} as any),notice=(output as any).content[0].text as string;
      const path=/Messages written to: (.+) \(count:/.exec(notice)?.[1];expect(path&&existsSync(path)).toBe(true);expect(readFileSync(path!,"utf8")).toContain("reply with attachment");
      await expect(read.execute("bad-time",{chat:"room:rm_tools",after:"not-a-time"} as any)).rejects.toThrow("Invalid chat time");
      const cross=createBossmodeSdkTools({memberId:"mem_tools",resolveSourceRef:()=>"dm:mem_tools"}),crossRead=cross.find(tool=>tool.name==="chat_read")!;
      await crossRead.execute("cross",{chat:"room:rm_tools",limit:1} as any);expect(getMemberCursor("room:rm_tools","mem_tools")).toBeNull();
      const local=createBossmodeSdkTools({memberId:"mem_tools",resolveSourceRef:()=>"room:rm_tools"}),localSearch=local.find(tool=>tool.name==="chat_search")!,localRead=local.find(tool=>tool.name==="chat_read")!;
      await localSearch.execute("local-search",{chat:"room:rm_tools",query:"tail"} as any);expect(getMemberCursor("room:rm_tools","mem_tools")).toBe("m4");
      await localRead.execute("local-read",{chat:"room:rm_tools",limit:1} as any);expect(getMemberCursor("room:rm_tools","mem_tools")).toBe("m5");
      await localSearch.execute("older-search",{chat:"room:rm_tools",query:"anchor"} as any);expect(getMemberCursor("room:rm_tools","mem_tools")).toBe("m5");
      await expect(localSearch.execute("empty-search",{chat:"room:rm_tools",query:""} as any)).rejects.toThrow("query is required");
    }finally{disconnect();}
  });
});
