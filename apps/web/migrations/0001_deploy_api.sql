ALTER TABLE `versions` ADD `meta` text;--> statement-breakpoint
ALTER TABLE `versions` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `versions_bot_idempotency_idx` ON `versions` (`bot_id`,`idempotency_key`);