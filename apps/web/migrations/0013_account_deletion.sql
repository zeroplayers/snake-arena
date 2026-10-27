CREATE TABLE `held_usernames` (
	`username_hash` text PRIMARY KEY NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `purge_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `users_deleted_at_idx` ON `users` (`deleted_at`) WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `versions_bundle_key_idx` ON `versions` (`bundle_key`);--> statement-breakpoint
CREATE INDEX `versions_source_key_idx` ON `versions` (`source_key`);