import { baseStorageMigration } from "./base-schema.js";
import { membersMigration } from "./schema/members.js";
import { settingsMigration } from "./schema/settings.js";
import { conversationsMigration } from "./schema/conversations.js";
import { messagesMigration, eventSourceMigration } from "./schema/messages.js";
import { executionMigration } from "./schema/execution.js";
import { assetsMigration } from "./schema/assets.js";
import { templatesMigration } from "./schema/templates.js";
import { memberArchivesMigration } from "./schema/member-archives.js";
import { mcpOauthMigration } from "./schema/mcp-oauth.js";
import { deliveryMigration } from "./schema/delivery.js";
import { messageArchivesMigration } from "./schema/message-archives.js";
import { runtimeInputsMigration } from "./schema/runtime-inputs.js";
import { taskRetirementMigration } from "./schema/task-retirement.js";
import { topicRetirementMigration } from "./schema/topic-retirement.js";
import { backgroundRetirementMigration } from "./schema/background-retirement.js";
import type { StorageMigration } from "./database.js";

// The sole ordered schema plan. Initial conversion runs on the upgrade staging DB,
// never against a running legacy writer or through a repository getter.
export const coreStorageMigrations: readonly StorageMigration[] = Object.freeze([
  baseStorageMigration, membersMigration, settingsMigration, conversationsMigration,
  messagesMigration, eventSourceMigration, executionMigration, assetsMigration,
  templatesMigration, memberArchivesMigration, mcpOauthMigration, deliveryMigration,
  messageArchivesMigration, runtimeInputsMigration, taskRetirementMigration,
  topicRetirementMigration, backgroundRetirementMigration,
]);
export const CORE_STORAGE_FORMAT = 1;
