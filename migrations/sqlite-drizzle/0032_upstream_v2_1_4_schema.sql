ALTER TABLE `agent_session` ADD `type` text DEFAULT 'conversation' NOT NULL;
--> statement-breakpoint
UPDATE `agent_session`
SET `type` = 'background'
WHERE `id` IN (
  SELECT json_extract(`job`.`metadata`, '$.sessionId')
  FROM `job`
  JOIN `job_schedule` ON `job_schedule`.`id` = `job`.`schedule_id`
  WHERE `job`.`type` = 'agent.task'
    AND json_extract(`job`.`input`, '$.prompt') = '__heartbeat__'
    AND json_extract(`job_schedule`.`job_input_template`, '$.prompt') = '__heartbeat__'
    -- Only the two names sync mints: `heartbeat_<agentId>`, and the create-race
    -- disambiguation `heartbeat_<agentId>__<8 lowercase hex>`.
    AND (
      `job_schedule`.`name` = 'heartbeat_' || json_extract(`job_schedule`.`job_input_template`, '$.agentId')
      OR (
        substr(
          `job_schedule`.`name`,
          1,
          length('heartbeat_') + length(json_extract(`job_schedule`.`job_input_template`, '$.agentId')) + 2
        ) = 'heartbeat_' || json_extract(`job_schedule`.`job_input_template`, '$.agentId') || '__'
        AND substr(
          `job_schedule`.`name`,
          length('heartbeat_') + length(json_extract(`job_schedule`.`job_input_template`, '$.agentId')) + 3
        ) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    )
)
AND NOT EXISTS (
  SELECT 1 FROM `job`
  WHERE json_extract(`metadata`, '$.sessionId') = `agent_session`.`id`
    AND (`type` != 'agent.task' OR json_extract(`input`, '$.prompt') IS NOT '__heartbeat__')
);
--> statement-breakpoint
CREATE TABLE `remote_command` (
  `device_id` text NOT NULL,
  `grant_id` text NOT NULL,
  `command_id` text NOT NULL,
  `method` text NOT NULL,
  `identity_digest` text NOT NULL,
  `status` text NOT NULL,
  `session_id` text,
  `execution_id` text,
  `result` text,
  `error` text,
  `admitted_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`device_id`, `grant_id`, `command_id`),
  FOREIGN KEY (`device_id`) REFERENCES `api_gateway_paired_device`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `api_gateway_paired_device_token_hash_unique_idx`;
--> statement-breakpoint
ALTER TABLE `api_gateway_paired_device` ADD `peer_identity` text;
--> statement-breakpoint
ALTER TABLE `api_gateway_paired_device` ADD `configuration_grant_id` text;
--> statement-breakpoint
ALTER TABLE `api_gateway_paired_device` ADD `agent_grant_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `api_gateway_paired_device_peer_identity_unique_idx` ON `api_gateway_paired_device` (`peer_identity`);
--> statement-breakpoint
ALTER TABLE `api_gateway_paired_device` DROP COLUMN `token_hash`;
--> statement-breakpoint
CREATE TABLE `diagnostic_report` (
  `report_id` text PRIMARY KEY NOT NULL,
  `submitted_at` integer NOT NULL,
  `processing_status` text,
  `last_checked_at` integer,
  CONSTRAINT "diagnostic_report_processing_status_check" CHECK("diagnostic_report"."processing_status" IN ('pending', 'unprocessed', 'investigating', 'resolved', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `diagnostic_report_submitted_at_idx` ON `diagnostic_report` (`submitted_at`,`report_id`);
