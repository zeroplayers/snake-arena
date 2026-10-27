ALTER TABLE `ratings` ADD `activated_at` integer;--> statement-breakpoint
ALTER TABLE `versions` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `versions_change_seq_idx` ON `versions` (`change_seq`);--> statement-breakpoint
-- Hand-written below (Drizzle doesn't model triggers).
--
-- `ratings.activated_at` names the stint a rating covers. Writers (apps/arena) put in the
-- `versions.activated_at` they computed from; a write for any other stint is ignored (no row
-- inserted or changed, `RETURNING` gives nothing), so a rating computed before a rollback can't
-- bring the deleted row back.
UPDATE `ratings` SET `activated_at` = (SELECT `activated_at` FROM `versions` WHERE `versions`.`id` = `ratings`.`version_id`);--> statement-breakpoint
CREATE TRIGGER `ratings_stint_insert` BEFORE INSERT ON `ratings`
WHEN NEW.`activated_at` IS NOT (SELECT `activated_at` FROM `versions` WHERE `id` = NEW.`version_id`) BEGIN
	SELECT RAISE(IGNORE);
END;--> statement-breakpoint
CREATE TRIGGER `ratings_stint_update` BEFORE UPDATE ON `ratings`
WHEN NEW.`activated_at` IS NOT (SELECT `activated_at` FROM `versions` WHERE `id` = NEW.`version_id`) BEGIN
	SELECT RAISE(IGNORE);
END;--> statement-breakpoint
-- `versions.change_seq`: one more than the largest so far on every insert and status change.
-- D1 runs one write transaction at a time, so a poll `WHERE change_seq > ?` never skips a
-- change. Existing rows are numbered in insertion order.
UPDATE `versions` SET `change_seq` = `rowid`;--> statement-breakpoint
CREATE TRIGGER `versions_change_seq_insert` AFTER INSERT ON `versions` BEGIN
	UPDATE `versions` SET `change_seq` = (SELECT max(`change_seq`) FROM `versions`) + 1 WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `versions_change_seq_status` AFTER UPDATE OF `status` ON `versions` WHEN NEW.`status` IS NOT OLD.`status` BEGIN
	UPDATE `versions` SET `change_seq` = (SELECT max(`change_seq`) FROM `versions`) + 1 WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
-- An archived bot never plays: no writer may make one of its versions `ready`.
CREATE TRIGGER `versions_ready_unarchived` BEFORE UPDATE OF `status` ON `versions`
WHEN NEW.`status` = 'ready' AND (SELECT `archived_at` FROM `bots` WHERE `id` = NEW.`bot_id`) IS NOT NULL BEGIN
	SELECT RAISE(ABORT, 'bot is archived');
END;
