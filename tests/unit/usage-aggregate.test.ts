import {afterEach,describe,expect,it} from "vitest";
import {aggregateUsageRows,appendMemberEvent,type UsageRow} from "../../src/agent/events.js";
import {getPlatformUsageReport,getRoomUsageReport} from "../../src/app/usage-actions.js";
import {createRoom} from "../../src/chat/conversations.js";
import {coreFixture} from "../helpers/core-fixture.js";

function row(values:Partial<UsageRow>={}):UsageRow{return {
  memberId:"mem_a",historicalOwnerKey:null,sourceRef:"room:room-a",historicalSourceKey:null,
  date:"2026-07-24",model:"a/x",inputTokens:0,outputTokens:0,cacheRead:0,cacheWrite:0,cost:0,turns:1,...values,
};}
const fixtures:ReturnType<typeof coreFixture>[]=[];
afterEach(()=>{for(const fixture of fixtures.splice(0))fixture.close();});

describe("agent usage aggregation",()=>{
  it("aggregates facts without member or chat dependencies",()=>{
    const aggregate=aggregateUsageRows([
      row({inputTokens:300,cacheRead:100,cost:1}),
      row({memberId:"mem_b",model:"b/y",inputTokens:50,outputTokens:10}),
      row({memberId:null,historicalOwnerKey:"legacy",inputTokens:40}),
    ]);
    expect(aggregate.kpis).toMatchObject({inputTokens:390,outputTokens:10,cacheRead:100,turns:3});
    expect(aggregate.kpis.cacheHitRate).toBeCloseTo(100/490);
    expect(aggregate.series[0].byModel["a/x"].inputTokens).toBe(340);
    expect(aggregate.byMemberModel.map(item=>item.memberId).sort()).toEqual(["mem_a","mem_b"]);
  });
});

describe("app usage reports",()=>{
  it("joins member and room metadata, filters, and zero-fills reports",()=>{
    const fixture=coreFixture();fixtures.push(fixture);
    fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)","mem_a","Alice","alice","developer","{}",1,1);
    const room=createRoom("Room A",undefined,[],[]);
    appendMemberEvent({id:"usage-a",memberId:"mem_a",sourceRef:`room:${room.id}`,event:{
      type:"message_end",ts:Date.UTC(2026,6,24),model:"a/x",usage:{inputTokens:30,outputTokens:2,cacheRead:10,cacheWrite:0,cost:0.5},
    } as any});
    const report=getRoomUsageReport(room.id,{from:"2026-07-23",to:"2026-07-24",agent:"developer"})!;
    expect(report.kpis).toMatchObject({inputTokens:30,outputTokens:2,cacheRead:10,turns:1});
    expect(report.series.map(point=>point.date)).toEqual(["2026-07-23","2026-07-24"]);
    expect(report.series[1].byAgent).toEqual({developer:42});
    expect(report.breakdown[0]).toMatchObject({memberId:"mem_a",memberName:"Alice",agent:"developer",model:"a/x"});
    expect(getPlatformUsageReport({model:"a/x"}).byRoom[0]).toMatchObject({roomId:room.id,roomName:"Room A",inputTokens:30});
    expect(getRoomUsageReport("missing")).toBeNull();
  });
});
