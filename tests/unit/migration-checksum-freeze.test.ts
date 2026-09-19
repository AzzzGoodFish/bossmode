import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { coreStorageMigrations } from "../../src/data/schema.js";

/**
 * Frozen sha256 of every registered migration's SQL text.
 *
 * Applied migrations are checksum-verified against `storage_schema_versions` in every
 * existing database (validateStorageMigrationHistory in src/data/database.ts).
 * Editing any byte of an applied migration's SQL — even a comment added for clarity —
 * makes all previously converted databases refuse to start. That happened on
 * 2026-09-11: comments added inside core-base-v1 / core-conversations-v1 broke every
 * 0.24.x database until the bytes were restored (release blocker).
 *
 * The first fourteen entries equal the checksums recorded by real 0.24.x databases
 * and the published 0.24.1 artifact (tar sha256 4298fb59…).
 *
 * Rules:
 * - Never modify an entry below for an existing migration. Fix the SQL bytes instead.
 * - When adding a brand-new migration, append its hash here in the same commit.
 * - Comments about a migration belong OUTSIDE its SQL template string.
 */
const FROZEN: Record<string, string> = {
  "core-base-v1": "9710ae74e304faad4037de64a8ade6b01200f136b7c8b854bdab8867371b6770",
  "core-members-v1": "3c6765f45c75309648320b6b937a5e4228d5bb2c0aaffa64f1e1f6e788d5c3be",
  "core-settings-v1": "50a532203b4d3b8675af4e8fd4bd8c160ddb332d9467c181c1af0fbf81bc3c7b",
  "core-conversations-v1": "91b68a822f4f7b985f181632963d49d0778df36c7932ee35f94a36285f7c0beb",
  "core-messages-v1": "00b7491f4ff324989395863922c0eaa0bbdc3a16e838c4ccb80a81a9df54fcfe",
  "core-event-source-v1": "757a648e9f1418efc89030cc8f5fb8401df2b6d0a0cff5ed10bd868e34f2f18f",
  "core-execution-v1": "91924d38fab91d2740081a7a2be342323d6bc15b8595b37349ab6363f07ddbdd",
  "core-assets-v1": "c6bfd384b42f7b6fcac3da32aa4a0924f6107b96f0794d03fcb24de21d7f3e5a",
  "core-templates-v1": "cdae5f8dafa8cbc9f128eff6f538f25affea22cc07695aa735b593963cc12cf6",
  "core-member-archives-v1": "e0f094f057060b6874daa20ffa24757b5a375bc38596636f1261a706e20314f0",
  "core-mcp-oauth-v1": "227946ea21347379db0a178fc3477cb2ddbd6876b28f2639b4d72064cfeb772b",
  "core-delivery-v1": "132e9e82a6c56f7dc79c77a8bb676795673fc026efff0458fe1205a0e1d07df6",
  "core-message-archives-v1": "94a8c958fe57925b609979a8d6678609d2e1ab61858f01a0f655372298713cfa",
  "core-runtime-inputs-v1": "60c93b0970cb8e946faa1c30536438935a3b1056278b92fa615599e3b2060ff3",
  "core-task-retirement-v1": "4581f58c3c016c485193607aa480002fdc6f776f1acbb1d22c01d88d4f096f67",
  "core-topic-retirement-v1": "8f62b96fee80b6381d139c53219200305e56c471acd4b186769478ad907f9255",
  "core-background-retirement-v1": "f5a86b854abe4cda1772a0240a85a96734936581474061251fc102279b6bfe03",
  "core-member-session-v1": "9c45b7aeb976bfe823ecd95936cd00fa1b65a6a2635f2fc9bf2c8155c1289b5b",
  "core-member-runtime-state-v1": "52df6c1dd63eacffaa4ea7361e0712dbd662d2d55944cd0903b26e0ab99fb2b3",
  "core-room-description-v1": "d30beb635994ebe782267241168d8b2d70d3fb155178121d48c508e42f1d350c",
  "core-mm-scope-v1": "cbf40b2e5aa35de729996748289fb309d202b3eed0f682cd332ccd8aac70b68e",
  "core-short-ids-v1": "e2070b0617adef8605a330806a9cea4e62c263ecf729385a4dc1c6ceb165bba7",
  "core-agent-queue-v2": "033658c102b3b8bd354ad837c39bc5428bc20b64be79fe9fbe314b5a9066fc42",
};

describe("migration checksum freeze", () => {
  it("every registered migration matches its frozen sha256", () => {
    for (const migration of coreStorageMigrations) {
      const expected = FROZEN[migration.id];
      expect(expected, `missing frozen checksum for ${migration.id}`).toBeDefined();
      expect(createHash("sha256").update(migration.sql).digest("hex"), migration.id).toBe(expected);
    }
  });

  it("has no frozen entry without a registered migration", () => {
    const ids = new Set(coreStorageMigrations.map((m) => m.id));
    for (const id of Object.keys(FROZEN)) expect(ids.has(id), id).toBe(true);
  });
});
