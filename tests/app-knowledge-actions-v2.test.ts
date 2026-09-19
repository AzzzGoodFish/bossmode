import {afterEach,describe,expect,it} from "vitest";
import {coreFixture} from "./helpers/core-fixture.js";
import {addEntry,getEntry} from "../src/knowledge/documents.js";
import {createRoom,getRoom} from "../src/chat/conversations.js";
import {deleteKnowledgePath,moveKnowledgePath} from "../src/app/knowledge-actions.js";

const fixtures:ReturnType<typeof coreFixture>[]=[];
afterEach(()=>{for(const fixture of fixtures.splice(0))fixture.close();});
function setup(){const fixture=coreFixture();fixtures.push(fixture);return fixture;}

describe("knowledge path mutations v2",()=>{
  it("moves a file to an existing folder and rewrites room rule documents",()=>{
    setup();addEntry("Rule","rule","user","rules/a.md");addEntry("Keep","keep","user","archive/keep.md");
    const room=createRoom("Knowledge",undefined,[],["rules/a.md"]);
    expect(moveKnowledgePath("rules/a.md","archive")).toEqual({ok:true,type:"file",from:"rules/a.md",to:"archive/a.md"});
    expect(getEntry("rules/a.md")).toBeNull();expect(getEntry("archive/a.md")).not.toBeNull();
    expect(getRoom(room.id)?.ruleDocs).toEqual(["archive/a.md"]);
  });

  it("deletes a folder and removes every contained room rule document",()=>{
    setup();addEntry("A","a","user","rules/a.md");addEntry("B","b","user","rules/sub/b.md");
    const room=createRoom("Knowledge",undefined,[],["rules/a.md","rules/sub/b.md","other.md"]);
    expect(deleteKnowledgePath("rules")).toEqual({ok:true,type:"folder",from:"rules"});
    expect(getRoom(room.id)?.ruleDocs).toEqual(["other.md"]);
  });
});
