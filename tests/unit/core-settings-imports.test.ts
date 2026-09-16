import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "../../src/data/database.js";
import { getBossmodeDir, getConfigPath, readPidFile, readConfig, configExists } from "../../src/shared/config.js";
import { readMcpConfigText, readMemberMcpConfig } from "../../src/shared/mcp-settings.js";
import { getCatalog } from "../../src/engine/model-catalog.js";
import { loadModelCredentialProfiles } from "../../src/engine/model-credentials.js";
import { validateToken } from "../../src/services/auth-service.js";
import { readWorkspaces } from "../../src/workspace/workspace-registry.js";
import { readMemberSshPublicKey, memberSshKeyPath } from "../../src/workspace/ssh-keygen.js";

it("imports every settings consumer without initializing storage; only path/PID helpers work before boot",()=>{
  expect(()=>getDatabase()).toThrow("bootstrap");
  expect(getBossmodeDir()).toBe(process.env.BOSSMODE_DIR);
  expect(getConfigPath()).toBe(join(getBossmodeDir(),"config.json"));
  expect(memberSshKeyPath("member")).toBe(join(getBossmodeDir(),"members/member/ssh/id_ed25519"));
  expect(readPidFile()).toBeNull();
  for(const call of [readConfig,configExists,readMcpConfigText,()=>readMemberMcpConfig("a"),getCatalog,loadModelCredentialProfiles,()=>validateToken("token"),()=>readWorkspaces("a"),()=>readMemberSshPublicKey("a")]) expect(call).toThrow("bootstrap");
  for(const filename of ["bossmode.db","core.db","config.json","model-credentials.json","pi-catalog-remote.json"])expect(existsSync(join(getBossmodeDir(),filename))).toBe(false);
});
