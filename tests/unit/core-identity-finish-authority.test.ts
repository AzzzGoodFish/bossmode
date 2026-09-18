import { getDefaultConfig } from "../../src/config/settings.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { prepareCoreStorage } from "../../src/app/upgrade/run.js";

import * as registry from "../../src/member/identity.js";
import * as __registry_app_member_actions from "../../src/app/member-actions.js";
import { storeRoom, readStoredRoom } from "../../src/chat/conversations.js";
import { resolveRoomMember } from "../../src/app/member-actions.js";
import { importHistoricalAgentTemplate } from "../helpers/historical-agent-template.js";
import { readTemplateMetadata } from "../../src/member/templates.js";
import { readTemplateBody } from "../../src/app/upgrade/records.js";
import { readMemberProfile } from "../../src/member/profile.js";
import type { Database } from "../../src/data/database.js";
import { migratedMemberId } from "../helpers/short-id.js";

describe("stable identity and body-free metadata", () => {
  let fixture: ReturnType<typeof coreFixture>;
  beforeEach(() => { fixture=coreFixture(); });
  afterEach(() => fixture.close());
  it("retains ID-owned room membership and persona across rename and reuse by an ID-shaped display name", () => {
    const original=__registry_app_member_actions.createMemberWithPersona({name:"original",title:"Engineer"},"---\nname: not identity\n---\n literal \n");
    const namedLikeId=__registry_app_member_actions.createMember({name:original.id});
    const room={id:"room-one",name:"Room",members:[],globalMemberIds:[original.id,namedLikeId.id],createdAt:1};
    storeRoom(room, fixture.db);
    registry.renameMember(original.id,"renamed"); fixture.reopen();
    expect(registry.findMemberByName(original.id)?.id).toBe(namedLikeId.id);
    expect(resolveRoomMember(room.id,original.id)).toMatchObject({id:original.id,name:"renamed",title:"Engineer"});
    expect(resolveRoomMember(room.id,namedLikeId.id)).toMatchObject({id:namedLikeId.id,name:original.id});
    expect(readMemberProfile(original.id).body).toBe("---\nname: not identity\n---\n literal \n");
    expect(readMemberProfile(namedLikeId.id).body).toBe("");
    expect(readStoredRoom(room.id, fixture.db)?.globalMemberIds).toEqual([original.id,namedLikeId.id]);
  });
  it("resolves metadata and identity without loading template/persona bodies, while actual body reads fail", () => {
    importHistoricalAgentTemplate(fixture,"engineer","---\nname: Display\navatar: icon\n---\nprivate template body");
    const member=__registry_app_member_actions.createMember({name:"member",agentTemplate:"engineer"});
    const room={id:"room-one",name:"Room",members:[],globalMemberIds:[member.id],createdAt:1};
    storeRoom(room, fixture.db);
    rmSync(join(fixture.root,readTemplateMetadata("engineer", fixture.db)!.personaPath));
    rmSync(join(fixture.root,"members",member.id,"persona.md"));
    mkdirSync(join(fixture.root,"members",member.id,"persona.md"));
    fixture.db.transaction(() => {
      expect(registry.getMember(member.id)?.name).toBe("member");
      expect(registry.listMembers()).toHaveLength(1);
      expect(resolveRoomMember(room.id,member.id)).toMatchObject({id:member.id,name:"member"});
      expect(resolveRoomMember(room.id,member.id)?.avatar).toBeUndefined();
      expect(readTemplateMetadata("engineer", fixture.db)).toMatchObject({name:"Display",avatar:"icon"});
    });
    expect(() => readTemplateBody(fixture.root, readTemplateMetadata("engineer", fixture.db)!)).toThrow();
    expect(() => readMemberProfile(member.id)).toThrow();
  });
  it("inviting a current contact preserves the no-legacy-config contract", async () => {
    const { createRoom, inviteGlobalMember } = await import("../../src/chat/conversations.js");
    const room=createRoom("Direct",undefined,[]);
    writeFileSync(join(fixture.root,"members.json"),JSON.stringify([{id:"legacy",name:"direct",model:"stale"}]));
    const member = __registry_app_member_actions.createMember({ name: "direct" });
    expect(inviteGlobalMember(room.id,member)).toMatchObject({ok:true});
    expect(resolveRoomMember(room.id,"direct")).toMatchObject({name:"direct",model:undefined,credentialId:undefined});
  });

});

describe("historical authority-loss guards", () => {
  let root: string;
  let opened: Database[];
  beforeEach(() => {root=process.env.BOSSMODE_DIR!;opened=[];mkdirSync(join(root,"knowledge"),{recursive:true});});
  afterEach(() => {for(const db of opened)db.close();rmSync(root,{recursive:true,force:true});});
  async function start() {const result=await prepareCoreStorage({root,initialConfig:getDefaultConfig(),bundledCatalog:[]});opened.push(result.db);return result;}
  it.each(["{invalid",JSON.stringify({status:"prepared"}),JSON.stringify({status:"done"})])("refuses a historical member-storage journal with missing DB: %s", async marker => {
    mkdirSync(join(root,"migrations"));writeFileSync(join(root,"migrations/member-storage-v1.json"),marker);
    await expect(start()).rejects.toThrow();
    expect(existsSync(join(root,"bossmode.db"))).toBe(false);
  });
  it("refuses an orphan member asset directory rather than silently inventing empty authority", async () => {
    mkdirSync(join(root,"members/mem_orphan"),{recursive:true});
    await expect(start()).rejects.toThrow();
    expect(existsSync(join(root,"bossmode.db"))).toBe(false);
  });
  // Verified ordinary failure: /tmp/bm-core-identity-extra-red.log.
  it("refuses missing active member assets on subsequent normal startup", async () => {
    mkdirSync(join(root,"members/mem_current"),{recursive:true});
    writeFileSync(join(root,"members/mem_current/member.json"),JSON.stringify({id:"mem_current",name:"current",agentTemplate:"general",global:{},createdAt:1,updatedAt:1}));
    const first=await start(); const mid=migratedMemberId(first.db,"mem_current"); first.db.close();
    rmSync(join(root,`members/${mid}`),{recursive:true});
    await expect(start()).rejects.toThrow();
  });

});
