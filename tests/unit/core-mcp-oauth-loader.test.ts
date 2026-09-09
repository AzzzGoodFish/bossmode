import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("loads the native ESM factory with public SDK inline-extension construction and reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-oauth-loader-"));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
      import { createMcpAdapter } from './vendor/pi-mcp-adapter/host-factory.js';
      let accesses = 0;
      const authStorage = {
        read() { accesses++; throw new Error('unexpected credential read'); },
        write() { accesses++; throw new Error('unexpected credential write'); },
        remove() { accesses++; throw new Error('unexpected credential delete'); },
        transaction() { accesses++; throw new Error('unexpected credential transaction'); },
      };
      assert.throws(() => createMcpAdapter({}), /authStorage is required/);
      const loader = new DefaultResourceLoader({
        cwd: process.env.FIXTURE_ROOT, agentDir: process.env.FIXTURE_ROOT,
        settingsManager: SettingsManager.inMemory({}),
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [{ name: 'pi-mcp-adapter', factory: createMcpAdapter({ authStorage }) }],
      });
      for (let i = 0; i < 2; i++) {
        await loader.reload();
        const result = loader.getExtensions();
        assert.deepEqual(result.errors, []);
        assert.equal(result.extensions.length, 1);
        assert.equal(result.extensions[0].tools.has('mcp'), true);
        assert.equal(result.extensions[0].flags.has('mcp-config'), true);
        assert.equal(result.extensions[0].commands.has('mcp-auth'), true);
      }
      assert.equal(accesses, 0);
      assert.equal(existsSync(process.env.MCP_OAUTH_DIR), false);
      console.log('native-loader-ok');
    `], { cwd: process.cwd(), env: { ...process.env, FIXTURE_ROOT: root, HOME: root, MCP_DIRECT_TOOLS: "__none__", MCP_OAUTH_DIR: join(root, "forbidden-oauth") }, timeout: 30000 });
    expect(stdout).toContain("native-loader-ok");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 35000);
