import {afterEach,describe,expect,it} from "vitest";
import {aggregateUsageRows,appendMemberEvent,importHistoricalEvent,readAgentEvent,rebuildEventAggregates,type UsageRow} from "../../src/agent/events.js";
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
  it("associates immutable historical room usage through the persisted short-ID map",()=>{
    const fixture=coreFixture();fixtures.push(fixture);
    const room=createRoom("Current Room",[]),ts=Date.UTC(2026,8,19);
    fixture.db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES('room',?,?,?)","legacy-room",room.id,ts);
    const event={type:"message_end",ts,model:"legacy/model",usage:{inputTokens:4,outputTokens:2,cacheRead:1,cacheWrite:0,cost:0.5}} as any;
    importHistoricalEvent(fixture.db,{id:"legacy-room-usage",sourceKey:"legacy-room",ownerKey:"unknown-owner",sourceSeq:1,event,ts});
    importHistoricalEvent(fixture.db,{id:"unrelated-usage",sourceKey:"unrelated-room",ownerKey:"unknown-owner",sourceSeq:1,event:{...event,usage:{...event.usage,inputTokens:7}},ts});
    rebuildEventAggregates(fixture.db);
    const before=readAgentEvent("legacy-room-usage");
    const rawBefore=fixture.db.get("SELECT historical_source_key,historical_owner_key,historical_seq,source_ref,payload_json FROM agent_events WHERE id=?","legacy-room-usage");
    const receiptsBefore=fixture.db.all("SELECT * FROM event_usage_receipts ORDER BY event_id");

    const report=getRoomUsageReport(room.id,{from:"2026-09-19",to:"2026-09-19",model:"legacy/model"})!;
    expect(report.kpis).toMatchObject({inputTokens:4,outputTokens:2,cacheRead:1,turns:1});
    expect(report.breakdown).toEqual([]);
    expect(getRoomUsageReport(room.id,{member:"mem_missing"})!.kpis.turns).toBe(0);
    expect(getRoomUsageReport(room.id,{model:"other/model"})!.kpis.turns).toBe(0);
    const platform=getPlatformUsageReport();
    expect(platform.kpis.inputTokens).toBe(11);
    expect(platform.byRoom).toEqual(expect.arrayContaining([
      expect.objectContaining({roomId:room.id,roomName:"Current Room",inputTokens:4}),
      expect.objectContaining({roomId:"unrelated-room",inputTokens:7}),
    ]));
    expect(platform.byRoom.some(bucket=>bucket.roomId==="legacy-room")).toBe(false);
    expect(readAgentEvent("legacy-room-usage")).toEqual(before);
    expect(fixture.db.get("SELECT historical_source_key,historical_owner_key,historical_seq,source_ref,payload_json FROM agent_events WHERE id=?","legacy-room-usage")).toEqual(rawBefore);
    expect(fixture.db.all("SELECT * FROM event_usage_receipts ORDER BY event_id")).toEqual(receiptsBefore);
  });

  it("returns no room rows when all otherwise matching aliases are ambiguous",()=>{
    const fixture=coreFixture();fixtures.push(fixture);
    const first=createRoom("First",[]),second=createRoom("Second",[]),ts=Date.UTC(2026,8,19);
    fixture.db.run("INSERT INTO id_migration_map(kind,old_id,new_id,ts) VALUES('room',?,?,?)",first.id,second.id,ts);
    importHistoricalEvent(fixture.db,{id:"ambiguous-usage",sourceKey:first.id,ownerKey:"unknown-owner",sourceSeq:1,event:{type:"message_end",ts,model:"legacy/model",usage:{inputTokens:9,outputTokens:0,cacheRead:0,cacheWrite:0,cost:0}} as any,ts});
    rebuildEventAggregates(fixture.db);

    expect(getRoomUsageReport(first.id)!.kpis.turns).toBe(0);
    expect(getRoomUsageReport(second.id)!.kpis.turns).toBe(0);
    expect(getPlatformUsageReport().kpis).toMatchObject({inputTokens:9,turns:1});
  });

  it("joins member and room metadata, filters, and zero-fills reports",()=>{
    const fixture=coreFixture();fixtures.push(fixture);
    fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)","mem_a","Alice","alice","developer","{}",1,1);
    const room=createRoom("Room A",[]);
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
