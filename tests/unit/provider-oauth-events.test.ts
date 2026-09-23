import {afterEach,expect,it,vi} from 'vitest';
import {setupTestWorkspace,createTestServer,jsonRequest,loginAndGetToken} from '../helpers/test-server.js';
import {PiAiOAuthLoginAdapter} from '../../src/config/pi-adapt/credentials.js';
import {readModelCredential} from '../../src/config/models.js';
import {ensurePiCatalogWarm} from '../../src/config/catalog.js';
setupTestWorkspace();afterEach(()=>vi.restoreAllMocks());
it('follows SDK choices and input events, treats HTTP input acknowledgment as pending, accepts native non-refreshing OAuth',async()=>{
 await ensurePiCatalogWarm();const server=await createTestServer(),token=await loginAndGetToken(server.port);
 let finish!:()=>void;const gate=new Promise<void>(r=>finish=r);
 vi.spyOn(PiAiOAuthLoginAdapter.prototype,'login').mockImplementation(async(_provider,events)=>{
  const route=await events.onSelect({message:'选择授权方式',options:[{id:'browser',label:'浏览器'},{id:'device',label:'设备码'}]});expect(route).toBe('browser');
  const site=await events.onPrompt({message:'企业站点（可留空）',allowEmpty:true});expect(site).toBe('');
  events.onAuth({url:'https://auth.example.test/authorize?state=fixture'});await events.onManualCodeInput!();await gate;
  return {access:'test-only-openrouter-key',refresh:'',expires:Number.MAX_SAFE_INTEGER};
 });
 const req=(method:string,path:string,body?:unknown)=>jsonRequest(server.port,method,path,{token,body});
 let response=await req('POST','/api/model-credential-profiles/oauth/start',{providerId:'openrouter',name:'OAuth event fixture'});expect(response.status,response.body).toBe(200);let job=JSON.parse(response.body);const path=`/api/model-credential-profiles/oauth/${job.id}`;expect(job.inputRequested).toBe(true);expect(job.selectPrompt.options).toHaveLength(2);
 await req('POST',path+'/input',{code:'browser'});job=JSON.parse((await req('GET',path)).body);expect(job.allowEmpty).toBe(true);expect(job.inputRequested).toBe(true);
 await req('POST',path+'/input',{code:''});job=JSON.parse((await req('GET',path)).body);expect(job.authUrl).toContain('state=fixture');expect(job.inputRequested).toBe(true);
 response=await req('POST',path+'/input',{code:'code-fixture'});expect(JSON.parse(response.body).status).toBe('starting');expect(JSON.parse(response.body).inputRequested).toBe(false);
 finish();await vi.waitFor(async()=>{job=JSON.parse((await req('GET',path)).body);expect(job.status).toBe('completed');});
 expect(readModelCredential(job.profileId,'openrouter')).toEqual({type:'oauth',access:'test-only-openrouter-key',refresh:'',expires:Number.MAX_SAFE_INTEGER});expect(JSON.stringify(job)).not.toContain('test-only-openrouter-key');
});
it('reports secret inputs and cancels a pending native authorization without saving',async()=>{
 await ensurePiCatalogWarm();const server=await createTestServer(),token=await loginAndGetToken(server.port);
 vi.spyOn(PiAiOAuthLoginAdapter.prototype,'login').mockImplementation(async(_provider,events)=>{await events.onPrompt({message:'额外认证输入',secret:true});return {access:'not-saved',refresh:'r',expires:1};});
 const response=await jsonRequest(server.port,'POST','/api/model-credential-profiles/oauth/start',{token,body:{providerId:'openrouter',name:'cancel fixture'}});expect(response.status,response.body).toBe(200);const job=JSON.parse(response.body);expect(job.inputSecret).toBe(true);
 const cancel=await jsonRequest(server.port,'POST',`/api/model-credential-profiles/oauth/${job.id}/cancel`,{token});expect(JSON.parse(cancel.body).status).toBe('cancelled');expect(JSON.parse(cancel.body).profileId).toBeUndefined();
});
