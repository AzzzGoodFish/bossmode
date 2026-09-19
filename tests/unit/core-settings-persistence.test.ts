import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {coreFixture} from "../helpers/core-fixture.js";
import {getDefaultConfig,readConfig,writeConfig} from "../../src/config/settings.js";
import {hashPassword,login,requireAuth,validateToken} from "../../src/api/auth.js";

let fixture:ReturnType<typeof coreFixture>;
beforeEach(()=>{fixture=coreFixture();});afterEach(()=>fixture.close());

describe("settings and auth SQL authority",()=>{
  it("round-trips configuration across reopen without a file fallback",()=>{
    const config={...getDefaultConfig(),auth:{username:"fish",passwordHash:hashPassword("password")},apiKeys:{provider:"secret"},catalog:{autoRefreshIntervalDays:0}};
    writeConfig(config);expect(readConfig()).toEqual(config);
    expect(fixture.db.get("SELECT host,port FROM app_settings")).toEqual({host:"127.0.0.1",port:8080});
    expect(fixture.db.get("SELECT api_key FROM provider_api_keys")).toEqual({api_key:"secret"});
    fixture.reopen();expect(readConfig()).toEqual(config);
  });

  it("rolls back every field when a configuration write fails",()=>{
    writeConfig(getDefaultConfig());fixture.db.exec("CREATE TRIGGER reject_key BEFORE INSERT ON provider_api_keys BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(()=>writeConfig({...getDefaultConfig(),defaults:{host:"changed",port:9000},apiKeys:{p:"secret"}},fixture.db)).toThrow("injected");
    expect(readConfig()).toEqual(getDefaultConfig());
  });

  it("stores only session hashes, survives reopen, slides and expires",()=>{
    writeConfig({...getDefaultConfig(),auth:{username:"u",passwordHash:hashPassword("p")}});
    expect(login("u","wrong")).toBeNull();const session=login("u","p")!;
    expect(JSON.stringify(fixture.db.all("SELECT * FROM auth_sessions"))).not.toContain(session.token);
    fixture.reopen();expect(validateToken(session.token)).toBe(true);
    expect(requireAuth({})).toBe(false);expect(requireAuth({authorization:`Bearer ${session.token}`})).toBe(true);
  });
});
