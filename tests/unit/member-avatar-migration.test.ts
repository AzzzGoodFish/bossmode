import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {applyStorageMigrations,openDatabase} from '../../src/data/database.js';
import {coreStorageMigrations} from '../../src/data/schema.js';
it('upgrades existing members without changing their data and retains appearance after reopening',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bm-avatar-migration-')),path=join(dir,'bossmode.db');let db=openDatabase(path);
  try {
    applyStorageMigrations(db,coreStorageMigrations.slice(0,coreStorageMigrations.findIndex(m=>m.id==='core-member-avatar-v1')));
    db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_one','One','one','general','{}',1,2)");
    const before=db.get<Record<string,unknown>>('SELECT * FROM members WHERE id=?','mem_one');
    const history=db.all('SELECT * FROM storage_schema_versions ORDER BY rowid');
    applyStorageMigrations(db,coreStorageMigrations);
    expect(db.get('SELECT * FROM members WHERE id=?','mem_one')).toEqual({...before,avatar_shape:null,avatar_color:null});
    expect(db.all('SELECT * FROM storage_schema_versions ORDER BY rowid LIMIT ?',history.length)).toEqual(history);
    db.run("UPDATE members SET avatar_shape='cloud',avatar_color='cyan' WHERE id='mem_one'");
    db.close();db=openDatabase(path);applyStorageMigrations(db,coreStorageMigrations);
    expect(db.get('SELECT avatar_shape,avatar_color FROM members')).toEqual({avatar_shape:'cloud',avatar_color:'cyan'});
    expect(()=>db.run("UPDATE members SET avatar_shape='not-a-shape'")).toThrow();
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
