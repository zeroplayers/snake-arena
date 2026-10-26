CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_idx` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`skin` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bots_owner_slug_idx` ON `bots` (`owner_id`,`slug`);--> statement-breakpoint
CREATE TABLE `cli_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_used_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_tokens_token_hash_unique` ON `cli_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `cli_tokens_user_id_idx` ON `cli_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_code_unique` ON `device_codes` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_unique` ON `device_codes` (`user_code`);--> statement-breakpoint
CREATE TABLE `lives` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`room` text NOT NULL,
	`start_tick` integer NOT NULL,
	`end_tick` integer,
	`score` integer DEFAULT 0 NOT NULL,
	`length_max` integer DEFAULT 0 NOT NULL,
	`kills` integer DEFAULT 0 NOT NULL,
	`death_cause` text,
	`killer` text,
	`replay_key` text,
	`trace_key` text,
	`started_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lives_death_cause_check" CHECK("lives"."death_cause" IN ('collision', 'wall', 'timeout', 'error', 'retired'))
);
--> statement-breakpoint
CREATE INDEX `lives_version_ended_idx` ON `lives` (`version_id`,`ended_at`);--> statement-breakpoint
CREATE INDEX `lives_room_idx` ON `lives` (`room`,`start_tick`);--> statement-breakpoint
CREATE TABLE `ratings` (
	`version_id` text PRIMARY KEY NOT NULL,
	`mean` real NOT NULL,
	`ci` real NOT NULL,
	`n_lives` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ratings_mean_idx` ON `ratings` (`mean`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`username` text,
	`display_username` text,
	`github_login` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`n` integer NOT NULL,
	`status` text DEFAULT 'validating' NOT NULL,
	`bundle_key` text NOT NULL,
	`source_key` text NOT NULL,
	`report` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "versions_status_check" CHECK("versions"."status" IN ('validating', 'ready', 'rejected', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `versions_bot_n_idx` ON `versions` (`bot_id`,`n`);--> statement-breakpoint
CREATE UNIQUE INDEX `versions_bot_ready_idx` ON `versions` (`bot_id`) WHERE status = 'ready';