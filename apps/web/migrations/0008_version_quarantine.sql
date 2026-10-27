ALTER TABLE `versions` ADD `quarantined_at` integer;--> statement-breakpoint
ALTER TABLE `versions` ADD `quarantine_reason` text;--> statement-breakpoint
-- Hand-written below (Drizzle doesn't model triggers).
--
-- A quarantine (or lifting one) bumps `versions.change_seq` like a status change, so the
-- matchmaker's incremental poll sees it: the existing trigger now also fires on `quarantined_at`.
DROP TRIGGER `versions_change_seq_status`;--> statement-breakpoint
CREATE TRIGGER `versions_change_seq_status` AFTER UPDATE OF `status`, `quarantined_at` ON `versions`
WHEN NEW.`status` IS NOT OLD.`status` OR NEW.`quarantined_at` IS NOT OLD.`quarantined_at` BEGIN
	UPDATE `versions` SET `change_seq` = (SELECT max(`change_seq`) FROM `versions`) + 1 WHERE `id` = NEW.`id`;
END;
