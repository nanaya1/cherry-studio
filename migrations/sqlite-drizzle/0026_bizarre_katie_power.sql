CREATE TABLE `skill_catalog_industry` (
	`skill_id` text NOT NULL,
	`industry_code` text NOT NULL,
	PRIMARY KEY(`skill_id`, `industry_code`),
	FOREIGN KEY (`skill_id`) REFERENCES `skill_catalog`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`industry_code`) REFERENCES `skill_industry`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_catalog_industry_skill_id_idx` ON `skill_catalog_industry` (`skill_id`);--> statement-breakpoint
CREATE INDEX `skill_catalog_industry_industry_code_idx` ON `skill_catalog_industry` (`industry_code`);--> statement-breakpoint
CREATE TABLE `skill_catalog_professional_dimension` (
	`skill_id` text NOT NULL,
	`professional_dimension_code` text NOT NULL,
	PRIMARY KEY(`skill_id`, `professional_dimension_code`),
	FOREIGN KEY (`skill_id`) REFERENCES `skill_catalog`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`professional_dimension_code`) REFERENCES `skill_professional_dimension`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_catalog_pd_skill_id_idx` ON `skill_catalog_professional_dimension` (`skill_id`);--> statement-breakpoint
CREATE INDEX `skill_catalog_pd_code_idx` ON `skill_catalog_professional_dimension` (`professional_dimension_code`);--> statement-breakpoint
CREATE TABLE `skill_catalog_sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_source` text NOT NULL,
	`schema_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`content_hash` text NOT NULL,
	`synced_at` integer NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	CONSTRAINT "skill_catalog_sync_state_source_check" CHECK("skill_catalog_sync_state"."snapshot_source" IN ('bundled', 'override')),
	CONSTRAINT "skill_catalog_sync_state_status_check" CHECK("skill_catalog_sync_state"."status" IN ('ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `skill_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`industry_scope` text NOT NULL,
	`logo` text,
	`artifact` text NOT NULL,
	`status` text NOT NULL,
	`sort_order` integer NOT NULL,
	`snapshot_source` text NOT NULL,
	`catalog_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "skill_catalog_scope_check" CHECK("skill_catalog"."industry_scope" IN ('universal', 'specific')),
	CONSTRAINT "skill_catalog_status_check" CHECK("skill_catalog"."status" IN ('draft', 'published', 'disabled')),
	CONSTRAINT "skill_catalog_source_check" CHECK("skill_catalog"."snapshot_source" IN ('bundled', 'override'))
);
--> statement-breakpoint
CREATE INDEX `skill_catalog_status_idx` ON `skill_catalog` (`status`);--> statement-breakpoint
CREATE INDEX `skill_catalog_snapshot_source_idx` ON `skill_catalog` (`snapshot_source`);--> statement-breakpoint
CREATE TABLE `skill_catalog_translation` (
	`skill_id` text NOT NULL,
	`locale` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	PRIMARY KEY(`skill_id`, `locale`),
	FOREIGN KEY (`skill_id`) REFERENCES `skill_catalog`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skill_industry` (
	`code` text PRIMARY KEY NOT NULL,
	`sort_order` integer NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skill_industry_is_enabled_idx` ON `skill_industry` (`is_enabled`);--> statement-breakpoint
CREATE TABLE `skill_industry_translation` (
	`industry_code` text NOT NULL,
	`locale` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`industry_code`, `locale`),
	FOREIGN KEY (`industry_code`) REFERENCES `skill_industry`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skill_professional_dimension` (
	`code` text PRIMARY KEY NOT NULL,
	`sort_order` integer NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skill_professional_dimension_is_enabled_idx` ON `skill_professional_dimension` (`is_enabled`);--> statement-breakpoint
CREATE TABLE `skill_professional_dimension_translation` (
	`professional_dimension_code` text NOT NULL,
	`locale` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`professional_dimension_code`, `locale`),
	FOREIGN KEY (`professional_dimension_code`) REFERENCES `skill_professional_dimension`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agent_global_skill` ADD `catalog_skill_id` text;--> statement-breakpoint
ALTER TABLE `agent_global_skill` ADD `catalog_version` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_global_skill_catalog_skill_id_unique` ON `agent_global_skill` (`catalog_skill_id`);