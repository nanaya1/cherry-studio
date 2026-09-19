CREATE TABLE `agent_remote_knowledge_base` (
	`agent_id` text NOT NULL,
	`remote_base_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `remote_base_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `assistant_remote_knowledge_base` (
	`assistant_id` text NOT NULL,
	`remote_base_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`assistant_id`, `remote_base_id`),
	FOREIGN KEY (`assistant_id`) REFERENCES `assistant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `remote_knowledge_service` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`auth_type` text DEFAULT 'bearer' NOT NULL,
	`api_key_encrypted` text,
	`headers` text,
	`timeout_ms` integer DEFAULT 30000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "remote_knowledge_service_auth_type_check" CHECK("remote_knowledge_service"."auth_type" IN ('bearer', 'api_key', 'oauth2'))
);
