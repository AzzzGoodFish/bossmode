#!/usr/bin/env node
// Establish isolation before Vitest or any application module is imported.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const root=mkdtempSync(join(tmpdir(),'bossmode-test-run-'));
writeFileSync(join(root,'.bossmode-test-sandbox'),'bossmode-test-run-v1\n',{mode:0o600});
const args=process.argv.slice(2);
const child=spawn(process.execPath,[new URL('../node_modules/vitest/vitest.mjs',import.meta.url).pathname,...(args.length?args:['run'])],{
 stdio:'inherit',env:{...process.env,BOSSMODE_DIR:root,BOSSMODE_TEST_ROOT:root},
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error);rmSync(root,{recursive:true,force:true});process.exitCode=1;});
child.on('exit',(code,signal)=>{rmSync(root,{recursive:true,force:true});process.exitCode=code??(signal?1:0);});
