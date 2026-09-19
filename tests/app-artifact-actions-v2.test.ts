import {afterEach,describe,expect,it} from "vitest";
import {coreFixture} from "./helpers/core-fixture.js";
import {createRoom} from "../src/chat/conversations.js";
import {addEntry} from "../src/knowledge/documents.js";
import {readArtifactPreview,resolveArtifact} from "../src/app/artifact-actions.js";

const fixtures:ReturnType<typeof coreFixture>[]=[];
afterEach(()=>{for(const fixture of fixtures.splice(0))fixture.close();});

describe("artifact app boundary",()=>{
  it("resolves and reads knowledge artifacts only through authorized room roots",()=>{
    const fixture=coreFixture();fixtures.push(fixture);
    const room=createRoom("Artifacts",[]);addEntry("Guide","# Guide\n\nBody","user","docs/guide.md");
    const resolved=resolveArtifact(room.id,"docs/docs/guide.md");
    expect(resolved).toMatchObject({ok:true,type:"md",normalized:"docs/guide.md"});
    expect(readArtifactPreview(room.id,"docs/docs/guide.md")).toMatchObject({ok:true,type:"md",path:"docs/guide.md",title:"Guide",content:"# Guide\n\nBody"});
    expect(resolveArtifact("missing","docs/docs/guide.md")).toEqual({ok:false,error:"Room not found",status:404});
    expect(resolveArtifact(room.id,"https://example.com/a.md")).toEqual({ok:false,error:"Remote URLs are not previewable",status:400});
  });
});
