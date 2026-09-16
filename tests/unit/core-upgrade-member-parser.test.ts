import { expect, it } from "vitest";
import { parseLegacyMemberPersona, parseLegacyMemberRecord } from "../../src/app/upgrade/records.js";
const record={id:"mem_one",name:"Alice",agentTemplate:"general",global:{model:null,credentialId:"profile",skills:[],mcpServers:[],extensions:["retired"],custom:{keep:true}},createdAt:0,updatedAt:1};
it("preserves every persona body byte after UTF-8/BOM/CRLF frontmatter",()=>{
 const body=Buffer.from("\r\n  literal 言实\r\n\r\n");
 const source=Buffer.concat([Buffer.from("\uFEFF---\r\nname: label\r\ntitle: ' engineer '\r\n---\r\n"),body]);
 const result=parseLegacyMemberPersona(source,"members/mem_one/member.md");
 expect(Buffer.from(result.body)).toEqual(body);expect(result.title).toBe("engineer");expect(result.profileName).toBe("label");
});
it("does not parse or trim a plain persona body",()=>{
 const source=Buffer.from("\uFEFF  # Persona\r\n\n");
 expect(Buffer.from(parseLegacyMemberPersona(source,"member.md").body)).toEqual(source);
});
it("preserves the accepted alternate frontmatter closing delimiter",()=>{
 expect(Buffer.from(parseLegacyMemberPersona(Buffer.from("---\nname: Alice\n...\n\nbody\n"),"member.md").body).toString()).toBe("\nbody\n");
});
it("never replaces member.json identity with a differing profile header",()=>{
 const member=parseLegacyMemberRecord(Buffer.from(JSON.stringify(record)),"mem_one","member.json");
 const persona=parseLegacyMemberPersona(Buffer.from("---\nname: Bob\ntitle: Engineer\n---\nbody"),"member.md");
 expect(member.name).toBe("Alice");expect(persona.profileName).toBe("Bob");
 expect(member.global).toEqual({model:null,credentialId:"profile",skills:[],mcpServers:[],custom:{keep:true}});
 expect(member.createdAt).toBe(0);
});
it("rejects malformed member identities without leaking source data",()=>{
 const secret="credential-sentinel";
 expect(()=>parseLegacyMemberRecord(Buffer.from('{"'+secret),'mem_one','member.json')).toThrow("Invalid legacy member record: member.json");
 expect(()=>parseLegacyMemberRecord(Buffer.from(JSON.stringify({...record,id:"mem_other"})),"mem_one","member.json")).toThrow("Invalid legacy member record");
});
it("rejects invalid YAML/metadata/UTF-8 without quoting private values",()=>{
 for(const body of ["---\nname: one\nname: secret\n---\nbody","---\ntitle: [private]\n---\nbody","---\nname: private","---\n- private\n---\nbody"]){
  try{parseLegacyMemberPersona(Buffer.from(body),"member.md");throw new Error("expected rejection");}catch(error){expect(String(error)).not.toContain("private");expect(String(error)).toContain("legacy member");}
 }
 expect(()=>parseLegacyMemberPersona(Buffer.from([0xff]),"member.md")).toThrow("Invalid UTF-8");
});
