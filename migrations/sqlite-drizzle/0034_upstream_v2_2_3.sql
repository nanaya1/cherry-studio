-- Upstream 0027_knowledge_base_order
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_knowledge_base` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`order_key` text NOT NULL,
	`group_id` text,
	`dimensions` integer,
	`embedding_model_id` text,
	`status` text NOT NULL,
	`error` text,
	`rerank_model_id` text,
	`file_processor_id` text,
	`chunk_size` integer NOT NULL,
	`chunk_overlap` integer NOT NULL,
	`chunk_strategy` text DEFAULT 'structured' NOT NULL,
	`chunk_separator` text DEFAULT '\n\n' NOT NULL,
	`threshold` real,
	`document_count` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `group`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`embedding_model_id`) REFERENCES `user_model`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rerank_model_id`) REFERENCES `user_model`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "knowledge_base_chunk_strategy_check" CHECK("__new_knowledge_base"."chunk_strategy" IN ('structured', 'delimiter')),
	CONSTRAINT "knowledge_base_status_check" CHECK("__new_knowledge_base"."status" IN ('completed', 'failed')),
	CONSTRAINT "knowledge_base_status_error_check" CHECK(
        (
          "__new_knowledge_base"."status" = 'completed'
          AND "__new_knowledge_base"."error" IS NULL
          AND (
            (
              "__new_knowledge_base"."embedding_model_id" IS NOT NULL
              AND "__new_knowledge_base"."dimensions" IS NOT NULL
              AND "__new_knowledge_base"."dimensions" > 0
            )
            OR (
              "__new_knowledge_base"."embedding_model_id" IS NULL
              AND "__new_knowledge_base"."dimensions" IS NULL
            )
          )
        )
        OR (
          "__new_knowledge_base"."status" = 'failed'
          AND "__new_knowledge_base"."error" IS NOT NULL
          AND length(trim("__new_knowledge_base"."error")) > 0
        )
      )
);
--> statement-breakpoint
INSERT INTO `__new_knowledge_base`("id", "name", "order_key", "group_id", "dimensions", "embedding_model_id", "status", "error", "rerank_model_id", "file_processor_id", "chunk_size", "chunk_overlap", "chunk_strategy", "chunk_separator", "threshold", "document_count", "created_at", "updated_at") SELECT "id", "name", 'a0', "group_id", "dimensions", "embedding_model_id", "status", "error", "rerank_model_id", "file_processor_id", "chunk_size", "chunk_overlap", "chunk_strategy", "chunk_separator", "threshold", "document_count", "created_at", "updated_at" FROM `knowledge_base`;--> statement-breakpoint
DROP TABLE `knowledge_base`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_base` RENAME TO `knowledge_base`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `knowledge_base_group_id_order_key_idx` ON `knowledge_base` (`group_id`,`order_key`);
--> statement-breakpoint
-- Upstream 0028_slow_ravenous
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_knowledge_item` (
	`id` text PRIMARY KEY NOT NULL,
	`base_id` text NOT NULL,
	`group_id` text,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`base_id`) REFERENCES `knowledge_base`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_id`,`group_id`) REFERENCES `knowledge_item`(`base_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_item_type_check" CHECK("__new_knowledge_item"."type" IN ('file', 'url', 'note', 'directory')),
	CONSTRAINT "knowledge_item_status_check" CHECK("__new_knowledge_item"."status" IN ('idle', 'preparing', 'processing', 'reading', 'embedding', 'completed', 'failed', 'deleting')),
	CONSTRAINT "knowledge_item_type_status_check" CHECK(
        ("__new_knowledge_item"."type" IN ('url', 'note') AND "__new_knowledge_item"."status" IN ('idle', 'processing', 'reading', 'embedding', 'completed', 'failed', 'deleting'))
        OR ("__new_knowledge_item"."type" = 'file' AND "__new_knowledge_item"."status" IN ('idle', 'preparing', 'processing', 'reading', 'embedding', 'completed', 'failed', 'deleting'))
        OR ("__new_knowledge_item"."type" = 'directory' AND "__new_knowledge_item"."status" IN ('idle', 'preparing', 'processing', 'completed', 'failed', 'deleting'))
      ),
	CONSTRAINT "knowledge_item_status_error_check" CHECK(
        (
          "__new_knowledge_item"."status" IN ('idle', 'preparing', 'processing', 'reading', 'embedding', 'completed', 'deleting')
          AND "__new_knowledge_item"."error" IS NULL
        )
        OR (
          "__new_knowledge_item"."status" = 'failed'
          AND "__new_knowledge_item"."error" IS NOT NULL
          AND length(trim("__new_knowledge_item"."error")) > 0
        )
      )
);
--> statement-breakpoint
INSERT INTO `__new_knowledge_item`("id", "base_id", "group_id", "type", "data", "status", "error", "created_at", "updated_at") SELECT "id", "base_id", "group_id", "type", "data", "status", "error", "created_at", "updated_at" FROM `knowledge_item`;--> statement-breakpoint
DROP TABLE `knowledge_item`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_item` RENAME TO `knowledge_item`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `knowledge_item_base_type_created_idx` ON `knowledge_item` (`base_id`,`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `knowledge_item_base_group_created_idx` ON `knowledge_item` (`base_id`,`group_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_item_baseId_id_unique` ON `knowledge_item` (`base_id`,`id`);
--> statement-breakpoint
-- Upstream 0029_sloppy_pandemic
ALTER TABLE `job` ADD `recovery` text;--> statement-breakpoint
-- Conversions Knowledge started before this column existed get the override it now passes, so a
-- restart abandons them too. Rows are matched the way the result check identifies an item's conversion.
UPDATE `job` SET `recovery` = 'abandon'
WHERE `type` IN ('file-processing.background', 'file-processing.background-local', 'file-processing.remote-poll')
  AND `status` IN ('pending', 'delayed', 'running')
  AND json_extract(`input`, '$.feature') = 'document_to_markdown'
  AND json_extract(`input`, '$.output.kind') = 'path'
  AND json_extract(`input`, '$.context.dataId') IN (SELECT `id` FROM `knowledge_item`);
--> statement-breakpoint
-- Upstream 0030_skill_mirror_export
ALTER TABLE `agent_global_skill` ADD `mirror_enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
-- Upstream 0031_agent_native_contexts
CREATE TABLE `agent_runtime_backend` (
	`id` text PRIMARY KEY NOT NULL,
	`locator` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "agent_runtime_backend_state_check" CHECK("agent_runtime_backend"."state" IN ('creating', 'bound'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runtime_backend_locator_uniq` ON `agent_runtime_backend` (`locator`);--> statement-breakpoint
CREATE TABLE `agent_session_context` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`backend_id` text NOT NULL,
	`native_thread_id` text,
	`binding_state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`backend_id`) REFERENCES `agent_runtime_backend`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_session_context_binding_state_check" CHECK("agent_session_context"."binding_state" IN ('pending', 'bound')),
	CONSTRAINT "agent_session_context_bound_identity_check" CHECK("agent_session_context"."binding_state" != 'bound' OR "agent_session_context"."native_thread_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `agent_session_context_backend_idx` ON `agent_session_context` (`backend_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_context_native_uniq` ON `agent_session_context` (`session_id`,`backend_id`,`native_thread_id`);--> statement-breakpoint
ALTER TABLE `agent_session_message` ADD `input_context_id` text REFERENCES agent_session_context(id);--> statement-breakpoint
ALTER TABLE `agent_session_message` ADD `native_input_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_native_input_uniq` ON `agent_session_message` (`input_context_id`,`native_input_id`);
--> statement-breakpoint
-- Upstream 0032_agent_message_tree
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_session_message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`parent_id` text,
	`data` text NOT NULL,
	`searchable_text` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`model_id` text,
	`message_snapshot` text,
	`stats` text,
	`runtime_resume_token` text,
	`input_context_id` text,
	`native_input_id` text,
	`delivery` text,
	`delivery_status` text,
	`delivery_turn_ref` text,
	`delivery_in_reply_to` text,
	`delivery_sender_session_id` text,
	`fts_rowid` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `user_model`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`input_context_id`) REFERENCES `agent_session_context`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_session_message_role_check" CHECK("__new_agent_session_message"."role" IN ('root', 'user', 'assistant', 'system')),
	CONSTRAINT "agent_session_message_status_check" CHECK("__new_agent_session_message"."status" IN ('pending', 'success', 'error', 'paused')),
	CONSTRAINT "agent_session_message_delivery_status_check" CHECK("__new_agent_session_message"."delivery_status" IS NULL OR "__new_agent_session_message"."delivery_status" IN ('accepted', 'delivering', 'consumed', 'failed')),
	CONSTRAINT "agent_session_message_delivery_turn_ref_check" CHECK(("__new_agent_session_message"."delivery_status" = 'delivering' AND "__new_agent_session_message"."delivery_turn_ref" IS NOT NULL) OR ("__new_agent_session_message"."delivery_status" != 'delivering' AND "__new_agent_session_message"."delivery_turn_ref" IS NULL) OR ("__new_agent_session_message"."delivery_status" IS NULL AND "__new_agent_session_message"."delivery_turn_ref" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_agent_session_message`("id", "session_id", "role", "parent_id", "data", "searchable_text", "status", "model_id", "message_snapshot", "stats", "runtime_resume_token", "input_context_id", "native_input_id", "delivery", "delivery_status", "delivery_turn_ref", "delivery_in_reply_to", "delivery_sender_session_id", "fts_rowid", "created_at", "updated_at") SELECT "id", "session_id", "role", NULL, "data", "searchable_text", "status", "model_id", "message_snapshot", "stats", "runtime_resume_token", "input_context_id", "native_input_id", "delivery", "delivery_status", "delivery_turn_ref", "delivery_in_reply_to", "delivery_sender_session_id", "fts_rowid", "created_at", "updated_at" FROM `agent_session_message`;--> statement-breakpoint
DROP TABLE `agent_session_message`;--> statement-breakpoint
ALTER TABLE `__new_agent_session_message` RENAME TO `agent_session_message`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_native_input_uniq` ON `agent_session_message` (`input_context_id`,`native_input_id`);--> statement-breakpoint
CREATE INDEX `agent_session_message_parent_idx` ON `agent_session_message` (`session_id`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_root_uniq` ON `agent_session_message` (`session_id`) WHERE "agent_session_message"."role" = 'root';--> statement-breakpoint
CREATE INDEX `agent_session_message_session_created_id_idx` ON `agent_session_message` (`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `agent_session_message_created_at_id_idx` ON `agent_session_message` (`created_at` desc,`id` asc);--> statement-breakpoint
CREATE INDEX `agent_session_message_status_idx` ON `agent_session_message` (`status`);--> statement-breakpoint
CREATE INDEX `agent_session_message_model_id_idx` ON `agent_session_message` (`model_id`);--> statement-breakpoint
CREATE INDEX `agent_session_message_delivery_status_idx` ON `agent_session_message` (`delivery_status`);--> statement-breakpoint
CREATE INDEX `agent_session_message_delivery_turn_ref_idx` ON `agent_session_message` (`delivery_turn_ref`);--> statement-breakpoint
CREATE INDEX `agent_session_message_delivery_sender_idx` ON `agent_session_message` (`delivery_sender_session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_delivery_reply_uniq` ON `agent_session_message` (`delivery_in_reply_to`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_fts_rowid_uniq` ON `agent_session_message` (`fts_rowid`);--> statement-breakpoint
ALTER TABLE `agent_session` ADD `active_node_id` text;--> statement-breakpoint
ALTER TABLE `agent_session_context` ADD `anchor_message_id` text;--> statement-breakpoint
ALTER TABLE `agent_session_context` ADD `checkpoint_mapping` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_context_anchor_uniq` ON `agent_session_context` (`session_id`,`anchor_message_id`);
--> statement-breakpoint
-- Upstream 0033_child_context_projection
ALTER TABLE `agent_session` ADD `owner_session_id` text REFERENCES agent_session(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX `agent_session_owner_idx` ON `agent_session` (`owner_session_id`);--> statement-breakpoint
ALTER TABLE `agent_session_context` ADD `parent_context_id` text REFERENCES agent_session_context(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `agent_session_context` ADD `spawn_tool_call_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_context_child_uniq` ON `agent_session_context` (`parent_context_id`,`native_thread_id`);
--> statement-breakpoint
-- Upstream 0034_big_johnny_storm
CREATE TABLE `notification_record` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`category` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`dismissed_at` integer,
	`target` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_record_event_key_idx` ON `notification_record` (`event_key`);--> statement-breakpoint
CREATE INDEX `notification_record_time_idx` ON `notification_record` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `notification_record_category_time_idx` ON `notification_record` (`category`,`created_at`,`id`);
--> statement-breakpoint
-- Upstream 0035_agent_session_task_ownership
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_session` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_session_id` text,
	`type` text DEFAULT 'conversation' NOT NULL,
	`agent_id` text,
	`name` text NOT NULL,
	`is_name_manually_edited` integer DEFAULT false NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text,
	`is_task_reuse_target` integer DEFAULT false NOT NULL,
	`trace_id` text,
	`active_node_id` text,
	`order_key` text NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_session_id`) REFERENCES `agent_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `agent_workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `job_schedule`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_session_task_reuse_owner_check" CHECK("__new_agent_session"."is_task_reuse_target" = 0 OR "__new_agent_session"."task_id" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_agent_session`("id", "owner_session_id", "type", "agent_id", "name", "is_name_manually_edited", "description", "workspace_id", "task_id", "is_task_reuse_target", "trace_id", "active_node_id", "order_key", "last_activity_at", "created_at", "updated_at", "deleted_at") SELECT "id", "owner_session_id", "type", "agent_id", "name", "is_name_manually_edited", "description", "workspace_id", coalesce("task_schedule_id", (
  SELECT job.schedule_id FROM job
  JOIN job_schedule ON job_schedule.id = job.schedule_id
  WHERE job.type = 'agent.task'
    AND coalesce(json_extract(job.metadata, '$.sessionId'), json_extract(job.output, '$.sessionId')) = agent_session.id
  ORDER BY job.created_at DESC, job.id DESC LIMIT 1
)), "task_schedule_id" IS NOT NULL, "trace_id", "active_node_id", "order_key", "last_activity_at", "created_at", "updated_at", "deleted_at" FROM `agent_session`;--> statement-breakpoint
DROP TABLE `agent_session`;--> statement-breakpoint
ALTER TABLE `__new_agent_session` RENAME TO `agent_session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_session_order_key_idx` ON `agent_session` (`order_key`);--> statement-breakpoint
CREATE INDEX `agent_session_task_idx` ON `agent_session` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_task_reuse_uq` ON `agent_session` (`task_id`) WHERE "agent_session"."is_task_reuse_target" = 1;--> statement-breakpoint
CREATE INDEX `agent_session_owner_idx` ON `agent_session` (`owner_session_id`);--> statement-breakpoint
CREATE INDEX `agent_session_last_activity_at_idx` ON `agent_session` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `agent_session_updated_at_idx` ON `agent_session` (`updated_at`);
--> statement-breakpoint
-- Upstream 0036_assistant_avatar
CREATE TABLE `assistant_avatar_file_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`file_entry_id` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_entry_id`) REFERENCES `file_entry`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `assistant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `aafr_entry_id_idx` ON `assistant_avatar_file_ref` (`file_entry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `aafr_source_id_idx` ON `assistant_avatar_file_ref` (`source_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_message_file_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`file_entry_id` text NOT NULL,
	`source_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_entry_id`) REFERENCES `file_entry`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cmfr_role_check" CHECK("__new_chat_message_file_ref"."role" IN ('attachment', 'tool_output', 'author_avatar'))
);
--> statement-breakpoint
INSERT INTO `__new_chat_message_file_ref`("id", "file_entry_id", "source_id", "role", "created_at", "updated_at") SELECT "id", "file_entry_id", "source_id", "role", "created_at", "updated_at" FROM `chat_message_file_ref`;--> statement-breakpoint
DROP TABLE `chat_message_file_ref`;--> statement-breakpoint
ALTER TABLE `__new_chat_message_file_ref` RENAME TO `chat_message_file_ref`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `cmfr_entry_id_idx` ON `chat_message_file_ref` (`file_entry_id`);--> statement-breakpoint
CREATE INDEX `cmfr_source_id_idx` ON `chat_message_file_ref` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cmfr_unique_idx` ON `chat_message_file_ref` (`file_entry_id`,`source_id`,`role`);
--> statement-breakpoint
-- Upstream 0037_agent_avatar
CREATE TABLE `agent_avatar_file_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`file_entry_id` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_entry_id`) REFERENCES `file_entry`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agafr_entry_id_idx` ON `agent_avatar_file_ref` (`file_entry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agafr_source_id_idx` ON `agent_avatar_file_ref` (`source_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_session_message_file_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`file_entry_id` text NOT NULL,
	`source_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_entry_id`) REFERENCES `file_entry`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `agent_session_message`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "asmfr_role_check" CHECK("__new_agent_session_message_file_ref"."role" IN ('attachment', 'author_avatar'))
);
--> statement-breakpoint
INSERT INTO `__new_agent_session_message_file_ref`("id", "file_entry_id", "source_id", "role", "created_at", "updated_at") SELECT "id", "file_entry_id", "source_id", "role", "created_at", "updated_at" FROM `agent_session_message_file_ref`;--> statement-breakpoint
DROP TABLE `agent_session_message_file_ref`;--> statement-breakpoint
ALTER TABLE `__new_agent_session_message_file_ref` RENAME TO `agent_session_message_file_ref`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `asmfr_entry_id_idx` ON `agent_session_message_file_ref` (`file_entry_id`);--> statement-breakpoint
CREATE INDEX `asmfr_source_id_idx` ON `agent_session_message_file_ref` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `asmfr_unique_idx` ON `agent_session_message_file_ref` (`file_entry_id`,`source_id`,`role`);
--> statement-breakpoint
-- Upstream 0038_clammy_jigsaw
ALTER TABLE `agent_session` ADD `model` text REFERENCES user_model(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Upstream 0039_agent_session_tree_backfill
DROP TRIGGER IF EXISTS agent_session_message_ai;
--> statement-breakpoint
-- Only untouched flat archives have no selected head and no parent edges.
CREATE TEMP TABLE agent_session_flat_archive AS
SELECT s.id FROM agent_session s
WHERE s.active_node_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM agent_session_message m WHERE m.session_id = s.id AND m.parent_id IS NOT NULL
);
--> statement-breakpoint
INSERT INTO agent_session_message (id, session_id, role, data, status, fts_rowid, created_at, updated_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  s.id, 'root', '{"parts":[]}', 'success',
  (SELECT coalesce(max(fts_rowid), 0) FROM agent_session_message) + row_number() OVER (ORDER BY s.id),
  s.created_at, s.updated_at
FROM agent_session s JOIN agent_session_flat_archive f ON f.id = s.id
WHERE NOT EXISTS (SELECT 1 FROM agent_session_message m WHERE m.session_id = s.id AND m.role = 'root');
--> statement-breakpoint
WITH ordered AS (
  SELECT m.id, lag(m.id, 1, r.id) OVER (PARTITION BY m.session_id ORDER BY m.created_at, m.id) AS parent_id
  FROM agent_session_message m
  JOIN agent_session_flat_archive f ON f.id = m.session_id
  JOIN agent_session_message r ON r.session_id = m.session_id AND r.role = 'root'
  WHERE m.role != 'root'
)
UPDATE agent_session_message SET parent_id = ordered.parent_id FROM ordered WHERE agent_session_message.id = ordered.id;
--> statement-breakpoint
UPDATE agent_session SET active_node_id = coalesce(
  (SELECT id FROM agent_session_message WHERE session_id = agent_session.id AND role != 'root' ORDER BY created_at DESC, id DESC LIMIT 1),
  (SELECT id FROM agent_session_message WHERE session_id = agent_session.id AND role = 'root')
) WHERE id IN (SELECT id FROM agent_session_flat_archive);
--> statement-breakpoint
DROP TABLE agent_session_flat_archive;
--> statement-breakpoint
-- Foreign keys are disabled during table rebuilds; reject invalid existing edges before copying.
CREATE TEMP TABLE agent_session_tree_integrity (invalid_count INTEGER CHECK (invalid_count = 0));
--> statement-breakpoint
INSERT INTO agent_session_tree_integrity
SELECT count(*) FROM agent_session_message m
WHERE (m.role = 'root') != (m.parent_id IS NULL)
OR (m.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_session_message p WHERE p.id = m.parent_id AND p.session_id = m.session_id
));
--> statement-breakpoint
DROP TABLE agent_session_tree_integrity;
--> statement-breakpoint
-- Fresh databases have not replayed custom SQL yet; upgrades must also index the new empty roots.
CREATE VIRTUAL TABLE IF NOT EXISTS agent_session_message_fts USING fts5(
  searchable_text,
  content='agent_session_message',
  content_rowid='fts_rowid',
  tokenize='trigram'
);
--> statement-breakpoint
INSERT INTO agent_session_message_fts(agent_session_message_fts) VALUES ('rebuild');
--> statement-breakpoint
-- Upstream 0040_agent_session_tree_constraints
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_session_message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`parent_id` text,
	`data` text NOT NULL,
	`searchable_text` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`model_id` text,
	`message_snapshot` text,
	`stats` text,
	`runtime_resume_token` text,
	`input_context_id` text,
	`native_input_id` text,
	`delivery` text,
	`delivery_status` text,
	`delivery_turn_ref` text,
	`delivery_in_reply_to` text,
	`delivery_sender_session_id` text,
	`fts_rowid` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `user_model`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`input_context_id`) REFERENCES `agent_session_context`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`,`parent_id`) REFERENCES `agent_session_message`(`session_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_session_message_root_parent_check" CHECK(("__new_agent_session_message"."role" = 'root') = ("__new_agent_session_message"."parent_id" IS NULL)),
	CONSTRAINT "agent_session_message_role_check" CHECK("__new_agent_session_message"."role" IN ('root', 'user', 'assistant', 'system')),
	CONSTRAINT "agent_session_message_status_check" CHECK("__new_agent_session_message"."status" IN ('pending', 'success', 'error', 'paused')),
	CONSTRAINT "agent_session_message_delivery_status_check" CHECK("__new_agent_session_message"."delivery_status" IS NULL OR "__new_agent_session_message"."delivery_status" IN ('accepted', 'delivering', 'consumed', 'failed')),
	CONSTRAINT "agent_session_message_delivery_turn_ref_check" CHECK(("__new_agent_session_message"."delivery_status" = 'delivering' AND "__new_agent_session_message"."delivery_turn_ref" IS NOT NULL) OR ("__new_agent_session_message"."delivery_status" != 'delivering' AND "__new_agent_session_message"."delivery_turn_ref" IS NULL) OR ("__new_agent_session_message"."delivery_status" IS NULL AND "__new_agent_session_message"."delivery_turn_ref" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_agent_session_message`("id", "session_id", "role", "parent_id", "data", "searchable_text", "status", "model_id", "message_snapshot", "stats", "runtime_resume_token", "input_context_id", "native_input_id", "delivery", "delivery_status", "delivery_turn_ref", "delivery_in_reply_to", "delivery_sender_session_id", "fts_rowid", "created_at", "updated_at") SELECT "id", "session_id", "role", "parent_id", "data", "searchable_text", "status", "model_id", "message_snapshot", "stats", "runtime_resume_token", "input_context_id", "native_input_id", "delivery", "delivery_status", "delivery_turn_ref", "delivery_in_reply_to", "delivery_sender_session_id", "fts_rowid", "created_at", "updated_at" FROM `agent_session_message`;--> statement-breakpoint
DROP TABLE `agent_session_message`;--> statement-breakpoint
ALTER TABLE `__new_agent_session_message` RENAME TO `agent_session_message`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_session_id_uniq` ON `agent_session_message` (`session_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_native_input_uniq` ON `agent_session_message` (`input_context_id`,`native_input_id`);--> statement-breakpoint
CREATE INDEX `agent_session_message_parent_idx` ON `agent_session_message` (`session_id`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_root_uniq` ON `agent_session_message` (`session_id`) WHERE "agent_session_message"."role" = 'root';--> statement-breakpoint
CREATE INDEX `agent_session_message_session_created_id_idx` ON `agent_session_message` (`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `agent_session_message_created_at_id_idx` ON `agent_session_message` (`created_at` desc,`id` asc);--> statement-breakpoint
CREATE INDEX `agent_session_message_status_idx` ON `agent_session_message` (`status`);--> statement-breakpoint
CREATE INDEX `agent_session_message_model_id_idx` ON `agent_session_message` (`model_id`);--> statement-breakpoint
CREATE INDEX `agent_session_message_delivery_status_idx` ON `agent_session_message` (`delivery_status`);--> statement-breakpoint
CREATE INDEX `agent_session_message_delivery_turn_ref_idx` ON `agent_session_message` (`delivery_turn_ref`);--> statement-breakpoint
CREATE INDEX `agent_session_message_delivery_sender_idx` ON `agent_session_message` (`delivery_sender_session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_delivery_reply_uniq` ON `agent_session_message` (`delivery_in_reply_to`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_message_fts_rowid_uniq` ON `agent_session_message` (`fts_rowid`);
--> statement-breakpoint
-- Upstream 0041_agent_session_reply_link
ALTER TABLE `agent_session_message` ADD `reply_id` text;
--> statement-breakpoint
-- MEA:dingtalk-legacy-channels Preserve original delivery identifiers across the upgrade.
UPDATE agent_channel
SET config = json_set(config, '$.legacy_conversation_ids', json('true'),
  '$.robot_code', coalesce(json_extract(config, '$.robot_code'), ''))
WHERE type = 'dingtalk' AND json_valid(config);
