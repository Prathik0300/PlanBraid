CREATE TABLE `oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text NOT NULL,
	`family_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `oauth_token_families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_access_hash` ON `oauth_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_family` ON `oauth_access_tokens` (`family_id`);--> statement-breakpoint
CREATE TABLE `oauth_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text NOT NULL,
	`code_challenge` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_codes_hash` ON `oauth_authorization_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_codes_client_expiry` ON `oauth_authorization_codes` (`client_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_authorization_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text NOT NULL,
	`state` text,
	`code_challenge` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_requests_expiry` ON `oauth_authorization_requests` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_secret_hash` text,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`grant_types` text NOT NULL,
	`response_types` text NOT NULL,
	`token_auth_method` text DEFAULT 'none' NOT NULL,
	`client_uri` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_rate_limits` (
	`rate_key` text NOT NULL,
	`window_start` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_rate_window` ON `oauth_rate_limits` (`rate_key`,`window_start`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text NOT NULL,
	`family_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `oauth_token_families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_refresh_hash` ON `oauth_refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_family` ON `oauth_refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE TABLE `oauth_token_families` (
	`id` text PRIMARY KEY NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
