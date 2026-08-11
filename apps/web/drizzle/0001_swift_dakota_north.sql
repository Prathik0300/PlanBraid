CREATE TABLE `data_migrations` (
	`organization_id` text NOT NULL,
	`migration_key` text NOT NULL,
	`applied_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_data_migrations_org_key` ON `data_migrations` (`organization_id`,`migration_key`);
--> statement-breakpoint
PRAGMA optimize;
