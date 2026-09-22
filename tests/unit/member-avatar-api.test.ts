import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTestServer, getTestBossmodeDir, jsonRequest, setupTestWorkspace } from '../helpers/test-server.js';
import { MEMBER_AVATAR_COLORS, MEMBER_AVATAR_SHAPES, validateAvatarChoice } from '../../src/member/avatar.js';
setupTestWorkspace();
describe('member character appearance',()=>{
  it('persists shape/color in SQLite, broadcasts an appearance-only change, and keeps omitted values',async()=>{
    const server=await createTestServer();
    try {
      const login=await jsonRequest(server.port,'POST','/api/auth/login',{body:{username:'testuser',password:'testpass'}}),token=JSON.parse(login.body).token;
      const created=await jsonRequest(server.port,'POST','/api/members',{token,body:{name:'Avatar owner'}}),id=JSON.parse(created.body).member.id;
      expect(JSON.parse(created.body).member).toMatchObject({avatarShape:null,avatarColor:null});
      const identity=await import('../../src/member/identity.js');let appearance=0,profile=0;
      const offAvatar=identity.onMemberAppearanceChanged(()=>appearance++),offProfile=identity.onMemberIdentityChanged(()=>profile++);
      try {
        let r=await jsonRequest(server.port,'PATCH',`/api/members/${id}`,{token,body:{avatarShape:'teardrop',avatarColor:'blue'}});
        expect(r.status).toBe(200);expect(JSON.parse(r.body).member).toMatchObject({avatarShape:'teardrop',avatarColor:'blue'});
        expect(appearance).toBe(1);expect(profile).toBe(0);
        r=await jsonRequest(server.port,'PATCH',`/api/members/${id}`,{token,body:{avatarColor:'red'}});
        expect(JSON.parse(r.body).member).toMatchObject({avatarShape:'teardrop',avatarColor:'red'});
        const db=(await import('../../src/data/database.js')).getDatabase();
        expect(db.get('SELECT avatar_shape,avatar_color FROM members WHERE id=?',id)).toEqual({avatar_shape:'teardrop',avatar_color:'red'});
        expect(existsSync(join(getTestBossmodeDir(),'members',id,'profile.json'))).toBe(false);
        expect((identity.getMember(id))).toMatchObject({avatarShape:'teardrop',avatarColor:'red'});
        const listed=await jsonRequest(server.port,'GET','/api/members',{token});
        expect(JSON.parse(listed.body).members.find((m:{id:string})=>m.id===id)).toMatchObject({avatarShape:'teardrop',avatarColor:'red'});
        const old=identity.getMember(id);
        for(const body of [{avatarColor:'#ff00ff'},{avatarShape:'<svg/>'},{avatarColor:1},{avatarShape:{}},{name:'must not change',avatarColor:'bad'}]){
          r=await jsonRequest(server.port,'PATCH',`/api/members/${id}`,{token,body});expect(r.status).toBe(400);expect(identity.getMember(id)).toEqual(old);
        }
        r=await jsonRequest(server.port,'PATCH',`/api/members/${id}`,{token,body:{avatarShape:null,avatarColor:''}});
        expect(JSON.parse(r.body).member).toMatchObject({avatarShape:null,avatarColor:null});
        expect(profile).toBe(0);
        const unauthorized=await jsonRequest(server.port,'PATCH',`/api/members/${id}`,{body:{avatarColor:'green'}});expect(unauthorized.status).toBe(401);
      } finally {offAvatar();offProfile();}
    }finally{await new Promise<void>(r=>server.server.close(()=>r()));}
  });
  it('accepts only reference shape and color choices plus reset',()=>{
    for(const shape of MEMBER_AVATAR_SHAPES)expect(validateAvatarChoice(shape,'shape')).toBe(shape);
    for(const color of MEMBER_AVATAR_COLORS)expect(validateAvatarChoice(color,'color')).toBe(color);
    expect(validateAvatarChoice(null,'shape')).toBeNull();expect(validateAvatarChoice('','color')).toBeNull();
    expect(()=>validateAvatarChoice('blue','shape')).toThrow('invalid_member_avatar');
  });
});
