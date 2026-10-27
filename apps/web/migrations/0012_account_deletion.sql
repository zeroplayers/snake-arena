ALTER TABLE `users` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `users_deleted_at_idx` ON `users` (`deleted_at`) WHERE deleted_at IS NOT NULL;