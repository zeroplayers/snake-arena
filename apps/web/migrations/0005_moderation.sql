CREATE TABLE `arena_control` (
	`id` integer PRIMARY KEY NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`deploys_paused` integer DEFAULT false NOT NULL,
	`reason` text,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "arena_control_singleton" CHECK("arena_control"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_id` text NOT NULL,
	`action` text NOT NULL,
	`target_user_id` text,
	`target_bot_id` text,
	`target_version_id` text,
	`reason` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "moderation_actions_action_check" CHECK("moderation_actions"."action" IN ('pause_arena', 'resume_arena', 'pause_deploys', 'resume_deploys', 'ban_user', 'unban_user', 'ban_bot', 'unban_bot', 'ban_version'))
);
--> statement-breakpoint
CREATE INDEX `moderation_actions_created_idx` ON `moderation_actions` (`created_at`);--> statement-breakpoint
ALTER TABLE `bots` ADD `banned_at` integer;--> statement-breakpoint
ALTER TABLE `bots` ADD `ban_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `banned_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `ban_reason` text;--> statement-breakpoint
-- Hand-written below (Drizzle doesn't model triggers or seed rows).
--
-- The kill switch's single row; readers treat a missing row as "running" too.
INSERT INTO `arena_control` (`id`) VALUES (1);--> statement-breakpoint
-- A banned bot, or any bot of a banned user, never plays: no writer may make one of its
-- versions `ready` (like `versions_ready_unarchived`).
CREATE TRIGGER `versions_ready_unbanned` BEFORE UPDATE OF `status` ON `versions`
WHEN NEW.`status` = 'ready' AND EXISTS (
	SELECT 1 FROM `bots` JOIN `users` ON `users`.`id` = `bots`.`owner_id`
	WHERE `bots`.`id` = NEW.`bot_id` AND (`bots`.`banned_at` IS NOT NULL OR `users`.`banned_at` IS NOT NULL)
) BEGIN
	SELECT RAISE(ABORT, 'bot is banned');
END;
