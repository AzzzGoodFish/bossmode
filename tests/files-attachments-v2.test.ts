import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importAttachments } from "../src/files/attachments.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("imports only regular files inside host-authorized roots", async () => {
  const allowed = mkdtempSync(join(tmpdir(), "bossmode-attachment-allowed-"));
  const outside = mkdtempSync(join(tmpdir(), "bossmode-attachment-outside-"));
  roots.push(allowed, outside);
  const accepted = join(allowed, "report.txt");
  const rejected = join(outside, "secret.txt");
  writeFileSync(accepted, "retained");
  writeFileSync(rejected, "private");

  const outcomes = await importAttachments(
    [accepted, rejected], { kind: "room", roomId: "room-attachment-v2" }, [allowed], 1024,
  );
  expect(outcomes[0]).toMatchObject({ ok: true, originalFilename: "report.txt", size: 8 });
  expect(readFileSync((outcomes[0] as { absolutePath: string }).absolutePath, "utf8")).toBe("retained");
  expect(outcomes[1]).toMatchObject({ ok: false, path: rejected });
});
