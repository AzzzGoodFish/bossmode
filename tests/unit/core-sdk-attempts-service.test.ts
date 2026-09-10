import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { SdkExecutionAttempt, SdkExecutionService } from "../../src/services/sdk-execution-service.js";

let fixture: ReturnType<typeof coreFixture>;
const owner = "mem_attempt_owner";
const other = "mem_attempt_other";
beforeEach(() => {
  fixture = coreFixture();
  for (const id of [owner, other]) fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,'test','{}',1,1)", id, id, id);
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('r','room','r')");
});
afterEach(() => fixture.close());
function row(id: string) { return fixture.db.get<any>("SELECT * FROM execution_attempts WHERE id=?", id)!; }

describe("SDK execution service SQL boundaries", () => {
  it("interrupts only the targeted live attempt, including concurrent attempts of the same owner", async () => {
    const service = new SdkExecutionService(owner, "r");
    const failed = service.dispatch("input", "pi-sdk:session.prompt");
    const peer = service.dispatch("input", "pi-sdk:session.prompt");
    const otherMember = new SdkExecutionService(other, "r").dispatch("external", "pi-sdk:session.compact");
    await expect(failed.run(async () => { throw new Error("provider failed"); })).rejects.toThrow("provider failed");
    expect(row(failed.id).status).toBe("interrupted");
    expect(row(peer.id).status).toBe("dispatched");
    expect(row(otherMember.id).status).toBe("dispatched");
    peer.settle(); otherMember.settle();
    expect(row(peer.id).status).toBe("acknowledged");
  });

  it("guards interruption by exact attempt ID, member ownership, and incomplete state", () => {
    const attempt = new SdkExecutionService(owner, "r").dispatch("input", "pi-sdk:session.prompt");
    expect(() => new SdkExecutionAttempt(attempt.id, other, fixture.db).interrupt("wrong owner")).toThrow(/rejected/);
    expect(() => new SdkExecutionAttempt("absent", owner, fixture.db).interrupt("missing")).toThrow(/rejected/);
    attempt.settle();
    expect(() => attempt.interrupt("too late")).toThrow(/rejected/);
    expect(row(attempt.id).status).toBe("acknowledged");
  });

  it("never acknowledges a cancelled attempt after successful late settlement", () => {
    const attempt = new SdkExecutionService(owner, "r").dispatch("input", "pi-sdk:session.prompt");
    attempt.interrupt("cancelled"); const endedAt = row(attempt.id).ended_at;
    attempt.settle(); attempt.interrupt("duplicate stop");
    expect(row(attempt.id)).toMatchObject({ status: "interrupted", ended_at: endedAt, diagnosis: expect.stringContaining("cancelled") });
  });

  it("rejects ambient transactions rather than dispatching IO behind an uncommitted outer transaction", () => {
    expect(() => fixture.db.transaction(() => new SdkExecutionService(owner, "r").dispatch("input", "pi-sdk:session.prompt"))).toThrow(/enclosing/);
    expect(fixture.db.all("SELECT * FROM execution_attempts")).toEqual([]);
  });

  it("rolls back dispatch and hook writes together when dispatch commit fails", () => {
    fixture.db.exec("CREATE TABLE parent_hook(attempt_id TEXT, owner_id TEXT REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED)");
    expect(() => new SdkExecutionService(owner, "r").dispatch("input", "pi-sdk:session.prompt", id => {
      fixture.db.run("INSERT INTO parent_hook VALUES(?,'missing')", id);
    })).toThrow(/FOREIGN KEY/);
    expect(fixture.db.all("SELECT * FROM execution_attempts")).toEqual([]);
    expect(fixture.db.all("SELECT * FROM parent_hook")).toEqual([]);
  });

  it("surfaces both call and recording failures; does not invent successful evidence", async () => {
    const attempt = new SdkExecutionService(owner, "r").dispatch("input", "pi-sdk:session.prompt");
    fixture.db.exec("CREATE TRIGGER reject_interrupt BEFORE UPDATE ON execution_attempts WHEN NEW.status='interrupted' BEGIN SELECT RAISE(ABORT,'interrupt SQL failed'); END");
    const error = await attempt.run(async () => { throw new Error("SDK rejected"); }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((e: Error) => e.message)).toEqual(["SDK rejected", "interrupt SQL failed"]);
    expect(row(attempt.id).status).toBe("dispatched");
    fixture.db.exec("DROP TRIGGER reject_interrupt");
    attempt.settle();
    expect(row(attempt.id).status).toBe("interrupted");
  });

  it("restart reading preserves dispatched uncertainty without replay or repairing parent state", () => {
    const service = new SdkExecutionService(owner, "r");
    const attempt = service.dispatch("input", "pi-sdk:session.prompt");
    const before = row(attempt.id);
    fixture.reopen();
    expect(row(attempt.id)).toEqual(before);
    new SdkExecutionService(owner, "r");
    expect(fixture.db.all("SELECT * FROM execution_attempts")).toEqual([before]);
  });
});
