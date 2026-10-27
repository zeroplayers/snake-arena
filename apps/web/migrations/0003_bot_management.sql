CREATE TABLE `activations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`kind` text NOT NULL,
	`version_id` text,
	`previous_version_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`previous_version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "activations_kind_check" CHECK("activations"."kind" IN ('activate', 'deactivate', 'archive_bot'))
);
--> statement-breakpoint
CREATE INDEX `activations_owner_created_idx` ON `activations` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activations_bot_idx` ON `activations` (`bot_id`);--> statement-breakpoint
ALTER TABLE `bots` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `versions` ADD `activated_at` integer;--> statement-breakpoint
-- Versions already active count as activated when they were last updated.
UPDATE `versions` SET `activated_at` = `updated_at` WHERE `status` = 'ready';
