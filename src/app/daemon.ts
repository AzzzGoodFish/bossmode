// Ordinary CLI startup acknowledges preparation before loading application consumers.
import type {BossmodeConfig} from "../kernel/types.js";
const host=process.env.BOSSMODE_HOST||"127.0.0.1";
const port=Number(process.env.BOSSMODE_PORT||"8080");
async function start(initialConfig?:BossmodeConfig){
 try{
  process.send?.({type:"progress",phase:"checking"});
  const {startServer}=await import("./server/index.js");
  await startServer({host,port,initialConfig,onProgress:progress=>process.send?.({type:"progress",...progress})});
  process.send?.({type:"ready",pid:process.pid,host,port,mode:"normal"});
 }catch(error){process.send?.({type:"error",message:(error as Error).message});process.exitCode=1;process.disconnect?.();process.exit(1);}
}
if(process.send){
 process.once("message",(value:unknown)=>{
  if(!value||typeof value!=="object"||!("type" in value)||value.type!=="start")return;
  void start((value as {initialConfig?:BossmodeConfig}).initialConfig);
 });
}else void start();
