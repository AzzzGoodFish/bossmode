import { readConfig, configExists } from "../../src/config/settings.js";
import { validateToken } from "../../src/api/auth.js";
import { getBossmodeDir } from "../../src/files/layout.js";

import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "../../src/data/database.js";

import { readPidFile } from "../../src/app/pid.js";
import { readMcpConfigText, readMemberMcpConfig } from "../../src/member/mcp/mcp-settings.js";
import { getCatalog } from "../../src/config/catalog.js";
import { loadModelCredentialProfiles } from "../../src/config/models.js";

import { readWorkspaces } from "../../src/member/workspaces/workspace-registry.js";
import { readMemberSshPublicKey, memberSshKeyPath } from "../../src/member/workspaces/ssh-keygen.js";

it("imports every settings consumer without initializing storage; only path/PID helpers work before boot",()=>{
  expect(()=>getDatabase()).toThrow("bootstrap");
  expect(getBossmodeDir()).toBe(process.env.BOSSMODE_DIR);
  expect(memberSshKeyPath("member")).toBe(join(getBossmodeDir(),"members/member/ssh/id_ed25519"));
  expect(readPidFile()).toBeNull();
  for(const call of [readConfig,configExists,readMcpConfigText,()=>readMemberMcpConfig("a"),getCatalog,loadModelCredentialProfiles,()=>validateToken("token"),()=>readWorkspaces("a"),()=>readMemberSshPublicKey("a")]) expect(call).toThrow("bootstrap");
  for(const filename of ["bossmode.db","core.db","config.json","model-credentials.json","pi-catalog-remote.json"])expect(existsSync(join(getBossmodeDir(),filename))).toBe(false);
});
