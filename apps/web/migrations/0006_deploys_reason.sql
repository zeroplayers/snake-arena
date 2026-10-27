ALTER TABLE `arena_control` ADD `deploys_reason` text;--> statement-breakpoint
-- Hand-written: until now `reason` served both switches; paused deploys keep the reason they had.
UPDATE `arena_control` SET `deploys_reason` = `reason` WHERE `deploys_paused` = 1;
