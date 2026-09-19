import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { storeRoom } from "../src/chat/conversations.js";
import { createBossmodeSdkTools } from "../src/agent/runtime/tools.js";
import { wireChatHttp } from "../src/app/wire.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function setup() {
  const fixture = coreFixture(); fixtures.push(fixture);
  fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "mem_tools", "Tools", "tools", "general", "{}", 1, 1,
  );
  storeRoom({ id: "rm_tools", name: "Tools room", members: [], globalMemberIds: ["mem_tools"], createdAt: 1 }, fixture.db);
  return fixture;
}

describe("explicit chat tools without current source v2", () => {
  it("authorizes an explicit target independently and rejects only implicit-current calls", async () => {
    const fixture = setup();
    const disconnect = wireChatHttp();
    const tools = createBossmodeSdkTools({ memberId: "mem_tools", resolveSourceRef: () => null });
    const send = tools.find(tool => tool.name === "chat_send")!;
    const read = tools.find(tool => tool.name === "chat_read")!;

    await expect(send.execute("send", { to: "room:rm_tools", message: "explicit target" } as any)).resolves.toBeTruthy();
    await expect(read.execute("read", { chat: "room:rm_tools", limit: 10 } as any)).resolves.toBeTruthy();
    expect(fixture.db.get<{ content: string }>("SELECT content FROM messages WHERE scope_id='rm_tools' ORDER BY seq DESC LIMIT 1")?.content).toBe("explicit target");
    await expect(send.execute("implicit", { message: "no current chat" } as any)).rejects.toThrow("current chat or an explicit target");
    disconnect();
  });
});
