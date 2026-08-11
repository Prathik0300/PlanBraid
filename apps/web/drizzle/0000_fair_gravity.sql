CREATE TABLE `coding_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`label` text NOT NULL,
	`safe_path` text NOT NULL,
	`branch` text DEFAULT 'main' NOT NULL,
	`kind` text DEFAULT 'local' NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_spaces_project_fingerprint` ON `coding_spaces` (`project_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_spaces_project` ON `coding_spaces` (`project_id`);--> statement-breakpoint
CREATE TABLE `dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`from_work_item_id` text NOT NULL,
	`to_work_item_id` text NOT NULL,
	`type` text DEFAULT 'blocks' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dependencies_edge` ON `dependencies` (`from_work_item_id`,`to_work_item_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_dependencies_to` ON `dependencies` (`to_work_item_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`uri` text,
	`result` text,
	`source_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_item` ON `evidence` (`work_item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`scope` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`response` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_idempotency_scope_key` ON `idempotency_records` (`scope`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`sequence` integer,
	`status` text DEFAULT 'started' NOT NULL,
	`outcome` text,
	`summary` text DEFAULT '' NOT NULL,
	`reconciliation` text DEFAULT 'needs_reconciliation' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_interactions_source_external` ON `interactions` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_interactions_project_completed` ON `interactions` (`project_id`,`completed_at`);--> statement-breakpoint
CREATE TABLE `mcp_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text DEFAULT 'work:read,work:write' NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_mcp_tokens_hash` ON `mcp_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`work_item_id` text,
	`source_id` text,
	`interaction_id` text,
	`event_type` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`deep_link` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`requires_action` integer DEFAULT false NOT NULL,
	`read_at` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notifications_user_dedupe` ON `notifications` (`recipient_user_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notifications_user_read` ON `notifications` (`recipient_user_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_organizations_owner` ON `organizations` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`directory` text DEFAULT '' NOT NULL,
	`git_remote` text,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_projects_org_key` ON `projects` (`organization_id`,`project_key`);--> statement-breakpoint
CREATE INDEX `idx_projects_org_updated` ON `projects` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`subscription` text NOT NULL,
	`mode` text DEFAULT 'all_interactions' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_success_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_push_owner_endpoint` ON `push_subscriptions` (`owner_user_id`,`endpoint`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`coding_space_id` text,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`model` text,
	`status` text DEFAULT 'active' NOT NULL,
	`assurance` text DEFAULT 'instructed' NOT NULL,
	`current_task_ids` text DEFAULT '[]' NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coding_space_id`) REFERENCES `coding_spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sources_project_provider_external` ON `sources` (`project_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_sources_project_seen` ON `sources` (`project_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `work_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`source_id` text NOT NULL,
	`mode` text DEFAULT 'exclusive' NOT NULL,
	`lease_expires_at` text NOT NULL,
	`heartbeat_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_claim_item_source` ON `work_claims` (`work_item_id`,`source_id`);--> statement-breakpoint
CREATE TABLE `work_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`project_revision` integer NOT NULL,
	`work_item_id` text,
	`source_id` text,
	`interaction_id` text,
	`actor_name` text NOT NULL,
	`event_type` text NOT NULL,
	`summary` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_events_project_revision` ON `work_events` (`project_id`,`project_revision`);--> statement-breakpoint
CREATE INDEX `idx_events_project_revision` ON `work_events` (`project_id`,`project_revision`);--> statement-breakpoint
CREATE INDEX `idx_events_item_created` ON `work_events` (`work_item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`item_key` text NOT NULL,
	`parent_id` text,
	`type` text DEFAULT 'task' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee` text,
	`source_id` text,
	`coding_space_id` text,
	`completion_confidence` text DEFAULT 'reported' NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`blocker_reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`started_at` text,
	`completed_at` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coding_space_id`) REFERENCES `coding_spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_work_items_project_sequence` ON `work_items` (`project_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_work_items_project_key` ON `work_items` (`project_id`,`item_key`);--> statement-breakpoint
CREATE INDEX `idx_work_items_project_status` ON `work_items` (`project_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_work_items_source` ON `work_items` (`source_id`);