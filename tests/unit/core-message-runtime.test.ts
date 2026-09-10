import {it,expect,vi} from "vitest";
import {setupTestWorkspace,createTestServer,closeTestServer,createMockRoom,loginAndGetToken,jsonRequest} from "../helpers/test-server.js";
import {resetMocks,mockPromptFn,mockAbortFn} from "../helpers/mock-runtime.js";
import {DeliveryRepository} from "../../src/storage/repositories/delivery-repository.js";
import {getDatabase} from "../../src/storage/database.js";
setupTestWorkspace();

it("room @all keeps working members undisturbed, including mixed @all/urgent text",async()=>{
  const server=await createTestServer();let release:undefined|(()=>void);
  try{
    resetMocks();const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Broadcast admission",["busy-broadcast","idle-broadcast"]);
    const gate=new Promise<void>(resolve=>release=resolve);let calls=0;
    mockPromptFn.mockImplementation(async()=>{if(++calls===1)await gate;});
    const post=(content:string)=>jsonRequest(server.port,"POST",`/api/rooms/${room.id}/messages`,{token,body:{content}});
    expect((await post("@busy-broadcast initial work")).status).toBe(200);
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));mockAbortFn.mockClear();
    const response=await post("@all FYI !busy-broadcast");expect(response.status,response.body).toBe(200);
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));
    expect(mockAbortFn).not.toHaveBeenCalled();
    const body=JSON.parse(response.body);const message=body.message??body;
    const capture=new DeliveryRepository(getDatabase()).getCapture(room.id,message.id)!;
    expect(capture.snapshot.targets.urgent).toEqual([]);
    expect(capture.snapshot.targets.ordinary.map(actor=>actor.actorKey)).toEqual(room.globalMemberIds);
  }finally{release?.();await closeTestServer(server);}
});

it("HTTP DM posting captures one recipient and invokes the runtime only once",async()=>{
  const server=await createTestServer();
  try{
    resetMocks();const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"DM capture",["dm-capture-owner"]);const id=room.globalMemberIds![0];
    const response=await jsonRequest(server.port,"POST",`/api/dm/${id}/messages`,{token,body:{content:"Direct request"}});expect(response.status,response.body).toBe(200);
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));await new Promise<void>(resolve=>setImmediate(resolve));expect(mockPromptFn).toHaveBeenCalledTimes(1);
    const message=JSON.parse(response.body).message;
    expect(new DeliveryRepository(getDatabase()).getCapture(`dm:${id}`,message.id)?.snapshot).toMatchObject({origin:"user",targets:{ordinary:[],urgent:[],dm:[{actorKey:id,memberId:id}]}});
  }finally{await closeTestServer(server);}
});
