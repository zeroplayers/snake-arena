CREATE TABLE `version_kills` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`room` text NOT NULL,
	`life_id` text NOT NULL,
	`tick` integer NOT NULL,
	`retracted` integer DEFAULT false NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `version_kills_version_at_idx` ON `version_kills` (`version_id`,`at`);